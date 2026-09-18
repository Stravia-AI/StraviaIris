"""从已校验的 CEF/SDK 产物组装独立 Windows 包，不下载、不覆盖旧包。"""
from __future__ import annotations

import argparse
from pathlib import Path, PurePosixPath
import re
import shutil
import struct
import sys
import tempfile
import zipfile

from engine import EngineError, PROJECT, digest, load, require, save


def manifest(root, name):
    value = load(root / name)
    require(value.get("schema_version") == 1, f"不支持的清单：{root / name}")
    require(re.fullmatch(r"[0-9a-f]{64}", value.get("engine_build_id", "")), "缺少实际引擎 build ID")
    files = value.get("files")
    require(isinstance(files, dict) and files, f"空文件清单：{name}")
    for relative, expected in files.items():
        path = PurePosixPath(relative)
        require(not path.is_absolute() and path.as_posix() == relative and
                not any(part in (".", "..") for part in path.parts) and
                ":" not in relative and "\\" not in relative, f"非法清单路径：{relative}")
        source = root / relative
        require(source.resolve().is_relative_to(root) and source.is_file(), f"清单文件不存在或越界：{source}")
        require(isinstance(expected, str) and re.fullmatch(r"[0-9a-f]{64}", expected), f"非法 SHA-256：{relative}")
        require(digest(source) == expected, f"清单摘要不符：{source}")
    return value


def require_pe64(path, dll):
    with path.open("rb") as stream:
        require(stream.read(2) == b"MZ", f"不是 PE 产物：{path}")
        stream.seek(0x3c)
        stream.seek(struct.unpack("<I", stream.read(4))[0])
        header = stream.read(24)
    require(len(header) == 24 and header[:4] == b"PE\0\0", f"PE 头无效：{path}")
    require(struct.unpack_from("<H", header, 4)[0] == 0x8664, f"产物不是 Windows x64：{path}")
    require(bool(struct.unpack_from("<H", header, 22)[0] & 0x2000) == dll, f"EXE/DLL 角色错误：{path}")


