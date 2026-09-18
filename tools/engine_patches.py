"""以保存的补丁前像驱动官方 resave；不回退工作源码或创建提交。"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def targets(patch):
    result = set()
    for line in patch.read_text(encoding="utf-8").splitlines():
        if line.startswith(("--- ", "+++ ")):
            relative = line[4:].split("\t", 1)[0]
            if relative == "/dev/null":
                continue
            path = Path(relative)
            if path.is_absolute() or ".." in path.parts or ":" in relative:
                raise ValueError(f"补丁目标不安全：{relative}")
            result.add(path.as_posix())
    if not result:
        raise ValueError(f"没有真实文件变更：{patch}")
    return sorted(result)


def capture(source, patch, destination):
    if destination.exists():
        raise ValueError(f"不覆盖补丁前像：{destination}")
    destination.mkdir(parents=True)
    files = {}
    for relative in targets(patch):
        path = source / relative
        if not path.resolve().is_relative_to(source.resolve()):
            raise ValueError(f"补丁目标越过源码边界：{relative}")
        if path.is_file():
            data = path.read_bytes()
            copy = destination / relative
            copy.parent.mkdir(parents=True, exist_ok=True)
            copy.write_bytes(data)
            files[relative] = sha256(data)
        elif path.exists():
            raise ValueError(f"补丁目标不是普通文件：{relative}")
        else:
            files[relative] = None
    return files


def metadata_prefix(patch, purpose=None, acceptance=None):
    updates = {key: value for key, value in
               (("目的", purpose), ("验收要求", acceptance)) if value is not None}
    for value in updates.values():
        if not isinstance(value, str) or not value.strip() or any(c in value for c in "\r\n\0"):
            raise ValueError("补丁说明必须是非空单行文本")
    prefix = []
    for line in patch.read_text(encoding="utf-8").splitlines(keepends=True):
        if line.startswith(("diff --git ", "--- ")):
            break
        key = line.partition("：")[0]
        if key in updates:
            line = f"{key}：{updates.pop(key)}\n"
        prefix.append(line)
    if updates:
        raise ValueError("补丁缺少待更新的说明字段")
    return "".join(prefix).encode("utf-8")


def resave(cef, source, storage, bases, ordered_patches, selected, environment,
           extra_bases=None, prefix=None):
    """返回真实新补丁及后续前像；成功前不改活源码、原补丁或缓存前像。"""
    names = list(ordered_patches)
    selected_index = names.index(selected)
    affected = names[selected_index:]
    all_paths = set()
    for name in affected:
        all_paths.update(targets(ordered_patches[name]))
    old_patch = ordered_patches[selected]
    extra_bases = extra_bases or {}
    selected_paths = sorted(set(targets(old_patch)) | set(extra_bases))
    all_paths.update(extra_bases)
    expected_base = {**bases[selected], **{path: sha256(data) for path, data in extra_bases.items()}}
    if not set(selected_paths) <= set(expected_base):
        raise ValueError("指定补丁缺少已记录前像")

    work = Path(tempfile.mkdtemp(prefix="iris-resave-", dir=storage.parent))
    print(f"独立 resave 工作目录：{work}", flush=True)
    root = work / "src"
    root.mkdir()
    normalized = {}
    patch_copies = work / "patches"
    patch_copies.mkdir()
    for name in affected:
        copy = patch_copies / (name + ".patch")
        # 与固定 CEF git_util.git_apply_patch_file 的输入正规化完全一致。
        copy.write_bytes(ordered_patches[name].read_bytes().replace(b"\r\n", b"\n"))
        normalized[name] = copy
    child_env = environment.copy()
    # 官方 updater 自行定位自身父目录；只复制脚本，helper 使用固定原目录。
    child_env["PYTHONPATH"] = str(cef / "tools")
    for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
                "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"):
        child_env.pop(key, None)
    for key in list(child_env):
        if key.startswith("GIT_CONFIG_"):
            del child_env[key]
    child_env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_SYSTEM=os.devnull,
                     GIT_CONFIG_COUNT="2", GIT_CONFIG_KEY_0="core.autocrlf",
                     GIT_CONFIG_VALUE_0="false", GIT_CONFIG_KEY_1="core.longpaths",
                     GIT_CONFIG_VALUE_1="true")

    def run(arguments, cwd=root):
        result = subprocess.run([str(arg) for arg in arguments], cwd=cwd,
                                env=child_env, capture_output=True,
                                encoding="utf-8", errors="strict")
        if result.returncode:
            print(result.stdout, end="")
            print(result.stderr, end="", file=sys.stderr)
            result.check_returncode()
        return result.stdout.strip()

    run(["git", "init", "--quiet"])
    # git diff 比较 index 与 working tree。准确填充 index，无须伪造 HEAD/提交。
    for relative in selected_paths:
        expected = expected_base[relative]
        if expected is None:
            continue
        before = storage / selected / relative
        data = extra_bases[relative] if relative in extra_bases else before.read_bytes()
        if sha256(data) != expected:
            raise ValueError(f"保存的补丁前像已变化：{before}")
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        object_id = run(["git", "hash-object", "-w", "--no-filters", "--", relative])
        run(["git", "update-index", "--add", "--cacheinfo", f"100644,{object_id},{relative}"])

    final_data = {}
    for relative in sorted(all_paths):
        original = source / relative
        if not original.resolve().is_relative_to(source.resolve()):
            raise ValueError(f"工作文件越过源码边界：{relative}")
        data = original.read_bytes() if original.is_file() else None
        if original.exists() and data is None:
            raise ValueError(f"工作文件不是普通文件：{relative}")
        final_data[relative] = data
        target = root / relative
        if data is None:
            target.unlink(missing_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)

    # 仅在新建的隔离目录移除后续层，避免把它们吸入当前补丁。
    for name in reversed(affected[1:]):
        run(["git", "apply", "-p0", "--ignore-whitespace", "--reverse", "--check", normalized[name]])
        run(["git", "apply", "-p0", "--ignore-whitespace", "--reverse", normalized[name]])
    added = [relative for relative in selected_paths
             if expected_base[relative] is None and (root / relative).is_file()]
    if added:
        run(["git", "add", "--intent-to-add", "--", *added])

    isolated_cef = root / "cef"
    tools = isolated_cef / "tools"
    patches = isolated_cef / "patch/patches"
    tools.mkdir(parents=True, exist_ok=True)
    patches.mkdir(parents=True, exist_ok=True)
    updater = tools / "patch_updater.py"
    shutil.copyfile(cef / "tools/patch_updater.py", updater)
    isolated_patch = patches / old_patch.name
    # 基线不存在、当前层也已删除的新增文件不再属于补丁。上游 updater
    # 会把这些未跟踪且不存在的路径误当作 Git revision，因此只从隔离输入移除。
    removed_headers = {
        f"diff --git {relative} {relative}".encode("utf-8")
        for relative in selected_paths
        if expected_base[relative] is None and not (root / relative).exists()
    }
    retained_sections = []
    for section in re.split(rb"(?=^diff --git )", normalized[selected].read_bytes(),
                            flags=re.MULTILINE):
        header = section.partition(b"\n")[0]
        if header in removed_headers:
            removed_headers.remove(header)
        else:
            retained_sections.append(section)
    if removed_headers:
        raise ValueError("无法定位已删除新增文件的完整补丁段")
    isolated_patch.write_bytes(b"".join(retained_sections))
    (isolated_cef / "patch/patch.cfg").write_text(
        "patches = " + repr([{"name": selected}]) + "\n", encoding="utf-8")
    arguments = [sys.executable, updater, "--resave", "--patch", selected]
    for relative in sorted(extra_bases):
        arguments.extend(["--add", relative])
    log = run(arguments, isolated_cef)
    generated = isolated_patch.read_bytes()
    generated_paths = set(targets(isolated_patch)) if generated else set()
    if not generated_paths:
        raise ValueError("官方 resave 没有产生真实变更")
    # 上游 resave 只写 diff；保留本项目要求的来源/许可/验收说明。
    patch_data = (metadata_prefix(old_patch) if prefix is None else prefix) + generated

    refreshed = {}
    if extra_bases or generated_paths != set(bases[selected]):
        refreshed[selected] = {path: expected_base[path] for path in generated_paths}
        for relative, expected in refreshed[selected].items():
            if expected is None:
                continue
            preserved = work / "bases" / selected / relative
            preserved.parent.mkdir(parents=True, exist_ok=True)
            if relative in extra_bases:
                preserved.write_bytes(extra_bases[relative])
            else:
                shutil.copyfile(storage / selected / relative, preserved)
    for name in affected[1:]:
        refreshed[name] = capture(root, ordered_patches[name], work / "bases" / name)
        run(["git", "apply", "-p0", "--ignore-whitespace", "--check", normalized[name]])
        run(["git", "apply", "-p0", "--ignore-whitespace", normalized[name]])
    for relative, data in final_data.items():
        target = root / relative
        actual = target.read_bytes() if target.is_file() else None
        if actual != data:
            raise ValueError(f"重建队列未保留工作源码：{relative}")
    return {"patch": patch_data, "bases": refreshed, "workspace": work,
            "log": log}
