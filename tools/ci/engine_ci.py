"""CI 分段接力构建驱动：在 GitHub Actions 上产出打补丁 CEF 标准分发。

与 tools/engine.py 的关系：读取同一 engine.lock.json、同一补丁队列与同一
build ID 算法；不复用其交互式状态机。本地驱动面向可信环境做防呆校验，
本驱动面向一次性 runner：工作目录经压缩包在分段 job / 跨 run 间接力，
所有阶段幂等，进度记录在 <root>/.iris-ci.json。

分段语义：IRIS_SEGMENT_END（Unix 秒）是本次分段的硬截止时间。build 阶段
在到达该时间时杀死编译进程树并按"未完成"退出（exit 75），由外层负责
打包工作区交给下一段。其余阶段完成后立即落盘状态，中断重跑安全。
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import (EngineError, PROJECT, LOCK, NAMES, digest, load, save,
                    require, command, literal_assignment)

IS_WINDOWS = os.name == "nt"
INCOMPLETE = 75  # EX_TEMPFAIL：分段预算耗尽，工作区已保存，可继续

PLATFORMS = {
    "windows-x64":   {"cpu": "x64",   "automate": "--x64-build",   "lib": "libcef.dll", "exe": ".exe"},
    "windows-arm64": {"cpu": "arm64", "automate": "--arm64-build", "lib": "libcef.dll", "exe": ".exe"},
    "linux-x64":     {"cpu": "x64",   "automate": "--x64-build",   "lib": "libcef.so",  "exe": ""},
    "linux-arm64":   {"cpu": "arm64", "automate": "--arm64-build", "lib": "libcef.so",  "exe": ""},
}

# 只要求引擎本体与冒烟入口；bootstrap* 在部分平台可能不产生，仅记录。
REQUIRED_OUTPUTS = ("libcef", "cefsimple")


class CI:
    def __init__(self, root, platform):
        require(platform in PLATFORMS, f"未知平台：{platform}")
        self.platform = platform
        self.pcfg = PLATFORMS[platform]
        self.config = f"Release_GN_{self.pcfg['cpu']}"
        self.root = root.resolve()
        self.lock = load(LOCK)
        require(self.lock["schema_version"] == 1, "不支持的锁文件版本")
        self.build_args = dict(self.lock["build"])
        self.build_args["target_cpu"] = self.pcfg["cpu"]
        self.src = self.root / "chromium/src"
        self.cef = self.src / "cef"
        self.out = self.src / "out" / self.config
        self.dist = self.root / "distribution"
        self.pkg_dir = self.root / "package"
        self.state_path = self.root / ".iris-ci.json"
        self.state = load(self.state_path) if self.state_path.is_file() else {"phase": "start"}
        self.env = os.environ.copy()
        self.configure_environment()

    # ------------------------------------------------------------------
    # 环境 / 状态
    # ------------------------------------------------------------------
    def configure_environment(self):
        self.env.update(DEPOT_TOOLS_UPDATE="0", PYTHONUTF8="1",
                        DEPOT_TOOLS_METRICS="0", CIPD_CACHE_ENABLED="0")
        if IS_WINDOWS:
            self.env["DEPOT_TOOLS_WIN_TOOLCHAIN"] = "0"
        self.env["PATH"] = str(self.root / "depot_tools") + os.pathsep + self.env.get("PATH", "")
        self.env["GN_DEFINES"] = " ".join(
            f"{name}={json.dumps(value)}" for name, value in self.build_args.items())
        self.env["GN_OUT_CONFIGS"] = self.config
        self.env.pop("GN_ARGUMENTS", None)
        count = int(self.env.get("GIT_CONFIG_COUNT", "0"))
        for key, value in (("core.autocrlf", "false"), ("core.longpaths", "true")):
            self.env[f"GIT_CONFIG_KEY_{count}"] = key
            self.env[f"GIT_CONFIG_VALUE_{count}"] = value
            count += 1
        self.env["GIT_CONFIG_COUNT"] = str(count)

    def save_state(self, phase, **extra):
        self.state.update(phase=phase, platform=self.platform,
                          updated=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **extra)
        save(self.state_path, self.state)
        print(f"[state] {json.dumps(self.state, ensure_ascii=False)}", flush=True)

    def run(self, args, cwd=None, capture=False):
        return command(args, cwd or self.root, self.env, capture)

    def git(self, path, *args):
        return self.run(["git", "-C", path, *args], capture=True).strip()

    def identity(self):
        return {key: self.lock[key]["commit"] for key in ("cef", "chromium", "depot_tools")}

    def revisions(self):
        for key, path in (("cef", self.cef), ("chromium", self.src),
                          ("depot_tools", self.root / "depot_tools")):
            require(self.git(path, "rev-parse", "HEAD") == self.lock[key]["commit"],
                    f"{key} revision 不匹配")

    def engine_build_id(self):
        # 与 engine.py 同一算法；build 段含本平台 target_cpu，各平台 ID 天然不同。
        payload = {"schema_version": 1, "identity": self.identity(),
                   "build": self.build_args,
                   "patches": self.lock["patches"], "inputs": self.lock["inputs"]}
        encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    def deadline(self):
        raw = self.env.get("IRIS_SEGMENT_END", "")
        return int(raw) if raw.isdigit() else None

    # ------------------------------------------------------------------
    # 阶段：fetch —— depot_tools + automate-git 同步锁定源码
    # ------------------------------------------------------------------
    def bootstrap_windows(self):
        bootstrap_env = self.env.copy()
        bootstrap_env["GIT_CONFIG_GLOBAL"] = os.devnull
        executable = shutil.which("git.exe", path=self.env["PATH"])
        require(executable, "Windows 引导需要已安装的 git.exe")
        git_executable = Path(executable).resolve()
        git_root = git_executable.parent.parent
        if git_executable.parent.name.lower() == "cmd" and git_root.name.lower() != "git":
            require((git_root / "bin/bash.exe").is_file(), "Git for Windows 安装布局不完整")
            junction = self.root / "Git"
            if not junction.exists():
                self.run([os.environ.get("COMSPEC", "cmd.exe"), "/d", "/c",
                          "mklink", "/J", junction, git_root])
            require(junction.resolve() == git_root, "工具目录中的 Git junction 指向其他安装")
            bootstrap_env["PATH"] = str(junction / "cmd") + os.pathsep + bootstrap_env["PATH"]
        command([self.root / "depot_tools/bootstrap/win_tools.bat"], self.root, bootstrap_env)
        require((self.root / "depot_tools/git.bat").is_file(), "官方 Windows 引导未生成 git.bat")
        self.run([self.root / "depot_tools/vpython3.bat",
                  self.root / "depot_tools/gsutil.py", "version"])

    def fetch(self):
        if self.state.get("fetched"):
            self.revisions()
            print("源码已同步且修订匹配；跳过 fetch。")
            return
        depot = self.lock["depot_tools"]
        self.root.mkdir(parents=True, exist_ok=True)
        if not (self.root / "depot_tools/.git").exists():
            self.run(["git", "clone", "--no-checkout", depot["url"], self.root / "depot_tools"])
        self.run(["git", "-C", self.root / "depot_tools", "checkout", "--detach", depot["commit"]])
        if IS_WINDOWS:
            self.bootstrap_windows()
        url = f"https://raw.githubusercontent.com/chromiumembedded/cef/{self.lock['cef']['commit']}/tools/automate/automate-git.py"
        automate = self.root / "automate-git.py"
        if not automate.is_file() or digest(automate) != self.lock["automate"]["sha256"]:
            with urllib.request.urlopen(url, timeout=60) as response:
                data = response.read()
            require(hashlib.sha256(data).hexdigest() == self.lock["automate"]["sha256"],
                    "automate 下载摘要与锁不符")
            automate.write_bytes(data)
        args = [f"--download-dir={self.root}", f"--depot-tools-dir={self.root / 'depot_tools'}",
                f"--branch={self.lock['cef']['branch']}", f"--checkout={self.lock['cef']['commit']}",
                f"--chromium-checkout={self.lock['chromium']['tag']}", self.pcfg["automate"],
                "--no-build", "--no-distrib", "--no-depot-tools-update", "--no-chromium-history"]
        help_text = self.run([sys.executable, automate, "--help"], capture=True)
        missing = [arg for arg in args if arg.split("=")[0] not in help_text]
        require(not missing, f"固定 automate 参数不兼容：{missing}")
        chromium = self.root / "chromium"
        chromium.mkdir(exist_ok=True)
        gclient = chromium / ".gclient"
        if not gclient.is_file():
            solution = {"managed": False, "name": "src",
                        "url": self.lock["chromium"]["url"] + "@" + self.lock["chromium"]["commit"],
                        "custom_vars": {"checkout_pgo_profiles": False, "source_tarball": False},
                        "custom_deps": {}, "deps_file": "DEPS", "safesync_url": ""}
            gclient.write_text("solutions = " + repr([solution]) + "\n", encoding="utf-8")
        self.run([sys.executable, automate, *args])
        self.revisions()
        self.save_state("apply", fetched=True)

    # ------------------------------------------------------------------
    # 阶段：apply —— 注册并按序应用补丁队列 + 注入 profile/协议输入
    # ------------------------------------------------------------------
    def queue(self):
        paths = [PROJECT / "patches/cef/0001-register-iris.patch"]
        paths += [PROJECT / "patches/chromium" / (name + ".patch") for name in NAMES]
        for path in paths:
            require(path.is_file() and path.stat().st_size, f"缺少真实补丁：{path}")
        hashes = {p.relative_to(PROJECT).as_posix(): digest(p) for p in paths}
        require(hashes == self.lock.get("patches"), "补丁输入与锁定摘要不符")
        return paths, hashes

    def prepare_inputs(self):
        build_id = self.engine_build_id()
        copies = {
            "components/iris/profile.json": PROJECT / "profiles/windows-desktop.json",
            "components/iris/engine_protocol.h": PROJECT / "native/src/engine_protocol.h",
            "components/iris/engine.lock.json": LOCK,
        }
        for relative, source in copies.items():
            target = self.src / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        (self.src / "components/iris/engine_build_id.txt").write_text(
            build_id + "\n", encoding="ascii")
        return build_id

    def apply(self):
        if self.state.get("applied"):
            print("补丁已应用；跳过 apply。")
            return
        paths, hashes = self.queue()
        destination = self.cef / "patch/patches"
        for source in paths:
            target = destination / source.name
            if not target.exists():
                shutil.copyfile(source, target)
        registration = self.run([sys.executable, self.cef / "tools/patcher.py",
                                 "--patch-file", paths[0].stem, "--patch-dir", self.cef],
                                cwd=self.cef, capture=True)
        print(registration)
        require("... successfully applied" in registration or "already applied" in registration.lower(),
                "注册补丁未实际应用")
        patches = literal_assignment(self.cef / "patch/patch.cfg", "patches")
        names = [patch["name"] for patch in patches]
        require(names[-len(NAMES):] == list(NAMES), "自有补丁必须位于 CEF 队列末尾")
        for entry in patches:
            if entry.get("condition") and entry["condition"] not in self.env:
                continue
            name = entry["name"]
            target_root = (self.src / entry.get("path", "")).resolve()
            require(target_root.is_relative_to(self.src), "补丁目标越过源码目录")
            output = self.run([sys.executable, self.cef / "tools/patcher.py",
                               "--patch-file", name, "--patch-dir", target_root],
                              cwd=self.cef, capture=True)
            if name in NAMES:
                print(output)
                # 分段中断后重跑时补丁可能已就位；两种情况都视为已应用。
                require("... successfully applied" in output or "already applied" in output.lower(),
                        f"自有补丁未实际应用：{name}")
        build_id = self.prepare_inputs()
        self.save_state("gen", applied=True, patches=hashes, engine_build_id=build_id)

    # ------------------------------------------------------------------
    # 阶段：gen —— GN 生成（复用 CEF 上游生成器）
    # ------------------------------------------------------------------
    def gen(self):
        if self.state.get("generated"):
            print("GN 项目已生成；跳过 gen。")
            return
        self.run([sys.executable, PROJECT / "tools/engine_projects.py",
                  "--cef", self.cef, "--configuration", self.config], cwd=self.cef)
        require((self.out / "args.gn").is_file(), "GN 未产出 args.gn")
        self.save_state("build", generated=True, args_sha256=digest(self.out / "args.gn"))

    # ------------------------------------------------------------------
    # 阶段：build —— 带硬截止的增量编译，支持分段续跑
    # ------------------------------------------------------------------
    def run_deadline(self, args, cwd, deadline):
        """带硬截止运行；到达 deadline 杀死整棵进程树并返回 'deadline'。"""
        self.env.setdefault("NINJA_STATUS", "[%f/%t %es] ")
        print("+ " + subprocess.list2cmdline([str(a) for a in args]), flush=True)
        kwargs = {}
        if IS_WINDOWS:
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            kwargs["start_new_session"] = True
        proc = subprocess.Popen([str(a) for a in args], cwd=cwd, env=self.env, **kwargs)
        while True:
            code = proc.poll()
            if code is not None:
                return code
            if deadline and time.time() >= deadline:
                print("分段预算耗尽，终止编译进程树并保存现场。", flush=True)
                try:
                    if IS_WINDOWS:
                        subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                                       capture_output=True)
                    else:
                        os.killpg(proc.pid, signal.SIGKILL)
                except OSError:
                    pass
                proc.wait()
                return "deadline"
            time.sleep(15)

    def build_targets(self):
        # bootstrap* 在部分平台可能不存在；从生成的 build.ninja 探测真实目标，
        # 避免整段编译以 unknown target 失败收场。
        available = set()
        ninja_file = self.out / "build.ninja"
        if ninja_file.is_file():
            with ninja_file.open(encoding="utf-8", errors="replace") as stream:
                for line in stream:
                    if line.startswith("build "):
                        name = line[6:].split(":", 1)[0].strip()
                        if name in self.lock["build_targets"]:
                            available.add(name)
        targets = [t for t in self.lock["build_targets"] if t in available]
        if "libcef" not in targets:
            targets.insert(0, "libcef")
        return targets

    def build(self, deadline):
        ninja_cmd = "autoninja.bat" if IS_WINDOWS else "autoninja"
        targets = self.state.get("ninja_targets") or self.build_targets()
        self.state["ninja_targets"] = targets
        code = self.run_deadline([self.root / "depot_tools" / ninja_cmd,
                                  "-C", f"out/{self.config}", *targets],
                                 cwd=self.src, deadline=deadline)
        if code == "deadline":
            self.save_state("build", last_result="deadline")
            return False
        require(code == 0, f"编译失败：exit={code}（完整日志见运行工件）")
        lib = self.out / self.pcfg["lib"]
        simple = self.out / ("cefsimple" + self.pcfg["exe"])
        require(lib.is_file(), f"构建缺少产物：{lib}")
        require(simple.is_file(), f"构建缺少产物：{simple}")
        binaries = {}
        for pattern in (self.pcfg["lib"], "cefsimple" + self.pcfg["exe"],
                        "bootstrap" + self.pcfg["exe"], "bootstrapc" + self.pcfg["exe"]):
            path = self.out / pattern
            if path.is_file():
                binaries[pattern] = digest(path)
        self.save_state("distrib", built=True, binaries=binaries)
        return True

    # ------------------------------------------------------------------
    # 阶段：distrib —— 上游 make_distrib + iris 清单与 profile 头
    # ------------------------------------------------------------------
    def distribute(self):
        output = self.dist
        if output.exists():
            shutil.rmtree(output)
        output.mkdir(parents=True)
        self.run([sys.executable, self.cef / "tools/make_distrib.py",
                  f"--output-dir={output}", "--ninja-build", self.pcfg["automate"],
                  "--allow-partial", "--no-symbols", "--no-docs", "--no-archive", "--no-format"],
                 cwd=self.cef)
        pattern = f"*/Release/{self.pcfg['lib']}"
        libs = list(output.glob(pattern))
        require(len(libs) == 1, f"上游分发未产生唯一 Release/{self.pcfg['lib']}")
        package_root = libs[0].parent.parent
        for source in package_root.iterdir():
            target = output / source.name
            require(not target.exists(), f"上游分发文件名称冲突：{target}")
            shutil.move(source, target)
        package_root.rmdir()
        marker = {"schema_version": 1, "identity": self.identity(),
                  "build": self.build_args, "targets": self.lock["build_targets"],
                  "engine_build_id": self.engine_build_id(),
                  "inputs": self.lock["inputs"].copy()}
        header = self.out / "gen/components/iris/profile_data.h"
        require(header.is_file(), "没有真实生成的 profile 头文件")
        shutil.copyfile(header, output / "include/iris_profile_data.h")
        files = {p.relative_to(output).as_posix(): digest(p)
                 for p in output.rglob("*") if p.is_file()}
        marker["files"] = files
        save(output / "iris-distribution.json", marker)
        return output

    # ------------------------------------------------------------------
    # 阶段：package —— 归档分发目录 + 校验和 + 构建信息
    # ------------------------------------------------------------------
    def package(self):
        self.pkg_dir.mkdir(parents=True, exist_ok=True)
        tag_version = self.lock["chromium"]["tag"].rsplit("/", 1)[-1]
        base = f"stravia-iris-cef-{tag_version}-{self.platform}"
        if IS_WINDOWS:
            import zipfile
            archive = self.pkg_dir / (base + ".zip")
            with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED,
                               compresslevel=6, allowZip64=True) as bundle:
                for source in sorted(self.dist.rglob("*")):
                    if source.is_file():
                        bundle.write(source, source.relative_to(self.dist).as_posix())
        else:
            archive = self.pkg_dir / (base + ".tar.xz")
            self.run(["tar", "-I", "xz -T0 -3", "-cf", archive, "-C", self.dist, "."])
        sha = digest(archive)
        (self.pkg_dir / (archive.name + ".sha256")).write_text(
            f"{sha}  {archive.name}\n", encoding="ascii")
        info = {"schema_version": 1, "platform": self.platform,
                "engine_build_id": self.engine_build_id(),
                "identity": self.identity(), "build": self.build_args,
                "archive": archive.name, "sha256": sha, "bytes": archive.stat().st_size}
        save(self.pkg_dir / f"build-info-{self.platform}.json", info)
        self.save_state("done", package=str(archive), archive=archive.name,
                        sha256=sha)
        return archive

    # ------------------------------------------------------------------
    # 编排
    # ------------------------------------------------------------------
    def run_pipeline(self, segment_seconds):
        require(not self.state.get("error"), f"上次分段硬失败：{self.state.get('error')}")
        deadline = time.time() + segment_seconds if segment_seconds else self.deadline()
        # 各阶段幂等：已完成阶段自查标记跳过，逐段推进到下一个未完成阶段。
        self.fetch()
        self.apply()
        self.gen()
        if not self.state.get("built"):
            if deadline and time.time() >= deadline:
                print("本段时间不足以继续编译；直接交接。", flush=True)
                return INCOMPLETE
            if not self.build(deadline):
                return INCOMPLETE
        if not self.state.get("packaged"):
            self.distribute()
            self.package()
            self.state["packaged"] = True
            save(self.state_path, self.state)
        return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True,
                        help="引擎工作区根目录（分段间通过压缩包接力，路径必须逐段一致）")
    parser.add_argument("--platform", choices=sorted(PLATFORMS), required=True)
    parser.add_argument("--segment-seconds", type=int, default=0,
                        help="本段允许的秒数；0 表示仅看 IRIS_SEGMENT_END 环境变量")
    args = parser.parse_args()
    try:
        return CI(args.root, args.platform).run_pipeline(args.segment_seconds)
    except EngineError as error:
        root = Path(args.root).resolve()
        state_path = root / ".iris-ci.json"
        state = load(state_path) if state_path.is_file() else {}
        state["error"] = str(error)
        save(state_path, state)
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
