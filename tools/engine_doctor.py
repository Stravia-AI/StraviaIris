"""只读检查固定 CEF 构建所需的本机工具链；不安装或修改全局环境。"""

import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys


def _version(value):
    match = re.search(r"\d+\.\d+(?:\.\d+){0,2}", str(value))
    return tuple(int(part) for part in match.group().split(".")) if match else ()


def _run(arguments):
    return subprocess.run(arguments, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=30,
                          check=False)


def _registry_values(subkey, names):
    import winreg
    values = []
    for view in (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY):
        try:
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, subkey, 0,
                                winreg.KEY_READ | view) as key:
                row = {}
                for name in names:
                    try:
                        row[name] = winreg.QueryValueEx(key, name)[0]
                    except OSError:
                        pass
                values.append(row)
        except OSError:
            pass
    return values


def _sdk_packages():
    import winreg
    packages = []
    uninstall = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"
    for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
        for view in (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY):
            try:
                with winreg.OpenKey(hive, uninstall, 0, winreg.KEY_READ | view) as key:
                    for index in range(winreg.QueryInfoKey(key)[0]):
                        try:
                            child = winreg.EnumKey(key, index)
                            with winreg.OpenKey(key, child) as item:
                                name = str(winreg.QueryValueEx(item, "DisplayName")[0])
                                if "Windows Software Development Kit" not in name:
                                    continue
                                try:
                                    version = str(winreg.QueryValueEx(item, "DisplayVersion")[0])
                                except OSError:
                                    version = "unknown"
                                packages.append((name, version))
                        except OSError:
                            continue
            except OSError:
                continue
    return sorted(set(packages))


def _file_version(path):
    # 读取 PE 版本资源，不加载或执行待检查的 DLL。
    api = ctypes.WinDLL("version", use_last_error=True)
    api.GetFileVersionInfoSizeW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(wintypes.DWORD)]
    api.GetFileVersionInfoSizeW.restype = wintypes.DWORD
    api.GetFileVersionInfoW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p]
    api.GetFileVersionInfoW.restype = wintypes.BOOL
    api.VerQueryValueW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR,
                                 ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.UINT)]
    api.VerQueryValueW.restype = wintypes.BOOL
    ignored = wintypes.DWORD()
    size = api.GetFileVersionInfoSizeW(str(path), ctypes.byref(ignored))
    if not size:
        raise ctypes.WinError(ctypes.get_last_error())
    buffer = ctypes.create_string_buffer(size)
    if not api.GetFileVersionInfoW(str(path), 0, size, buffer):
        raise ctypes.WinError(ctypes.get_last_error())
    pointer = ctypes.c_void_p()
    length = wintypes.UINT()
    if not api.VerQueryValueW(buffer, "\\", ctypes.byref(pointer), ctypes.byref(length)):
        raise ctypes.WinError(ctypes.get_last_error())
    if length.value < 13 * 4:
        raise ValueError("版本资源 VS_FIXEDFILEINFO 不完整")
    words = ctypes.cast(pointer, ctypes.POINTER(wintypes.DWORD))
    if words[0] != 0xFEEF04BD:
        raise ValueError("版本资源签名无效")
    return (words[2] >> 16, words[2] & 65535, words[3] >> 16, words[3] & 65535)