def assemble(cef, sdk, rust, reports, output):
    archive = output.with_suffix(".zip")
    checksum = archive.with_suffix(".zip.sha256")
    require(not output.exists() and not archive.exists() and not checksum.exists(), "输出目录或 ZIP 已存在，拒绝覆盖")
    engine = manifest(cef, "iris-distribution.json")
    library = manifest(sdk, "iris-sdk.json")
    require(engine["engine_build_id"] == library["engine_build_id"], "CEF 与 SDK 的 build ID 不同")
    require(library.get("target") == "x86_64-pc-windows-msvc", "SDK target 不符")
    binding = (PROJECT / "crates/iris-sys/engine-build-id.txt").read_text(encoding="ascii").strip()
    require(binding == engine["engine_build_id"], "Rust 绑定不是本次已成功分发的引擎")
    require(engine["files"].get("Release/libcef.lib") == library["files"].get("lib/libcef.lib"), "SDK 导入库与引擎不匹配")
    require_pe64(cef / "Release/libcef.dll", True)
    require_pe64(cef / "Release/bootstrapc.exe", False)
    require_pe64(sdk / "bin/stravia_iris.dll", True)
    require_pe64(rust / "iris_demo.dll", True)
    require(reports.is_dir(), "缺少独立验收报告目录")
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=output.name + "-stage-", dir=output.parent))
    print(f"组装真实分发：{stage}", flush=True)
    copied = {}

    def copy(source, relative, expected=None):
        target = stage / relative
        key = relative.casefold()
        require(key not in copied, f"分发文件名冲突：{relative}")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        actual = digest(target)
        require(expected is None or expected == actual, f"复制期间源文件改变：{source}")
        copied[key] = (relative, actual)

    for relative, expected in library["files"].items():
        copy(sdk / relative, relative, expected)
    copy(sdk / "iris-sdk.json", "iris-sdk.json")
    # Release/Resources 的文件集合由固定 CEF make_distrib 产生；不维护手写 DLL 白名单。
    for relative, expected in engine["files"].items():
        parts = PurePosixPath(relative).parts
        if parts[0] not in ("Release", "Resources") or relative == "Release/libcef.lib":
            continue
        # 运行入口是重命名的 bootstrapc（iris-demo.exe 加载同名 DLL）；
        # GUI 变体 bootstrap.exe 与原名 bootstrapc.exe 均为冗余副本。
        if relative in ("Release/bootstrap.exe", "Release/bootstrapc.exe"):
            continue
        # 只保留实际 UI locale 的 pak；缺失语言由 Chromium 回退 en-US。
        if parts[:2] == ("Resources", "locales") and parts[2] not in ("en-US.pak", "en-GB.pak"):
            continue
        copy(cef / relative, "runtime/" + "/".join(parts[1:]), expected)
    copy(cef / "Release/bootstrapc.exe", "runtime/iris-demo.exe", engine["files"]["Release/bootstrapc.exe"])
    # 固定 bootstrap 仅在原名时允许 --module；重命名的 EXE 必须加载同名 DLL。
    copy(rust / "iris_demo.dll", "runtime/iris-demo.dll")
    # 客户端 DLL 经导入库依赖 stravia_iris.dll；与应用同目录解析。
    copy(sdk / "bin/stravia_iris.dll", "runtime/stravia_iris.dll", library["files"]["bin/stravia_iris.dll"])
    for name in ("LICENSE.txt", "CREDITS.html"):
        copy(cef / name, "licenses/cef/" + name, engine["files"][name])
    copy(cef / "iris-distribution.json", "engine-distribution.json")
    for name in ("Cargo.toml", "Cargo.lock", "engine.lock.json"):
        copy(PROJECT / name, name)
    for name in ("package.json", "package-lock.json"):
        if (PROJECT / name).is_file():
            copy(PROJECT / name, name)
    for directory in (".cargo", "crates", "examples", "native", "patches", "profiles", "tools", "licenses"):
        root = PROJECT / directory
        require(root.is_dir(), f"缺少分发源码：{root}")
        for source in sorted(root.rglob("*")):
            if source.is_file() and "__pycache__" not in source.parts and source.suffix != ".pyc":
                copy(source, source.relative_to(PROJECT).as_posix())
    for source in sorted(reports.rglob("*")):
        require(source.resolve().is_relative_to(reports), f"报告路径越界：{source}")
        if source.is_file():
            copy(source, "reports/" + source.relative_to(reports).as_posix())
    save(stage / "manifest.json", {
        "schema_version": 1,
        "target": library["target"],
        "engine_build_id": engine["engine_build_id"],
        "identity": engine["identity"],
        "build": engine["build"],
        "inputs": engine["inputs"],
        "entrypoint": "runtime/iris-demo.exe",
        "module": "iris-demo",
        "files": dict(sorted(copied.values())),
    })
    stage.rename(output)
    with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
        for source in sorted(output.rglob("*")):
            if source.is_file():
                bundle.write(source, (Path(output.name) / source.relative_to(output)).as_posix())
    sha = digest(archive)
    checksum.write_text(f"{sha}  {archive.name}\n", encoding="ascii")
    print(f"分发目录：{output}\nZIP：{archive}\nSHA-256：{sha}", flush=True)
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cef-dir", type=Path, required=True)
    parser.add_argument("--sdk-dir", type=Path, required=True)
    parser.add_argument("--rust-target", type=Path, required=True)
    parser.add_argument("--reports-dir", type=Path, required=True,
                        help="仅包含待分发 JSON/截图/日志的已验收证据目录，不使用 browser cache 目录")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        assemble(*(path.resolve() for path in (args.cef_dir, args.sdk_dir, args.rust_target, args.reports_dir, args.output)))
    except (EngineError, OSError, ValueError, KeyError, TypeError, struct.error) as error:
        print(f"分发失败：{error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
