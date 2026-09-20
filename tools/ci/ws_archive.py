"""引擎工作区压缩/解压：tar 管道接 zstd，跨 Windows/Linux。

工作区在分段 job 间经 actions/upload-artifact 接力；单文件 tar.zst
（而非海量散文件）保证上传/下载耗时可控。Windows 上自动下载固定版本的
zstd（带 SHA-256 校验），Linux 直接使用系统 zstd。
"""
from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request
import zipfile

IS_WINDOWS = sys.platform == "win32"
ZSTD_VERSION = "1.5.7"
ZSTD_WIN64_URL = f"https://github.com/facebook/zstd/releases/download/v{ZSTD_VERSION}/zstd-v{ZSTD_VERSION}-win64.zip"
ZSTD_WIN64_SHA256 = "acb4e8111511749dc7a3ebedca9b04190e37a17afeb73f55d4425dbf0b90fad9"


def find_zstd(cache_dir: Path) -> str:
    if shutil.which("zstd"):
        return "zstd"
    if not IS_WINDOWS:
        raise SystemExit("缺少 zstd；请先 apt-get install zstd")
    target = cache_dir / "zstd.exe"
    if not target.is_file():
        cache_dir.mkdir(parents=True, exist_ok=True)
        bundle = cache_dir / "zstd-win64.zip"
        with urllib.request.urlopen(ZSTD_WIN64_URL, timeout=120) as response:
            data = response.read()
        if hashlib.sha256(data).hexdigest() != ZSTD_WIN64_SHA256:
            raise SystemExit("zstd 下载摘要与固定值不符")
        bundle.write_bytes(data)
        with zipfile.ZipFile(bundle) as archive:
            with archive.open(f"zstd-v{ZSTD_VERSION}-win64/zstd.exe") as source, \
                    target.open("wb") as out:
                shutil.copyfileobj(source, out)
        bundle.unlink()
    return str(target)


def find_tar() -> str:
    # Windows 上 PATH 可能先命中 git-bash 的 GNU tar；优先系统 bsdtar。
    if IS_WINDOWS:
        for candidate in (Path(r"C:\Windows\System32\tar.exe"),):
            if candidate.is_file():
                return str(candidate)
    tar = shutil.which("tar")
    if not tar:
        raise SystemExit("缺少 tar")
    return tar


def pack(root: Path, output: Path, excludes, zstd_cache: Path):
    tar, zstd = find_tar(), find_zstd(zstd_cache)
    args = [tar, "-cf", "-"]
    for pattern in excludes:
        args += ["--exclude", pattern]
    args += ["-C", str(root), "."]
    print("+ " + " ".join(args) + f" | zstd -3 -T0 -o {output}", flush=True)
    producer = subprocess.Popen(args, stdout=subprocess.PIPE)
    consumer = subprocess.Popen([zstd, "-3", "-T0", "-q", "-o", str(output)],
                                stdin=producer.stdout)
    producer.stdout.close()
    code = consumer.wait()
    producer.wait()
    if code or producer.returncode not in (0, None):
        # tar 对个别被拒绝/消失文件返回非零但归档可用时过于嘈杂；以 zstd 结果为准。
        if code != 0 or producer.returncode not in (0, 1):
            raise SystemExit(f"打包失败：tar={producer.returncode} zstd={code}")
    size = output.stat().st_size
    print(f"工作区归档：{output}（{size / 1e9:.1f} GB）", flush=True)


def unpack(archive: Path, root: Path, zstd_cache: Path):
    tar, zstd = find_tar(), find_zstd(zstd_cache)
    root.mkdir(parents=True, exist_ok=True)
    producer = subprocess.Popen([zstd, "-dc", str(archive)], stdout=subprocess.PIPE)
    consumer = subprocess.Popen([tar, "-xf", "-", "-C", str(root)], stdin=producer.stdout)
    producer.stdout.close()
    code = consumer.wait()
    producer.wait()
    if code or producer.returncode:
        raise SystemExit(f"解压失败：zstd={producer.returncode} tar={code}")
    print(f"工作区已恢复到 {root}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    packer = sub.add_parser("pack")
    packer.add_argument("--root", type=Path, required=True)
    packer.add_argument("--output", type=Path, required=True)
    packer.add_argument("--exclude", action="append", default=[])
    unpacker = sub.add_parser("unpack")
    unpacker.add_argument("--archive", type=Path, required=True)
    unpacker.add_argument("--root", type=Path, required=True)
    parser.add_argument("--zstd-cache", type=Path,
                        default=Path.home() / ".iris-ci-tools")
    args = parser.parse_args()
    if args.command == "pack":
        args.output.parent.mkdir(parents=True, exist_ok=True)
        pack(args.root, args.output, args.exclude, args.zstd_cache)
    else:
        unpack(args.archive, args.root, args.zstd_cache)
    return 0


if __name__ == "__main__":
    sys.exit(main())
