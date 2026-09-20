"""锁定 CEF 构建驱动；仅修改本工具认领的独立源码目录。"""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import urllib.request
import uuid

import engine_patches

PROJECT = Path(__file__).resolve().parents[1]
LOCK = PROJECT / "engine.lock.json"
NAMES = (
    "iris_000_profile", "iris_010_identity", "iris_020_canvas", "iris_030_gpu",
    "iris_040_audio", "iris_050_fonts", "iris_060_screen_timezone_webrtc",
    "iris_070_engine_identity", "iris_080_linux_build",
)
CONFIG = "Release_GN_x64"


class EngineError(RuntimeError):
    pass


def require(ok, message):
    if not ok:
        raise EngineError(message)


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def save(path, value):
    # 原子替换，异常中断不能留下半个成功状态。
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def command(args, cwd, env, capture=False):
    args = [str(arg) for arg in args]
    print("+ " + subprocess.list2cmdline(args), flush=True)
    if os.name == "nt" and args[0].lower().endswith((".bat", ".cmd")):
        args = [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/s", "/c", subprocess.list2cmdline(args)]
    result = subprocess.run(args, cwd=cwd, env=env, check=True,
                            stdout=subprocess.PIPE if capture else None,
                            encoding="utf-8", errors="strict")
    return result.stdout if capture else ""


def literal_assignment(path, name):
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
            return ast.literal_eval(node.value)
    raise EngineError(f"{path} 缺少 {name}")


class Engine:
    def __init__(self, root):
        self.root = root.resolve()
        self.lock = load(LOCK)
        require(self.lock["schema_version"] == 1, "不支持的锁文件版本")
        require(self.lock["build"] == {"target_cpu": "x64", "is_debug": False,
                "is_official_build": True, "is_component_build": False,
                "chrome_pgo_phase": 0, "proprietary_codecs": True,
                "ffmpeg_branding": "Chrome", "symbol_level": 0,
                # safe_browsing_mode=1 / screen_ai=true 是上游桌面默认；
                # //chrome 全图有文件级断言硬性依赖（reset_password 断言
                # safe_browsing_mode==1，screen_ai/pdf 等 8 处断言服务开关），
                # 关闭无法通过 gn gen。运行时是否启用由 prefs/补丁层决定。
                "safe_browsing_mode": 1,
                "enable_mdns": False, "enable_captive_portal_detection": False,
                "enable_supervised_users": True,
                "enable_screen_ai_service": True,
                "include_transport_security_state_preload_list": False},
                "锁文件构建参数不符合此基线")
        require(self.lock["build_targets"] == ["libcef", "bootstrap", "bootstrapc", "cefsimple"],
                "锁文件必须指定完整的运行产物目标，不能用 cef 测试聚合目标替代")
        for key in ("cef", "chromium"):
            require(re.fullmatch(r"[0-9a-f]{40}", self.lock[key]["commit"]), f"{key} 必须锁定完整 SHA")
        self.state_path = self.root / ".iris-engine.json"
        self.state = load(self.state_path) if self.state_path.is_file() else None
        self.src = self.root / "chromium/src"
        self.cef = self.src / "cef"
        self.env = os.environ.copy()
        self.configure_environment()

    def configure_environment(self):
        # 上游生成器使用默认文本编码；固定 UTF-8，避免中文 Windows 的旧 GBK 产物
        # 在后续增量生成时被按 UTF-8 读取而失败。
        self.env.update(DEPOT_TOOLS_WIN_TOOLCHAIN="0", DEPOT_TOOLS_UPDATE="0", PYTHONUTF8="1")
        self.env["PATH"] = str(self.root / "depot_tools") + os.pathsep + self.env.get("PATH", "")
        self.env["GN_DEFINES"] = " ".join(
            f"{name}={json.dumps(value)}" for name, value in self.lock["build"].items())
        self.env["GN_OUT_CONFIGS"] = CONFIG
        self.env.pop("GN_ARGUMENTS", None)
        count = int(self.env.get("GIT_CONFIG_COUNT", "0"))
        require(count >= 0, "GIT_CONFIG_COUNT 无效")
        for key, value in (("core.autocrlf", "false"), ("core.longpaths", "true")):
            self.env[f"GIT_CONFIG_KEY_{count}"] = key
            self.env[f"GIT_CONFIG_VALUE_{count}"] = value
            count += 1
        self.env["GIT_CONFIG_COUNT"] = str(count)

    def doctor(self):
        # 仅在 Windows 构建机上可用；延迟导入以便 CI 在 Linux 上复用本模块的
        # 纯工具函数（engine_doctor 顶层依赖 ctypes.wintypes）。
        from engine_doctor import diagnose
        result = diagnose(self.root, self.lock["requirements"])
        for check in result["checks"]:
            print(f"{'OK' if check['ok'] else 'FAIL'} {check['name']}: {check['detail']}")
        require(result["ok"], "构建前提未满足；未下载或构建")
        self.env = result["environment"]
        self.configure_environment()

    def run(self, args, cwd=None, capture=False):
        return command(args, cwd or self.root, self.env, capture)

    def bootstrap_windows(self):
        # 固定 depot_tools 后仍须生成官方 git.bat/python3.bat；自动更新关闭会跳过此步骤。
        # bootstrap 可按全局授权改写 Git 配置，因此仅对这次引导隔离全局配置。
        bootstrap_env = self.env.copy()
        bootstrap_env["GIT_CONFIG_GLOBAL"] = os.devnull
        executable = shutil.which("git.exe", path=self.env["PATH"])
        require(executable, "Windows 引导需要已安装的 git.exe")
        git_executable = Path(executable).resolve()
        git_root = git_executable.parent.parent
        if git_executable.parent.name.lower() == "cmd" and git_root.name.lower() != "git":
            # 上游只按名为 Git 的父目录识别安装；Scoop 的 git/<version>/cmd 不符合此布局。
            # 本工具目录内建立 junction，仍运行原安装，既不复制 Git，也不修改上游脚本。
            require((git_root / "bin/bash.exe").is_file(), "Git for Windows 安装布局不完整")
            junction = self.root / "Git"
            if not junction.exists():
                self.run([os.environ.get("COMSPEC", "cmd.exe"), "/d", "/c",
                          "mklink", "/J", junction, git_root])
            require(junction.resolve() == git_root, "工具目录中的 Git junction 指向其他安装")
            bootstrap_env["PATH"] = str(junction / "cmd") + os.pathsep + bootstrap_env["PATH"]
        command([self.root / "depot_tools/bootstrap/win_tools.bat"],
                self.root, bootstrap_env)
        require((self.root / "depot_tools/git.bat").is_file(),
                "官方 Windows 引导未生成 git.bat")
        # 在并行 DEPS 下载前完成 gsutil 首次安装，避免多个任务争用安装锁并超时。
        self.run([self.root / "depot_tools/vpython3.bat",
                  self.root / "depot_tools/gsutil.py", "version"])

    def git(self, path, *args):
        return self.run(["git", "-C", path, *args], capture=True).strip()

    def identity(self):
        return {key: self.lock[key]["commit"] for key in ("cef", "chromium", "depot_tools")}

    def owned(self):
        require(self.state is not None, f"未认领的源码目录：{self.root}")
        require(self.state.get("project") == str(PROJECT), "源码目录属于另一个项目")
        require(self.state.get("identity") == self.identity(), "源码目录与锁文件版本不符")
        require(not self.state.get("pending"), f"上次操作未完成：{self.state.get('pending')}；保留现场，请人工处理或选择新目录")

    def begin(self, operation):
        self.state["pending"] = operation
        save(self.state_path, self.state)

    def finish(self):
        self.state["snapshot"] = self.snapshot()
        self.state.pop("pending", None)
        save(self.state_path, self.state)

    def repositories(self):
        paths = {self.src, self.cef, self.root / "cef", self.root / "depot_tools"}
        entries = self.root / "chromium/.gclient_entries"
        if entries.is_file():
            for relative in literal_assignment(entries, "entries"):
                candidate = (self.root / "chromium" / relative).resolve()
                require(candidate.is_relative_to(self.root), "依赖路径越过源码目录")
                paths.add(candidate)
        return sorted(p for p in paths if (p / ".git").exists())

    def snapshot(self):
        result = {}
        for repo in self.repositories():
            # Git 状态只用于拒绝覆盖未登记改动；摘要同时防止改动后状态字母不变。
            status = self.run(["git", "-C", repo, "status", "--porcelain=v1", "-z", "--untracked-files=all"], capture=True)
            entries = status.split("\0")
            files = {}
            index = 0
            while index < len(entries):
                entry = entries[index]
                index += 1
                if not entry:
                    continue
                relative = entry[3:]
                path = repo / relative
                if entry[:2].strip().startswith(("R", "C")):
                    index += 1
                files[relative] = digest(path) if path.is_file() else ("directory" if path.is_dir() else "deleted")
            result[repo.relative_to(self.root).as_posix()] = {
                "head": self.git(repo, "rev-parse", "HEAD"), "status": status, "files": files}
        for relative in ("chromium/.gclient", "chromium/.gclient_entries"):
            path = self.root / relative
            if path.is_file():
                result[relative] = digest(path)
        return result

    def safe(self):
        self.owned()
        require(self.snapshot() == self.state.get("snapshot"), "源码存在未登记改动；停止，不清理或回退用户文件")
        self.revisions()

    def revisions(self):
        for key, path in (("cef", self.cef), ("chromium", self.src), ("depot_tools", self.root / "depot_tools")):
            require(self.git(path, "rev-parse", "HEAD") == self.lock[key]["commit"], f"{key} revision 不匹配")

    def sync(self):
        self.doctor()
        if self.state is not None:
            self.safe()
            require(self.state.get("synced"), "已有目录没有完整同步记录")
            print("锁定源码及已登记状态未改变；不运行会回退源码的上游更新流程。")
            return
        require(not self.root.exists() or not any(self.root.iterdir()), "已有未认领目录非空；停止")
        depot = self.lock["depot_tools"]
        if depot["commit"] is None:
            sha = command(["git", "ls-remote", depot["url"], "HEAD"], PROJECT, self.env, True).split()[0]
            require(re.fullmatch(r"[0-9a-f]{40}", sha), "depot_tools 未返回完整 SHA")
            depot["commit"] = sha
            save(LOCK, self.lock)
        require(re.fullmatch(r"[0-9a-f]{40}", depot["commit"]), "depot_tools SHA 无效")
        self.root.mkdir(parents=True, exist_ok=True)
        self.state = {"project": str(PROJECT), "identity": self.identity(), "pending": "sync"}
        save(self.state_path, self.state)
        self.run(["git", "clone", "--no-checkout", depot["url"], self.root / "depot_tools"])
        self.run(["git", "-C", self.root / "depot_tools", "checkout", "--detach", depot["commit"]])
        self.bootstrap_windows()
        url = f"https://raw.githubusercontent.com/chromiumembedded/cef/{self.lock['cef']['commit']}/tools/automate/automate-git.py"
        with urllib.request.urlopen(url, timeout=60) as response:
            data = response.read()
        sha = hashlib.sha256(data).hexdigest()
        recorded = self.lock.get("automate", {})
        require(not recorded or recorded == {"url": url, "sha256": sha}, "automate 下载摘要与锁不符")
        self.lock["automate"] = {"url": url, "sha256": sha}
        save(LOCK, self.lock)
        automate = self.root / "automate-git.py"
        automate.write_bytes(data)
        require(digest(automate) == self.lock["automate"]["sha256"], "automate 执行前摘要不符")
        args = [f"--download-dir={self.root}", f"--depot-tools-dir={self.root / 'depot_tools'}",
                f"--branch={self.lock['cef']['branch']}", f"--checkout={self.lock['cef']['commit']}",
                f"--chromium-checkout={self.lock['chromium']['tag']}", "--x64-build", "--no-build",
                "--no-distrib", "--no-depot-tools-update", "--no-chromium-history"]
        help_text = self.run([sys.executable, automate, "--help"], capture=True)
        require(all(arg.split("=")[0] in help_text for arg in args), "固定 automate 参数不兼容")
        chromium = self.root / "chromium"
        chromium.mkdir()
        # 提前提供配置，避开上游 automate 的 siso_version='latest' 覆盖。
        solution = {"managed": False, "name": "src", "url": self.lock["chromium"]["url"] + "@" + self.lock["chromium"]["commit"],
                    "custom_vars": {"checkout_pgo_profiles": False, "source_tarball": False},
                    "custom_deps": {}, "deps_file": "DEPS", "safesync_url": ""}
        (chromium / ".gclient").write_text("solutions = " + repr([solution]) + "\n", encoding="utf-8")
        self.run([sys.executable, automate, *args])
        self.revisions()
        self.state["toolchain"] = self.toolchain()
        self.state["synced"] = True
        self.finish()

    def toolchain(self):
        solutions = literal_assignment(self.root / "chromium/.gclient", "solutions")
        require(all("siso_version" not in s.get("custom_vars", {}) for s in solutions), "禁止覆盖 DEPS 固定的 siso_version")
        deps = self.src / "DEPS"
        match = re.search(r"['\"]siso_version['\"]\s*:\s*['\"](git_revision:[0-9a-f]{40})['\"]", deps.read_text(encoding="utf-8"))
        require(match, "DEPS 未固定 siso 完整 revision")
        records = {"siso_version": match.group(1), "files": {}}
        for relative in ("DEPS", "build/vs_toolchain.py", "tools/clang/scripts/update.py", "tools/rust/update_rust.py",
                         "third_party/llvm-build/Release+Asserts/cr_build_revision", "third_party/rust-toolchain/VERSION",
                         "third_party/siso/cipd_manifest.txt"):
            path = self.src / relative
            if path.is_file():
                records["files"][relative] = digest(path)
        records["dependency_revisions"] = self.run([self.root / "depot_tools/gclient.bat", "revinfo", "--actual"], cwd=self.root / "chromium", capture=True)
        return records

    def input_files(self):
        return {
            "profiles/windows-desktop.json": PROJECT / "profiles/windows-desktop.json",
            "native/src/engine_protocol.h": PROJECT / "native/src/engine_protocol.h",
        }

    def queue(self, pin=False, refresh_input=None):
        paths = [PROJECT / "patches/cef/0001-register-iris.patch"]
        paths += [PROJECT / "patches/chromium" / (name + ".patch") for name in NAMES]
        for path in paths:
            require(path.is_file() and path.stat().st_size, f"缺少真实补丁：{path}")
        hashes = {p.relative_to(PROJECT).as_posix(): digest(p) for p in paths}
        inputs = {}
        for relative, path in self.input_files().items():
            require(path.is_file(), f"缺少引擎构建输入：{relative}")
            inputs[relative] = digest(path)
        if pin and "patches" not in self.lock and "inputs" not in self.lock:
            self.lock["patches"] = hashes
            self.lock["inputs"] = inputs
            save(LOCK, self.lock)
        require(hashes == self.lock.get("patches"), "补丁输入与锁定摘要不符；resave 仅更新明确指定补丁")
        expected = self.lock.get("inputs", {})
        require(set(inputs) == set(expected) and
                all(sha == expected[path] for path, sha in inputs.items()
                    if path != refresh_input),
                "profile/私有协议输入与锁不符；分别使用 resave --patch iris_000_profile / iris_070_engine_identity")
        return paths, hashes

    def engine_build_id(self):
        # 只包含源输入；生成的 ID 文件本身不能进入哈希，避免循环定义。
        payload = {"schema_version": 1, "identity": self.identity(),
                   "build": self.lock["build"],
                   "patches": self.lock["patches"], "inputs": self.lock["inputs"]}
        encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    def prepare_inputs(self):
        copies = {
            "components/iris/profile.json": PROJECT / "profiles/windows-desktop.json",
            "components/iris/engine_protocol.h": PROJECT / "native/src/engine_protocol.h",
            "components/iris/engine.lock.json": LOCK,
        }
        generated = self.state.get("generated_inputs", {})
        contents = {relative: source.read_bytes() for relative, source in copies.items()}
        for relative, source in copies.items():
            if source != LOCK:
                require(hashlib.sha256(contents[relative]).hexdigest() ==
                        self.lock["inputs"][source.relative_to(PROJECT).as_posix()],
                        f"构建输入在复制前发生变化：{source}")
        contents["components/iris/engine_build_id.txt"] = (self.engine_build_id() + "\n").encode("ascii")
        for relative, data in contents.items():
            target = self.src / relative
            require(not target.exists() or generated.get(relative) == digest(target),
                    f"不覆盖未登记的生成输入：{target}")
            target.parent.mkdir(parents=True, exist_ok=True)
            sha = hashlib.sha256(data).hexdigest()
            if generated.get(relative) != sha:
                target.write_bytes(data)
            generated[relative] = sha
        self.state["generated_inputs"] = generated

    def registered(self):
        patches = literal_assignment(self.cef / "patch/patch.cfg", "patches")
        names = [patch["name"] for patch in patches]
        require(names[-len(NAMES):] == list(NAMES), "自有补丁必须按规定顺序位于 CEF 队列末尾")
        require(all(names.count(name) == 1 for name in NAMES), "补丁缺少注册或重复注册")
        for patch in patches[-len(NAMES):]:
            require(not patch.get("condition") and patch.get("path", "") in ("", "."), "自有补丁不能跳过或重定向目标")
        return names

    def apply(self, replay=False):
        self.safe()
        paths, hashes = self.queue(pin=True)
        require(not self.state.get("applied"), "补丁已应用；不重复修改源码")
        require(replay or self.state.get("baseline"), "先成功构建并保留原版基线")
        self.begin("apply")
        destination = self.cef / "patch/patches"
        for source in paths:
            target = destination / source.name
            require(not target.exists(), f"不覆盖已有补丁：{target}")
            shutil.copyfile(source, target)
        registration = self.run([sys.executable, self.cef / "tools/patcher.py", "--patch-file", paths[0].stem, "--patch-dir", self.cef], cwd=self.cef, capture=True)
        print(registration)
        require("... successfully applied" in registration, "注册补丁未实际应用")
        order = self.registered()
        bases = self.state.setdefault("patch_bases", {})
        # 仍按官方 cfg 顺序、条件和目标运行官方 patcher；逐项保存自有层前像。
        for entry in literal_assignment(self.cef / "patch/patch.cfg", "patches"):
            if entry.get("condition") and entry["condition"] not in self.env:
                continue
            name = entry["name"]
            target_root = (self.src / entry.get("path", "")).resolve()
            require(target_root.is_relative_to(self.src), "补丁目标越过源码目录")
            if name in NAMES:
                bases[name] = engine_patches.capture(
                    self.src, destination / (name + ".patch"),
                    self.root / "patch-bases" / name)
            output = self.run([sys.executable, self.cef / "tools/patcher.py",
                               "--patch-file", name, "--patch-dir", target_root],
                              cwd=self.cef, capture=True)
            print(output)
            if name in NAMES:
                require("... successfully applied" in output,
                        f"自有补丁未实际应用：{name}")
                save(self.state_path, self.state)
        self.prepare_inputs()
        self.state["applied"] = {"patches": hashes, "order": order,
                                 "inputs": self.lock["inputs"].copy(),
                                 "engine_build_id": self.engine_build_id()}
        self.finish()
        self.state["applied"]["files"] = self.changed_files()
        save(self.state_path, self.state)

    def changed_files(self):
        # 只比较队列目标，排除 GN/version_manager 生成文件及机器路径。
        result = {"cef/patch/patch.cfg": digest(self.cef / "patch/patch.cfg")}
        for patch in literal_assignment(self.cef / "patch/patch.cfg", "patches"):
            if patch.get("condition") and patch["condition"] not in self.env:
                continue
            base = (self.src / patch.get("path", "")).resolve()
            require(base.is_relative_to(self.src), "补丁目标越过 Chromium 源码目录")
            if not base.is_dir():
                continue
            patch_file = self.cef / "patch/patches" / (patch["name"] + ".patch")
            for line in patch_file.read_text(encoding="utf-8").splitlines():
                if not line.startswith(("+++ ", "--- ")):
                    continue
                relative = line[4:].split("\t")[0]
                if relative == "/dev/null":
                    continue
                target = (base / relative).resolve()
                require(target.is_relative_to(self.src), "补丁文件路径越过源码目录")
                result[target.relative_to(self.src).as_posix()] = digest(target) if target.is_file() else "deleted"
        return result

    def build(self, baseline=False):
        self.doctor()
        self.safe()
        if baseline:
            require(not self.state.get("applied") and not self.state.get("baseline"), "原版基线只构建一次，不能用补丁版覆盖")
        else:
            _, hashes = self.queue()
            require(self.state.get("applied", {}).get("patches") == hashes, "尚未成功应用当前补丁队列")
            require(self.state["applied"].get("engine_build_id") == self.engine_build_id(),
                    "已应用源码与当前引擎输入不一致")
            self.registered()
        self.begin("baseline-build" if baseline else "patched-build")
        if baseline:
            self.run([self.cef / "cef_create_projects.bat"], cwd=self.cef)
        else:
            # apply 已验证完整有序队列；后层可以修改前层，不能再次逐项
            # 反向探测“是否已应用”。这里只运行相同的上游项目生成步骤。
            self.run([sys.executable, PROJECT / "tools/engine_projects.py",
                      "--cef", self.cef, "--configuration", CONFIG], cwd=self.cef)
        self.run([self.root / "depot_tools/autoninja.bat", "-C", f"out/{CONFIG}",
                  *self.lock["build_targets"]], cwd=self.src)
        output = self.src / "out" / CONFIG
        for name in ("libcef.dll", "bootstrap.exe", "bootstrapc.exe", "cefsimple.exe"):
            require((output / name).is_file(), f"构建缺少产物：{name}")
        marker = {"identity": self.identity(), "build": self.lock["build"],
                  "targets": self.lock["build_targets"],
                  "toolchain": self.toolchain(), "args_sha256": digest(output / "args.gn"),
                  "binaries": {name: digest(output / name) for name in ("libcef.dll", "bootstrap.exe", "bootstrapc.exe", "cefsimple.exe")}}
        if baseline:
            distribution = self.root / "baseline-official/distribution"
            cef_package = self.distribute(distribution)
            preserved = self.root / "baseline-official/runtime"
            require(not preserved.exists(), "原版输出已存在，拒绝覆盖")
            # 保留独立的原版运行文件，而不是整份中间对象；补丁构建复用 GN 增量输出。
            shutil.copytree(cef_package / "Release", preserved)
            for source in (cef_package / "Resources").iterdir():
                target = preserved / source.name
                require(not target.exists(), f"原版资源名称冲突：{source.name}")
                if source.is_dir():
                    shutil.copytree(source, target)
                else:
                    shutil.copy2(source, target)
            for name, expected in marker["binaries"].items():
                target = preserved / name
                if not target.exists():
                    shutil.copy2(output / name, target)
                require(digest(target) == expected, f"原版保留产物摘要不符：{name}")
            marker["output"] = str(preserved)
            marker["distribution"] = str(distribution)
            self.state["baseline"] = marker
            print("Official 原版构建已保留；仍须实际打开并关闭 cefsimple 验证窗口。")
        else:
            marker["patches"] = self.state["applied"]["patches"]
            marker["inputs"] = self.lock["inputs"].copy()
            marker["engine_build_id"] = self.engine_build_id()
            self.state["built"] = marker
        self.finish()

    def distribute(self, output):
        require(not output.exists(), f"分发输出已存在，拒绝覆盖：{output}")
        output.mkdir(parents=True)
        # Release-only 完整开发分发仍含头文件和导入库；上游清单决定运行资源。
        self.run([sys.executable, self.cef / "tools/make_distrib.py", f"--output-dir={output}",
                  "--ninja-build", "--x64-build", "--allow-partial", "--no-symbols", "--no-docs", "--no-archive", "--no-format"], cwd=self.cef)
        dlls = list(output.glob("*/Release/libcef.dll"))
        require(len(dlls) == 1, "上游分发未产生唯一 Release/libcef.dll")
        package_root = dlls[0].parent.parent
        # 只整理本次创建的上游输出；CEF_ROOT 本身就是可交给 FindCEF 的目录。
        for source in package_root.iterdir():
            target = output / source.name
            require(not target.exists(), f"上游分发文件名称冲突：{target}")
            shutil.move(source, target)
        package_root.rmdir()
        marker = {"schema_version": 1, "identity": self.identity(),
                  "build": self.lock["build"], "targets": self.lock["build_targets"]}
        if self.state.get("applied"):
            header = self.src / "out" / CONFIG / "gen/components/iris/profile_data.h"
            require(header.is_file(), "没有真实生成的 profile 头文件")
            shutil.copyfile(header, output / "include/iris_profile_data.h")
            marker["engine_build_id"] = self.engine_build_id()
            marker["inputs"] = self.lock["inputs"].copy()
        files = {p.relative_to(output).as_posix(): digest(p) for p in output.rglob("*") if p.is_file()}
        marker["files"] = files
        save(output / "iris-distribution.json", marker)
        return output

    def package(self, output):
        self.safe()
        _, hashes = self.queue()
        built = self.state.get("built", {})
        require(built.get("patches") == hashes, "没有当前补丁的成功构建记录")
        require(built.get("engine_build_id") == self.engine_build_id(),
                "构建产物的 profile/协议输入与当前锁不一致")
        for name, sha in built["binaries"].items():
            require(digest(self.src / "out" / CONFIG / name) == sha, "构建产物摘要改变")
        self.begin("package")
        self.distribute(output.resolve())
        # Rust 声明只接受本次实际成功构建并分发的引擎，不接受包的自我声明。
        (PROJECT / "crates/iris-sys/engine-build-id.txt").write_text(
            built["engine_build_id"] + "\n", encoding="ascii")
        self.state["package"] = str(output.resolve())
        self.finish()

    def check_replay(self):
        self.safe()
        _, hashes = self.queue()
        expected = self.state.get("applied")
        require(expected and expected["patches"] == hashes, "需要已成功应用的完整补丁作为重放预期")
        replay_root = self.root.parent / (self.root.name + "-replay-" + uuid.uuid4().hex)
        replay = Engine(replay_root)
        replay.sync()
        replay.apply(replay=True)
        require(replay.state["applied"]["order"] == expected["order"], "重放注册顺序不符")
        require(replay.state["applied"]["files"] == expected["files"], "重放源码摘要不符")
        require(replay.state.get("generated_inputs") == self.state.get("generated_inputs"),
                "重放 profile/协议/构建标识输入不符")
        self.state["replay"] = {"root": str(replay_root), "patches": hashes}
        save(self.state_path, self.state)
        print(f"完整队列重放与摘要一致；保留独立现场：{replay_root}")

    def resave(self, name, add=(), purpose=None, acceptance=None, add_bases=()):
        self.owned()
        self.revisions()
        require(name in NAMES, "只能 resave 已注册的自有补丁名称")
        refresh_input = {
            "iris_000_profile": "profiles/windows-desktop.json",
            "iris_070_engine_identity": "native/src/engine_protocol.h",
        }.get(name)
        self.queue(refresh_input=refresh_input)
        self.registered()
        require(self.state.get("applied"), "需要已应用的补丁")
        # resave 是唯一允许显式人工源码编辑的入口；限制到指定补丁已有目标。
        patch = self.cef / "patch/patches" / (name + ".patch")
        metadata = engine_patches.metadata_prefix(patch, purpose, acceptance)
        paths = set(engine_patches.targets(patch))
        require(all((self.src / path).resolve().is_relative_to(self.src) for path in paths),
                "补丁目标路径不安全")
        before = self.state["snapshot"]
        after = self.snapshot()
        extra_bases = {}
        supplied_bases = {}
        for entry in add_bases:
            relative, separator, filename = entry.partition("=")
            relative = Path(relative).as_posix()
            require(separator and filename and relative not in supplied_bases,
                    "--add-base 必须为不重复的 TARGET=FILE")
            supplied_bases[relative] = Path(filename)
        all_targets = {path for item in NAMES for path in engine_patches.targets(
            self.cef / "patch/patches" / (item + ".patch"))}
        for relative in add:
            candidate = Path(relative)
            require(not candidate.is_absolute() and ".." not in candidate.parts and ":" not in relative,
                    "新增补丁目标路径不安全")
            relative = candidate.as_posix()
            require(relative not in all_targets and relative not in extra_bases,
                    "新增目标已经属于补丁队列")
            source = self.src / candidate
            require(source.resolve().is_relative_to(self.src) and source.is_file(),
                    "新增目标必须是源码树内已有普通文件")
            owners = [(repo, value) for repo, value in before.items()
                      if Path(repo).is_relative_to("chromium/src") and
                      source.is_relative_to(self.root / repo)]
            require(owners, "新增目标没有已记录的仓库前像")
            repo, recorded = max(owners, key=lambda item: len(Path(item[0]).parts))
            local = source.relative_to(self.root / repo).as_posix()
            require(after[repo]["head"] == recorded["head"], "新增目标仓库 HEAD 已变化")
            if local in recorded["files"]:
                require(relative in supplied_bases,
                        "新增目标已有基线修改；须用 --add-base 提供与已记录摘要一致的前像")
                original = supplied_bases.pop(relative).read_bytes()
                require(hashlib.sha256(original).hexdigest() == recorded["files"][local],
                        "提供的前像与已记录源码摘要不符")
            else:
                require(relative not in supplied_bases, "干净目标由 Git 提供前像，不接受 --add-base")
                original = subprocess.run(
                    ["git", "-C", str(self.root / repo), "show", f"{recorded['head']}:{local}"],
                    env=self.env, capture_output=True, check=True).stdout
            # 补丁缓存与官方 git_apply_patch_file 一样使用 LF；不修改活源码换行。
            extra_bases[relative] = original.replace(b"\r\n", b"\n")
            paths.add(relative)
        require(not supplied_bases, "--add-base 必须对应本次 --add 的已修改基线文件")
        for repo in set(before) | set(after):
            old, new = before.get(repo), after.get(repo)
            if old == new:
                continue
            require(Path(repo).is_relative_to("chromium/src") and
                    isinstance(old, dict) and isinstance(new, dict) and
                    old["head"] == new["head"], "指定补丁之外存在源码变化")
            prefix = Path(repo).relative_to("chromium/src")
            changed = {(prefix / p).as_posix()
                       for p in set(old["files"]) | set(new["files"])
                       if old["files"].get(p) != new["files"].get(p)}
            require(changed <= paths, "人工修改涉及指定补丁之外的文件")
        self.begin("resave")
        bases = self.state.get("patch_bases", {})
        require(set(bases) == set(NAMES), "没有完整补丁前像；不能安全 resave")
        ordered = {item: self.cef / "patch/patches" / (item + ".patch") for item in NAMES}
        storage = self.root / "patch-bases"
        result = engine_patches.resave(self.cef, self.src, storage, bases,
                                      ordered, name, self.env, extra_bases, metadata)
        print(result["log"])
        require(self.snapshot() == after, "resave 期间工作源码发生变化；未发布新补丁")
        self.queue(refresh_input=refresh_input)
        for item, updated in result["bases"].items():
            for relative in set(bases[item]) | set(updated):
                cached = storage / item / relative
                expected = bases[item].get(relative)
                require((not cached.exists() if expected is None else
                         cached.is_file() and digest(cached) == expected),
                        f"不覆盖已被修改的补丁前像：{cached}")
        patch.write_bytes(result["patch"])
        target = PROJECT / "patches/chromium" / patch.name
        shutil.copyfile(patch, target)
        for item, updated in result["bases"].items():
            for relative in set(bases[item]) | set(updated):
                cached = storage / item / relative
                if updated.get(relative) is None:
                    cached.unlink(missing_ok=True)
                else:
                    cached.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(result["workspace"] / "bases" / item / relative, cached)
            bases[item] = updated
        self.lock["patches"][target.relative_to(PROJECT).as_posix()] = digest(target)
        if refresh_input:
            self.lock["inputs"][refresh_input] = digest(self.input_files()[refresh_input])
        save(LOCK, self.lock)
        self.prepare_inputs()
        self.state["applied"]["patches"] = self.lock["patches"].copy()
        self.state["applied"]["inputs"] = self.lock["inputs"].copy()
        self.state["applied"]["engine_build_id"] = self.engine_build_id()
        self.state["applied"]["files"] = self.changed_files()
        self.state["last_resave"] = {"patch": name, "workspace": str(result["workspace"])}
        self.state.pop("built", None)
        self.state.pop("replay", None)
        self.state.pop("package", None)
        self.finish()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("D:/iris-build"))
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("doctor", "sync", "apply", "build", "package", "check-replay", "resave"):
        child = sub.add_parser(name)
        child.add_argument("--root", type=Path, default=argparse.SUPPRESS)
        if name == "build":
            child.add_argument("--baseline", action="store_true")
        if name == "package":
            child.add_argument("--output", type=Path, required=True)
        if name == "resave":
            child.add_argument("--patch", choices=NAMES, required=True)
            child.add_argument("--add", action="append", default=[],
                               help="通过官方 updater 将干净基线中的已有源码文件加入指定补丁")
            child.add_argument("--add-base", action="append", default=[],
                               help="已有基线修改的精确前像 TARGET=FILE，必须匹配已记录摘要并配合 --add")
            child.add_argument("--purpose", help="通过受保护的 resave 更新补丁目的，不手改锁定补丁")
            child.add_argument("--acceptance", help="更新补丁验收说明，保留来源、许可及源码校验")
    args = parser.parse_args()
    try:
        engine = Engine(args.root)
        if args.command == "build":
            engine.build(args.baseline)
        elif args.command == "package":
            engine.package(args.output)
        elif args.command == "resave":
            engine.resave(args.patch, args.add, args.purpose, args.acceptance, args.add_base)
        else:
            getattr(engine, args.command.replace("-", "_"))()
        return 0
    except (EngineError, OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