def _disk(root):
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetVolumePathNameW.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD]
    kernel.GetVolumePathNameW.restype = wintypes.BOOL
    kernel.GetVolumeInformationW.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD,
                                             ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(wintypes.DWORD),
                                             ctypes.POINTER(wintypes.DWORD), wintypes.LPWSTR, wintypes.DWORD]
    kernel.GetVolumeInformationW.restype = wintypes.BOOL
    kernel.GetDiskFreeSpaceExW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_ulonglong),
                                         ctypes.POINTER(ctypes.c_ulonglong), ctypes.POINTER(ctypes.c_ulonglong)]
    kernel.GetDiskFreeSpaceExW.restype = wintypes.BOOL
    existing = Path(root).absolute()
    while not existing.exists():
        if existing.parent == existing:
            raise OSError("构建目录没有可访问的现存父目录")
        existing = existing.parent
    if not existing.is_dir():
        raise OSError("构建目录或最近父路径不是目录")
    # resolve 先解析 junction，再让 Windows 解析挂载点所属卷；不能只取盘符。
    existing = existing.resolve(strict=True)
    volume = ctypes.create_unicode_buffer(32768)
    if not kernel.GetVolumePathNameW(str(existing), volume, len(volume)):
        raise ctypes.WinError(ctypes.get_last_error())
    filesystem = ctypes.create_unicode_buffer(256)
    if not kernel.GetVolumeInformationW(volume.value, None, 0, None, None, None,
                                         filesystem, len(filesystem)):
        raise ctypes.WinError(ctypes.get_last_error())
    free, total, unused = (ctypes.c_ulonglong() for _ in range(3))
    if not kernel.GetDiskFreeSpaceExW(str(existing), ctypes.byref(free), ctypes.byref(total), ctypes.byref(unused)):
        raise ctypes.WinError(ctypes.get_last_error())
    return volume.value, filesystem.value, free.value, total.value


def _ram():
    class MemoryStatus(ctypes.Structure):
        _fields_ = [("length", wintypes.DWORD), ("load", wintypes.DWORD)] + [
            (name, ctypes.c_ulonglong) for name in
            ("total_physical", "available_physical", "total_page", "available_page",
             "total_virtual", "available_virtual", "available_extended")]
    status = MemoryStatus()
    status.length = ctypes.sizeof(status)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GlobalMemoryStatusEx.argtypes = [ctypes.POINTER(MemoryStatus)]
    kernel.GlobalMemoryStatusEx.restype = wintypes.BOOL
    if not kernel.GlobalMemoryStatusEx(ctypes.byref(status)):
        raise ctypes.WinError(ctypes.get_last_error())
    return status.total_physical, status.available_physical


def _visual_studio():
    installer = Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "Microsoft Visual Studio/Installer/vswhere.exe"
    if not installer.is_file():
        raise OSError("缺少 Visual Studio Installer/vswhere.exe，无法确认 VS2022 组件")
    result = _run([str(installer), "-products", "*", "-version", "[17.14,18.0)",
                   "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
                   "Microsoft.VisualStudio.Component.VC.ATL", "Microsoft.VisualStudio.Component.VC.ATLMFC",
                   "-format", "json", "-utf8"])
    if result.returncode:
        raise OSError("vswhere 无法查询 VS2022 安装")
    installations = json.loads(result.stdout)
    errors = []
    for installation in sorted(installations, key=lambda item: _version(item.get("installationVersion", "")), reverse=True):
        path = Path(installation["installationPath"])
        version_file = path / "VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt"
        try:
            toolset = version_file.read_text(encoding="utf-8-sig").strip()
            if not re.fullmatch(r"14\.\d+\.\d+", toolset):
                raise ValueError("MSVC 默认工具集版本无效")
            compiler = path / "VC/Tools/MSVC" / toolset
            required = [compiler / item for item in (
                "bin/Hostx64/x64/cl.exe", "bin/Hostx64/x64/link.exe", "bin/Hostx64/x64/lib.exe",
                "include/vector", "lib/x64/libcmt.lib", "atlmfc/include/atlbase.h",
                "atlmfc/include/afxwin.h", "atlmfc/lib/x64/atls.lib")]
            required.append(path / "VC/Auxiliary/Build/vcvars64.bat")
            missing = [str(item) for item in required if not item.is_file()]
            if not list((compiler / "atlmfc/lib/x64").glob("mfc*.lib")):
                missing.append(str(compiler / "atlmfc/lib/x64/mfc*.lib"))
            if missing:
                errors.append("缺少 " + ", ".join(missing))
                continue
            return path, compiler, installation["installationVersion"]
        except (OSError, ValueError) as error:
            errors.append(str(error))
    raise OSError("未找到完整 VS2022 17.14+、MSVC x64、ATL/MFC" + (": " + "; ".join(errors) if errors else ""))


