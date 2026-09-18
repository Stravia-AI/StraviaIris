"""生成已完成补丁应用的 CEF 项目；复用固定上游生成器，不重复应用队列。"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cef", type=Path, required=True)
    parser.add_argument("--configuration", required=True)
    args = parser.parse_args()
    cef = args.cef.resolve()
    src = cef.parent
    sys.path.insert(0, str(cef / "tools"))

    from file_util import make_dir, write_file_if_changed
    from gclient_util import RunAction
    from gn_args import GetAllPlatformConfigs, GetConfigFileContents
    import issue_1999
    from setup_vscode import GetPreferredOutputDirectory, UpdateCompileCommandsJSON

    print("Generating CEF translated files...", flush=True)
    RunAction(str(cef), [sys.executable, "tools/version_manager.py", "-u", "--fast-check"])

    # 参数来源与固定 gclient_hook.py 相同；不另写 CEF 的默认值或约束。
    build_args = {}
    if bool(int(os.environ.get("WIN_CUSTOM_TOOLCHAIN", "0"))):
        for key, variable in (
            ("visual_studio_path", "GYP_MSVS_OVERRIDE_PATH"),
            ("visual_studio_version", "GYP_MSVS_VERSION"),
            ("visual_studio_runtime_dirs", "VS_CRT_ROOT"),
            ("windows_sdk_path", "SDK_ROOT"),
            ("windows_sdk_version", "SDK_VERSION"),
        ):
            build_args[key] = os.environ[variable]
    configs = GetAllPlatformConfigs(build_args)
    if set(configs) != {args.configuration}:
        raise RuntimeError(f"生成配置与锁定目标不符：{list(configs)}")
    preferred = GetPreferredOutputDirectory(configs.keys())
    print("Generating CEF project files...", flush=True)
    output = src / "out" / args.configuration
    make_dir(str(output), False)
    write_file_if_changed(str(output / "args.gn"),
                          GetConfigFileContents(configs[args.configuration]))
    RunAction(str(src), ["gn", "gen", str(Path("out") / args.configuration)])
    issue_1999.apply(str(output))
    if args.configuration == preferred and not UpdateCompileCommandsJSON(
            str(src), str(output), create=False):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
