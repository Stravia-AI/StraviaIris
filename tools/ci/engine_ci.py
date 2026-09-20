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
        if self.platform.startswith("linux"):
            # gn_args 仅在 use_sysroot 时才为已装 sysroot 的架构生成配置；
            # arm64 在 ValidateArgs 里还硬性要求它。
            self.build_args["use_sysroot"] = True
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
        if self.pcfg["cpu"] == "arm64":
            # windows-2022 是 x64 宿主交叉编译 arm64；CEF 的 gn_args 仅在
            # arm64 宿主或该开关下才把 Release_GN_arm64 列入支持配置。
            self.env["CEF_ENABLE_ARM64"] = "1"
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

    def head_matches(self, path, want):
        """.git 完好且 HEAD 匹配才返回 True；损坏检出返回 False 而不是抛异常。"""
        if not (path / ".git").exists():
            return False
        try:
            return self.git(path, "rev-parse", "HEAD") == want
        except subprocess.CalledProcessError:
            return False

    def revisions(self):
        for key, path in (("cef", self.cef), ("chromium", self.src),
                          ("depot_tools", self.root / "depot_tools")):
            if not (path / ".git").exists():
                # 生成后分段归档会剔除 src/.git 瘦身；锁定校验在首段已完成。
                print(f"{key}: 无 .git（归档已精简），跳过修订校验")
                continue
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
        depot = self.lock["depot_tools"]
        self.root.mkdir(parents=True, exist_ok=True)
        if not (self.root / "depot_tools/.git").exists():
            self.run(["git", "clone", "--no-checkout", depot["url"], self.root / "depot_tools"])
        self.run(["git", "-C", self.root / "depot_tools", "checkout", "--detach", depot["commit"]])
        if IS_WINDOWS:
            self.bootstrap_windows()
        else:
            # DEPOT_TOOLS_UPDATE=0 下自动引导被跳过；gn 包装器需要
            # ensure_bootstrap 写出的 python3_bin_reldir.txt 等文件。
            # 续跑场景同样要跑（归档里的 depot_tools 可能未引导）。
            self.run(["bash", self.root / "depot_tools/ensure_bootstrap"],
                     cwd=self.root / "depot_tools")
        chromium = self.root / "chromium"
        chromium.mkdir(exist_ok=True)
        gclient = chromium / ".gclient"
        # 无守卫重写：续跑工作区里的旧 .gclient 也要更新到新字段；
        # 提前到 fetched 短路之前，自愈分支的 gclient 调用同样依赖它。
        solution = {"managed": False, "name": "src",
                    "url": self.lock["chromium"]["url"] + "@" + self.lock["chromium"]["commit"],
                    "custom_vars": {"checkout_pgo_profiles": False, "source_tarball": False},
                    "custom_deps": {}, "deps_file": "DEPS", "safesync_url": ""}
        gclient.write_text("solutions = " + repr([solution]) + "\n", encoding="utf-8")
        if self.state.get("fetched"):
            intact = True
            if not self.state.get("generated"):
                # gen 前的工作区必须带完好 .git 供修订校验；被打断的接力
                # 归档会留下残缺检出（.git 存在但 rev-parse 失败），
                # 在半空源码树上编译只会浪费分段，直接清空重拉。
                intact = all(self.head_matches(path, self.lock[key]["commit"])
                             for key, path in (("chromium", self.src), ("cef", self.cef)))
            if intact:
                self.revisions()
                # automate 的 nohistory 续跑路径见 src/ 存在即整体早退：
                # 首段 sync 中断的工作区会被标成 fetched 但 deps 与
                # runhooks（含工具链钩子）都没补跑。重放 sync/runhooks 幂等
                # 补齐，但仅在没打过补丁时安全（gclient 会动 dep 检出）。
                # iris_000 只碰 src 主仓与 src/cef 副本，属安全例外。
                safe_applied = {"iris_000_profile"}
                if (not self.state.get("applied") and not self.state.get("hooks_done")
                        and set(self.state.get("applied_patches") or ()) <= safe_applied):
                    self.patch_deps_gperf()
                    self.run(["gclient.bat" if IS_WINDOWS else "gclient",
                             "sync", "--nohooks", "--no-history"], cwd=chromium)
                    self.run(["gclient.bat" if IS_WINDOWS else "gclient",
                             "runhooks"], cwd=chromium)
                    self.state["hooks_done"] = True
                    save(self.state_path, self.state)
                print("源码已同步且修订匹配；跳过 fetch。")
                return
            print("接力工作区源码残缺；清空 chromium 目录重新同步。", flush=True)
            shutil.rmtree(self.src, ignore_errors=True)
            shutil.rmtree(self.root / "cef", ignore_errors=True)
            for flag in ("fetched", "applied", "applied_patches", "deps_installed",
                         "generated", "built", "packaged", "ninja_targets",
                         "hooks_done"):
                self.state.pop(flag, None)
            save(self.state_path, self.state)
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
        # 被取消的分段会把解压到一半的工作区重新打包接力：src/ 存在但
        # 没有 VERSION 时 automate 的 --no-chromium-history 版本检查直接炸，
        # 且这种归档往往连 .iris-ci.json 都没解出来，上面的完整性检查兜不住。
        if self.src.exists() and not (self.src / "chrome/VERSION").is_file():
            print("chromium/src 不完整（缺 VERSION）；清空后重新同步。", flush=True)
            shutil.rmtree(self.src, ignore_errors=True)
            shutil.rmtree(self.root / "cef", ignore_errors=True)
            for flag in ("fetched", "applied", "applied_patches", "deps_installed",
                         "generated", "built", "packaged", "ninja_targets",
                         "hooks_done"):
                self.state.pop(flag, None)
            save(self.state_path, self.state)
        # 半解包接力归档里根级 cef / src/cef 也可能是残缺检出（.git 缺失
        # 或 HEAD 不符）：automate 会校验根级 cef 并把 src/cef 当作已复制，
        # 提前清掉让它重新克隆/复制。
        for cef_dir in (self.root / "cef", self.cef):
            if cef_dir.exists() and not self.head_matches(cef_dir, self.lock["cef"]["commit"]):
                print(f"cef 检出损坏或修订不符，清除：{cef_dir}", flush=True)
                shutil.rmtree(cef_dir, ignore_errors=True)
        self.patch_deps_gperf()
        try:
            self.run([sys.executable, automate, *args])
        except subprocess.CalledProcessError:
            # automate 的 nohistory 续跑路径见 src/ 存在即整体早退：sync
            # 中断后直接重跑 automate 不会续同步也不跑 runhooks。DEPS 已
            # 检出就手动补完 sync（gperf cipd 缺 arm64 包只是中断形态之
            # 一），再交 automate 做 cef 复制等收尾，最后补跑 runhooks。
            if not (self.src / "DEPS").is_file():
                raise
            self.patch_deps_gperf()
            self.run(["gclient.bat" if IS_WINDOWS else "gclient",
                             "sync", "--nohooks", "--no-history"], cwd=chromium)
            self.run([sys.executable, automate, *args])
            self.run(["gclient.bat" if IS_WINDOWS else "gclient",
                             "runhooks"], cwd=chromium)
        self.revisions()
        self.save_state("apply", fetched=True, hooks_done=True)

    def patch_deps_gperf(self):
        """cipd 没有 gperf/linux-arm64 包，而 gclient 对 cipd dep 硬编码
        custom_deps=None（.gclient 无法跳过）。把该 dep 的条件收窄为
        排除 arm64 宿主；Linux 构建使用系统 gperf（deps 阶段已装）。
        managed=False 的 .gclient 下本地 DEPS 修改不会被 sync 回滚。"""
        if self.platform != "linux-arm64":
            return
        deps = self.src / "DEPS"
        if not deps.is_file():
            return
        text = deps.read_text(encoding="utf-8")
        marker = "'src/third_party/gperf/cipd': {"
        start = text.find(marker)
        if start < 0:
            return
        end = text.find("\n  '", start + len(marker))
        block = text[start:end if end > 0 else len(text)]
        if 'host_cpu != "arm64"' in block:
            return  # 已收窄过（幂等：自愈/重试路径会重复调用）
        patched = block.replace(
            "'condition': 'host_os == \"linux\" and non_git_source'",
            "'condition': 'host_os == \"linux\" and host_cpu != \"arm64\" and non_git_source'")
        require(patched != block, "DEPS gperf dep 条件与预期不符")
        deps.write_text(text[:start] + patched + text[end if end > 0 else len(text):],
                        encoding="utf-8")
        print("已收窄 gperf cipd dep 条件，排除 arm64 宿主", flush=True)

    # ------------------------------------------------------------------
    # 阶段：deps —— Linux 宿主编译依赖（fetch 之后才有脚本本体）
    # ------------------------------------------------------------------
    def deps(self):
        if IS_WINDOWS or self.state.get("deps_installed"):
            return
        script = self.src / "build/install-build-deps.sh"
        if script.is_file():
            args = ["sudo", "DEBIAN_FRONTEND=noninteractive", "bash", str(script),
                    "--no-prompt", "--no-arm", "--no-chromeos-fonts"]
            print("+ " + subprocess.list2cmdline(args), flush=True)
            result = subprocess.run(args, cwd=self.src, env=self.env)
            if result.returncode:
                # 上游脚本对个别可选包失败属常态；编译会暴露真实缺失。
                print(f"::warning::install-build-deps 退出码 {result.returncode}，继续", flush=True)
        self.state["deps_installed"] = True
        save(self.state_path, self.state)

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
        for relative, path in {
            "profiles/windows-desktop.json": PROJECT / "profiles/windows-desktop.json",
            "native/src/engine_protocol.h": PROJECT / "native/src/engine_protocol.h",
        }.items():
            require(path.is_file() and digest(path) == self.lock["inputs"][relative],
                    f"构建输入与锁定摘要不符：{relative}")
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

    def _cfg_append(self, cfg, name):
        """向 patch.cfg 的 patches 列表末尾追加条目（续跑时旧 cfg 缺新补丁）。"""
        text = cfg.read_text(encoding="utf-8")
        tree = ast.parse(text)
        for node in tree.body:
            if isinstance(node, ast.Assign) and any(
                    isinstance(t, ast.Name) and t.id == "patches" for t in node.targets):
                lines = text.splitlines(keepends=True)
                idx = node.end_lineno - 1  # ']' 所在行（1 基）
                prev = idx - 1
                while prev >= 0 and not lines[prev].strip():
                    prev -= 1
                if prev >= 0 and not lines[prev].rstrip("\n").rstrip().endswith(","):
                    lines[prev] = lines[prev].rstrip("\n") + ",\n"
                lines.insert(idx, f"  {{ 'name': '{name}' }},\n")
                cfg.write_text("".join(lines), encoding="utf-8")
                return
        raise EngineError("patch.cfg 缺少 patches 赋值")

    def apply(self):
        paths, hashes = self.queue()
        if self.state.get("applied") and self.state.get("patches") == hashes:
            print("补丁已应用且集合未变；跳过 apply。")
            return
        destination = self.cef / "patch/patches"
        for source in paths:
            target = destination / source.name
            if not target.exists() or digest(target) != digest(source):
                shutil.copyfile(source, target)
        cfg = self.cef / "patch/patch.cfg"
        existing = [entry["name"] for entry in literal_assignment(cfg, "patches")]
        if existing[-len(NAMES):] != list(NAMES):
            if not any(name in existing for name in NAMES):
                # 全新队列：注册补丁一次性写入全部条目。
                registration = self.run(
                    [sys.executable, self.cef / "tools/patcher.py",
                     "--patch-file", paths[0].stem, "--patch-dir", self.cef],
                    cwd=self.cef, capture=True)
                print(registration)
                require("... successfully applied" in registration
                        or "already applied" in registration.lower(),
                        "注册补丁未实际应用")
                existing = [entry["name"] for entry in literal_assignment(cfg, "patches")]
            # 续跑漂移：旧 patch.cfg 缺新增补丁条目 → 程序化补齐到队尾。
            for name in NAMES:
                if name not in existing:
                    self._cfg_append(cfg, name)
            existing = [entry["name"] for entry in literal_assignment(cfg, "patches")]
        require(existing[-len(NAMES):] == list(NAMES), "自有补丁必须位于 CEF 队列末尾")
        # automate --no-build 不跑 gclient_hook.py，上游补丁同样由这里应用。
        # patcher 的 --reverse --check "已应用" 探测对上下文被后续补丁改动
        # 的条目不可靠（正反向均 fail，如 embedder_product_override 与
        # iris_010 重叠），所以以 applied_patches 清单为准：每个条目只跑
        # 未记录的，成功即落盘，中断续跑从断点继续。
        patches = literal_assignment(cfg, "patches")
        applied = self.state.get("applied_patches")
        if applied is None:
            # 旧格式工作区：applied 为真表示整条队列曾跑完，上游条目全部
            # 迁移为已应用，iris 补丁按旧 state.patches 记录迁移。
            applied = ([e["name"] for e in patches if e["name"] not in NAMES]
                       + [n for n in NAMES
                          if f"patches/chromium/{n}.patch" in (self.state.get("patches") or {})]
                       if self.state.get("applied") else [])
            self.state["applied_patches"] = applied
        done = set(applied)
        for entry in patches:
            name = entry["name"]
            if name in done:
                continue
            if "condition" in entry and entry["condition"] not in self.env:
                # 与 patcher 配置模式一致：环境变量未设置则跳过并记录。
                applied.append(name)
                self.state["applied_patches"] = applied
                save(self.state_path, self.state)
                continue
            target_root = (self.src / entry.get("path", "")).resolve()
            require(target_root.is_relative_to(self.src), "补丁目标越过源码目录")
            try:
                output = self.run([sys.executable, self.cef / "tools/patcher.py",
                                   "--patch-file", name, "--patch-dir", target_root],
                                  cwd=self.cef, capture=True)
            except subprocess.CalledProcessError as error:
                # capture=True 时 patcher 的失败详情在 e.stdout，不打出来没法定位。
                print(error.stdout or "", flush=True)
                raise
            print(output)
            applied.append(name)
            self.state["applied_patches"] = applied
            save(self.state_path, self.state)
        missing = [e["name"] for e in patches if e["name"] not in applied]
        require(not missing, f"补丁队列未全部就位：{missing}")
        build_id = self.prepare_inputs()
        self.save_state("gen", applied=True, patches=hashes, engine_build_id=build_id)

    # ------------------------------------------------------------------
    # 阶段：gen —— GN 生成（复用 CEF 上游生成器）
    # ------------------------------------------------------------------
    def ensure_sysroot(self):
        if IS_WINDOWS:
            return
        arch = {"x64": "amd64", "arm": "armhf", "arm64": "arm64"}[self.pcfg["cpu"]]
        base = self.src / "build/linux"
        if any(base.glob(f"debian_*_{arch}-sysroot")):
            return
        # use_sysroot=true（CEF linux 默认）时 gn_args 只承认已安装 sysroot
        # 的架构；宿主编译一般已装宿主 arch，缺了就在这里补齐。
        script = base / "sysroot_scripts/install-sysroot.py"
        require(script.is_file(), "缺少 install-sysroot.py")
        self.run([sys.executable, script, f"--arch={arch}"])
        require(any(base.glob(f"debian_*_{arch}-sysroot")),
                f"sysroot 未安装：{arch}")

    def gen(self):
        if self.state.get("generated"):
            print("GN 项目已生成；跳过 gen。")
            return
        self.ensure_sysroot()
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
        if self.state.get("error"):
            # error 只记录上一段的失败现场；接力 run 总是携带最新代码，
            # 已修复的问题不应被旧标记永久锁死，重试仍失败会重新写入。
            print(f"清除上次失败标记后重试：{self.state['error']}", flush=True)
            self.state.pop("error")
            save(self.state_path, self.state)
        deadline = time.time() + segment_seconds if segment_seconds else self.deadline()
        # 各阶段幂等：已完成阶段自查标记跳过，逐段推进到下一个未完成阶段。
        self.fetch()
        self.deps()
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