def diagnose(root: Path, requirements: dict) -> dict:
    """返回全部检查和仅供子进程使用的环境；普通缺失前提不会抛异常。"""
    checks = []
    environment = os.environ.copy()
    environment.update(DEPOT_TOOLS_WIN_TOOLCHAIN="0", DEPOT_TOOLS_UPDATE="0")

    def record(name, ok, detail):
        checks.append({"name": name, "ok": bool(ok), "detail": str(detail)})

    def inspect(name, operation):
        try:
            operation()
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
            record(name, False, str(error))

    record("python", sys.version_info >= (3, 11) and sys.maxsize > 2**32,
           f"Python {platform.python_version()}, {ctypes.sizeof(ctypes.c_void_p) * 8}-bit; 驱动要求 Python 3.11+ x64（hashlib.file_digest）")
    for name, args in (("git", ["--version"]), ("cmake", ["--version"])):
        def tool_check(name=name, args=args):
            executable = shutil.which(name)
            if not executable:
                record(name, False, "PATH 中未找到 " + name)
                return
            result = _run([executable, *args])
            # 不回显任意工具输出或环境；仅提取版本号及可执行文件路径。
            version = _version(result.stdout)
            record(name, result.returncode == 0 and bool(version),
                   f"{executable}; version={'.'.join(map(str, version)) or 'unknown'}; exit={result.returncode}")
        inspect(name, tool_check)
    if sys.platform != "win32":
        record("windows", False, "构建仅支持 Windows 10+ x64；当前平台 " + sys.platform)
        return {"ok": False, "checks": checks, "environment": environment}
    def windows_check():
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        # SYSTEM_INFO 前缀中的架构字段来自内核，不依赖可覆盖的环境变量。
        class ProcessorInfo(ctypes.Structure):
            _fields_ = [("architecture", wintypes.WORD), ("reserved", wintypes.WORD),
                        ("page_size", wintypes.DWORD), ("minimum_address", ctypes.c_void_p),
                        ("maximum_address", ctypes.c_void_p), ("processor_mask", ctypes.c_size_t),
                        ("processor_count", wintypes.DWORD), ("processor_type", wintypes.DWORD),
                        ("allocation_granularity", wintypes.DWORD), ("processor_level", wintypes.WORD),
                        ("processor_revision", wintypes.WORD)]
        info = ProcessorInfo()
        kernel.GetNativeSystemInfo.argtypes = [ctypes.POINTER(ProcessorInfo)]
        kernel.GetNativeSystemInfo.restype = None
        kernel.GetNativeSystemInfo(ctypes.byref(info))
        version = sys.getwindowsversion()
        record("windows", version.major >= 10 and info.architecture == 9,
               f"Windows {version.major}.{version.minor}.{version.build}; native_architecture={info.architecture} (x64=9)")
    inspect("windows", windows_check)

    def disk_check():
        volume, filesystem, free, total = _disk(root)
        minimum = int(requirements.get("disk_bytes", 100_000_000_000))
        record("disk", filesystem.upper() == "NTFS" and free >= minimum,
               f"volume={volume}; filesystem={filesystem}; available={free}; total={total}; required={minimum}; 必须 NTFS")
    inspect("disk", disk_check)

    def ram_check():
        total, available = _ram()
        minimum = int(requirements.get("ram_bytes", 8_000_000_000))
        record("ram", total >= minimum, f"physical={total}; available={available}; required={minimum}")
    inspect("ram", ram_check)

    def vs_check():
        path, compiler, version = _visual_studio()
        environment.update(vs2022_install=str(path), GYP_MSVS_OVERRIDE_PATH=str(path),
                           GYP_MSVS_VERSION="2022", VisualStudioVersion="17.0")
        environment["PATH"] = str(compiler / "bin/Hostx64/x64") + os.pathsep + environment.get("PATH", "")
        record("msvc", True, f"VS2022 {version}; {path}; MSVC {compiler.name}; x64 + ATL/MFC")
    inspect("msvc", vs_check)

    sdk_roots = []
    selected_sdk = []
    def sdk_check():
        revision = str(requirements.get("sdk", "10.0.26100.7705"))
        packages = _sdk_packages()
        # MSI DisplayVersion 的 10.1 不是 SDK 10.0 修订，必须核实产品名称。
        matches = [(name, version) for name, version in packages if _version(name) == _version(revision)]
        record("sdk_revision", bool(matches),
               f"required={revision}; " + ("; ".join(f"{name} (MSI {version})" for name, version in packages) or "未找到 SDK 卸载注册信息"))
        for row in _registry_values(r"SOFTWARE\Microsoft\Windows Kits\Installed Roots", ["KitsRoot10"]):
            value = row.get("KitsRoot10")
            if value and Path(value) not in sdk_roots:
                sdk_roots.append(Path(value))
        for value in (os.environ.get("WindowsSdkDir"), os.environ.get("WINDOWSSDKDIR")):
            if value and Path(value) not in sdk_roots:
                sdk_roots.append(Path(value))
        default = Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "Windows Kits/10"
        if default not in sdk_roots:
            sdk_roots.append(default)
        sdk_version = ".".join(revision.split(".")[:3]) + ".0"
        missing_reports = []
        for path in sdk_roots:
            required = [f"Include/{sdk_version}/{item}" for item in
                        ("um/Windows.h", "shared/sdkddkver.h", "ucrt/stdio.h", "winrt/windows.foundation.h")]
            required += [f"Lib/{sdk_version}/{item}" for item in
                         ("um/x64/kernel32.lib", "um/x64/user32.lib", "ucrt/x64/ucrt.lib")]
            required += [f"bin/{sdk_version}/x64/{item}" for item in ("rc.exe", "midl.exe", "mt.exe")]
            missing = [item for item in required if not (path / item).is_file()]
            if not missing:
                selected_sdk.append(path)
                environment.update(WINDOWSSDKDIR=str(path), WindowsSdkDir=str(path) + "\\", WindowsSDKVersion=sdk_version + "\\")
                record("sdk_artifacts", True, f"{path}; headers/libs/tools={sdk_version}（目录版本不作为安装修订证据）")
                return
            missing_reports.append(f"{path}: " + ", ".join(missing))
        record("sdk_artifacts", False, "; ".join(missing_reports))
    inspect("sdk", sdk_check)

    def debugging_check():
        minimum = _version(requirements.get("debugging_tools", "10.0.26100.3323"))
        candidates = [path / "Debuggers/x64/dbghelp.dll" for path in sdk_roots]
        details = []
        found = False
        for candidate in dict.fromkeys(candidates):
            if not candidate.is_file():
                details.append(str(candidate) + ": missing")
                continue
            try:
                version = _file_version(candidate)
                details.append(str(candidate) + ": " + ".".join(map(str, version)))
                # 其他 SDK 目录里的 DLL 不能证明构建实际使用的 SDK 完整。
                found = found or (version >= minimum and candidate.parent.parent.parent in selected_sdk)
            except (OSError, ValueError) as error:
                details.append(str(candidate) + ": " + str(error))
        record("debugging_tools", found,
               "required>=" + ".".join(map(str, minimum)) + "; " + ("; ".join(details) or "未找到 Windows Kits Debuggers x64"))
    inspect("debugging_tools", debugging_check)
    return {"ok": all(check["ok"] for check in checks), "checks": checks, "environment": environment}
