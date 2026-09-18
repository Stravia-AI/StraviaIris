//! sys crate 与最终客户端构建脚本共用的 SDK 校验和链接装配。
//!
//! 职责(只读校验 + 输出链接指令;绝不下载、替换或修改 SDK 内容,
//! 也没有任何回退路径):
//! 1. 定位 SDK:显式 `IRIS_SDK_DIR`,缺省时仅接受本仓库构建生成的
//!    `<workspace>/out/sdk`;
//! 2. 解析并校验 `iris-sdk.json`(schema_version / target /
//!    engine_build_id / files 哈希表 / link 要求),清单契约见
//!    local://iris-sdk-contract.json,由 NativeSdk 在安装后生成;
//! 3. 用 PowerShell `Get-FileHash` 单次批量校验清单内全部文件的实际
//!    SHA-256(stdlib 无 SHA-256,且不允许新增 crypto 依赖);
//! 4. 校验 `include/iris_build_id.h` 内嵌 build ID 与清单一致;
//! 5. 校验 `link.crt == "static"`(工作区已固定 +crt-static,混用即失败)
//!    并按清单输出链接指令:stravia_iris.dll 的导入库 + 可选的系统/
//!    delay-load 要求(全部经 token 校验,杜绝链接器参数注入)。wrapper、
//!    libcef 与系统库已由 SDK DLL 内部消化,清单 link 段通常为空。
//!
//! 注意:cargo 的 `rustc-link-arg` 只作用于本包自身的最终产物,
//! `/DELAYLOAD:*` 必须由最终客户端的 build.rs 输出；MSVC 不支持把它
//! 放进 COFF 对象的 linker pragma。`rustc-link-lib` 与
//! `rustc-link-search` 正常向下传递。此模块不属于运行时公共 API。

use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// SDK 清单文件名(位于 SDK 根;清单自身不计入 files)。
const MANIFEST_NAME: &str = "iris-sdk.json";
/// 内嵌 build ID 的头文件(以 SDK 根为基准的相对路径)。
const BUILD_ID_HEADER: &str = "include/iris_build_id.h";
/// 导入库所在目录。
const LIB_DIR: &str = "lib";
/// stravia_iris.dll 的导入库(实现内部消化 wrapper/libcef/系统库)。
const SDK_LIB_STEM: &str = "stravia_iris";
/// 与计划/工作区一致的目标三元组;不一致即拒绝。
const TARGET_TRIPLE: &str = "x86_64-pc-windows-msvc";
/// 清单必须登记的核心交付物;缺失即拒绝链接。
const REQUIRED_FILES: [&str; 5] = [
    "include/stravia_iris.h",
    BUILD_ID_HEADER,
    "bin/stravia_iris.dll",
    "lib/stravia_iris.lib",
    "lib/libcef.lib",
];
/// 单次 PowerShell 批量哈希的文件数上限(避免超长环境变量)。
const HASH_BATCH: usize = 64;

pub fn configure(final_artifact: bool) {
    if env::var("TARGET").as_deref() != Ok(TARGET_TRIPLE) {
        panic!("iris-sys: 仅支持 {TARGET_TRIPLE}");
    }
    if !env::var("CARGO_CFG_TARGET_FEATURE")
        .unwrap_or_default()
        .split(',')
        .any(|feature| feature == "crt-static")
    {
        panic!("iris-sys: 调用方必须使用 -C target-feature=+crt-static");
    }
    let sdk_dir = resolve_sdk_dir();

    let manifest_path = sdk_dir.join(MANIFEST_NAME);
    let manifest_text = fs::read_to_string(&manifest_path).unwrap_or_else(|error| {
        panic!(
            "iris-sys: 无法读取 SDK 清单 {}: {error}",
            manifest_path.display()
        )
    });
    let manifest: serde_json::Value =
        serde_json::from_str(&manifest_text).unwrap_or_else(|error| {
            panic!(
                "iris-sys: SDK 清单 {} 不是合法 JSON: {error}",
                manifest_path.display()
            )
        });

    if manifest
        .get("schema_version")
        .and_then(serde_json::Value::as_i64)
        != Some(1)
    {
        panic!(
            "iris-sys: SDK 清单 schema_version 必须为 1,实际为 {:?}",
            manifest.get("schema_version")
        );
    }
    if manifest.get("target").and_then(serde_json::Value::as_str) != Some(TARGET_TRIPLE) {
        panic!(
            "iris-sys: SDK 清单 target 必须为 {TARGET_TRIPLE},实际为 {:?}",
            manifest.get("target").and_then(serde_json::Value::as_str)
        );
    }
    let engine_build_id = manifest
        .get("engine_build_id")
        .and_then(serde_json::Value::as_str)
        .and_then(expect_hex64)
        .unwrap_or_else(|| panic!("iris-sys: SDK 清单 engine_build_id 必须是 64 位小写十六进制"));
    // include_str 的路径相对本模块，两个调用方都绑定同一实际引擎产物；
    // Cargo 同时跟踪该输入，不从客户端目录猜测另一份 build ID。
    let binding_id = include_str!("engine-build-id.txt");
    if expect_hex64(binding_id.trim()) != Some(engine_build_id) {
        panic!("iris-sys: SDK engine build ID 与绑定支持的引擎不一致");
    }

    let files = expect_file_hashes(manifest.get("files"));
    for relative in files.keys() {
        println!(
            "cargo:rerun-if-changed={}",
            sdk_dir.join(relative).display()
        );
    }
    for required in REQUIRED_FILES {
        if !files.contains_key(required) {
            panic!("iris-sys: SDK 清单缺少核心交付物登记: {required}");
        }
    }

    let link = expect_link(manifest.get("link"));

    // build ID 头与清单必须一致(头由 native CMake 从引擎清单生成,
    // native 库内嵌同一预期值;此处再做一次独立比对)。
    let header_path = sdk_dir.join(BUILD_ID_HEADER);
    let header_text = fs::read_to_string(&header_path).unwrap_or_else(|error| {
        panic!(
            "iris-sys: 无法读取 build ID 头 {}: {error}",
            header_path.display()
        )
    });
    let header_id = parse_build_id_header(&header_text).unwrap_or_else(|| {
        panic!(
            "iris-sys: {} 中未找到唯一一行 `#define IRIS_ENGINE_BUILD_ID \"<64 位小写十六进制>\"`",
            header_path.display()
        )
    });
    if header_id != engine_build_id {
        panic!(
            "iris-sys: build ID 头与清单不一致:\n  header   {header_id}\n  manifest {engine_build_id}"
        );
    }

    verify_hashes(&sdk_dir, &files);

    // ---- 链接装配(全部 token 先校验再输出) ----
    let lib_dir = sdk_dir.join(LIB_DIR);
    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    // stravia_iris.lib 是 stravia_iris.dll 的导入库;运行时需要 DLL 与
    // 客户端产物同目录(由分发组装器放置,不做运行时探测回退)。
    println!("cargo:rustc-link-lib=dylib={SDK_LIB_STEM}");

    let mut stems: Vec<String> = Vec::new();
    for stem in &link.system_libraries {
        if !valid_link_token(stem) {
            panic!("iris-sys: SDK 清单 system_libraries 含非法 token: {stem:?}");
        }
        stems.push(stem.clone());
    }
    for stem in &stems {
        println!("cargo:rustc-link-lib=dylib={stem}");
    }
    if !link.delay_load_dlls.is_empty() {
        // /DELAYLOAD 需要 delayimp;若清单未自带则补齐。
        if !stems
            .iter()
            .any(|stem| stem.eq_ignore_ascii_case("delayimp"))
        {
            println!("cargo:rustc-link-lib=dylib=delayimp");
        }
        for dll in &link.delay_load_dlls {
            if !valid_link_token(dll) {
                panic!("iris-sys: SDK 清单 delay_load_dlls 含非法 token: {dll:?}");
            }
            if final_artifact {
                println!("cargo:rustc-link-arg=/DELAYLOAD:{dll}");
            }
        }
    }

    println!("cargo:rerun-if-env-changed=IRIS_SDK_DIR");
    println!("cargo:rerun-if-changed={}", manifest_path.display());
    println!("cargo:rerun-if-changed={}", header_path.display());
}

/// 定位 SDK 目录:显式 `IRIS_SDK_DIR` 优先;未设置时仅接受本仓库
/// cmake --install 生成的 `<workspace>/out/sdk`。目录不存在即失败,
/// 不做任何下载或探测回退。
fn resolve_sdk_dir() -> PathBuf {
    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR 未设置"));
    let workspace_root = manifest_dir
        .parent()
        .and_then(Path::parent)
        .unwrap_or_else(|| panic!("无法从 {} 推导工作区根目录", manifest_dir.display()))
        .to_path_buf();
    let configured = env::var_os("IRIS_SDK_DIR").map(PathBuf::from);
    let dir = match configured {
        Some(dir) => dir,
        None => workspace_root.join("out").join("sdk"),
    };
    let dir = if dir.is_absolute() {
        dir
    } else {
        env::current_dir()
            .unwrap_or_else(|error| panic!("iris-sys: 无法获取当前目录: {error}"))
            .join(dir)
    };
    if !dir.is_dir() {
        panic!(
            "iris-sys: SDK 目录不存在: {}\n  通过 IRIS_SDK_DIR 显式指定已安装的 SDK,或先用本仓库 \
             `cmake --install out/native --DCMAKE_INSTALL_PREFIX=<out/sdk>` 生成;\n  构建脚本不做任何下载或回退。",
            dir.display()
        );
    }
    dir
}

/// 校验并返回 `files` 映射:相对路径(POSIX 分隔符、不含 `..`/盘符/
/// 反斜杠)→ 64 位小写十六进制 SHA-256。
fn expect_file_hashes(value: Option<&serde_json::Value>) -> BTreeMap<String, String> {
    let Some(map) = value.and_then(serde_json::Value::as_object) else {
        panic!("iris-sys: SDK 清单缺少 files 对象");
    };
    let mut files = BTreeMap::new();
    for (relative, hash) in map {
        if relative == MANIFEST_NAME {
            panic!("iris-sys: SDK 清单 files 不得登记清单自身");
        }
        if relative.is_empty()
            || relative.starts_with('/')
            || relative.contains('\\')
            || relative.contains(':')
            || Path::new(relative).components().any(|component| {
                matches!(
                    component,
                    std::path::Component::ParentDir | std::path::Component::RootDir
                )
            })
        {
            panic!("iris-sys: SDK 清单含非法相对路径: {relative:?}");
        }
        let Some(hash) = hash.as_str().and_then(expect_hex64) else {
            panic!("iris-sys: SDK 清单文件 {relative} 的哈希必须是 64 位小写十六进制");
        };
        files.insert(relative.clone(), hash.to_string());
    }
    files
}

struct LinkRequirements {
    system_libraries: Vec<String>,
    delay_load_dlls: Vec<String>,
}

/// 校验并返回 link 要求。crt 必须为 "static":工作区 .cargo/config.toml
/// 已固定 +crt-static,SDK DLL 也以 /MT 构建(CEF 分发仅支持静态 CRT)。
fn expect_link(value: Option<&serde_json::Value>) -> LinkRequirements {
    let Some(object) = value.and_then(serde_json::Value::as_object) else {
        panic!("iris-sys: SDK 清单缺少 link 对象");
    };
    let crt = object
        .get("crt")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    if crt != "static" {
        panic!(
            "iris-sys: SDK 清单 link.crt 必须为 \"static\",实际为 {crt:?};工作区已固定 +crt-static"
        );
    }
    let string_list = |key: &str| -> Vec<String> {
        object
            .get(key)
            .and_then(serde_json::Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .map(|entry| {
                        entry
                            .as_str()
                            .unwrap_or_else(|| {
                                panic!("iris-sys: SDK 清单 link.{key} 含非字符串项: {entry}")
                            })
                            .to_string()
                    })
                    .collect()
            })
            .unwrap_or_else(|| panic!("iris-sys: SDK 清单 link.{key} 必须是字符串数组"))
    };
    LinkRequirements {
        system_libraries: string_list("system_libraries"),
        delay_load_dlls: string_list("delay_load_dlls"),
    }
}

/// 链接 token 白名单:仅字母/数字/下划线/点/连字符,禁止路径分隔符、
/// `..`、前导 `-`(防止借清单注入链接器参数)。
fn valid_link_token(token: &str) -> bool {
    !token.is_empty()
        && !token.starts_with('-')
        && !token.starts_with('/')
        && !token.contains("..")
        && token
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

fn expect_hex64(value: &str) -> Option<&str> {
    let is_hex64 = value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if is_hex64 { Some(value) } else { None }
}

/// 从 `#define IRIS_ENGINE_BUILD_ID "<64 位小写十六进制>"` 单行提取 build
/// ID;必须恰好出现一次。
fn parse_build_id_header(text: &str) -> Option<String> {
    let mut found: Option<String> = None;
    for line in text.lines() {
        let trimmed = line.trim();
        let Some(rest) = trimmed.strip_prefix("#define") else {
            continue;
        };
        let rest = rest.trim_start();
        let Some(value) = rest.strip_prefix("IRIS_ENGINE_BUILD_ID") else {
            continue;
        };
        if !value.starts_with(char::is_whitespace) {
            continue;
        }
        let value = value.trim();
        if !value.starts_with('"') {
            continue;
        }
        let Some(end) = value[1..].find('"') else {
            continue;
        };
        let id = &value[1..1 + end];
        if expect_hex64(id).is_none() {
            continue;
        }
        if found.replace(id.to_string()).is_some() {
            return None;
        }
    }
    found
}

/// 批量校验清单内全部文件的实际 SHA-256;任一不匹配即失败。
fn verify_hashes(sdk_dir: &Path, files: &BTreeMap<String, String>) {
    let mut batch: Vec<(String, String, PathBuf)> = Vec::with_capacity(HASH_BATCH);
    let flush = |batch: &mut Vec<(String, String, PathBuf)>| {
        if batch.is_empty() {
            return;
        }
        let paths: Vec<PathBuf> = batch.iter().map(|(_, _, path)| path.clone()).collect();
        let actual = hash_files(&paths);
        for (index, (relative, expected, _)) in batch.iter().enumerate() {
            match actual.get(index) {
                Some(hash) if hash == expected => {}
                Some(hash) => panic!(
                    "iris-sys: 文件哈希与清单不一致: {relative}\n  manifest {expected}\n  actual   {hash}"
                ),
                None => panic!("iris-sys: 哈希校验结果缺失: {relative}"),
            }
        }
        batch.clear();
    };

    for (relative, expected) in files {
        let path = sdk_dir.join(relative);
        if !path.is_file() {
            panic!(
                "iris-sys: 清单登记的文件不存在: {relative} ({})",
                path.display()
            );
        }
        batch.push((relative.clone(), expected.clone(), path));
        if batch.len() >= HASH_BATCH {
            flush(&mut batch);
        }
    }
    flush(&mut batch);
}

/// 用 PowerShell `Get-FileHash` 计算一批文件的 SHA-256。
///
/// 注入防护:文件路径只经进程环境变量传递，脚本为固定的 Command 参数，
/// 输出仅含序号与十六进制哈希(无路径),因此任何非 ASCII 路径也不会
/// 影响解析;不把路径拼进命令行。
fn hash_files(paths: &[PathBuf]) -> Vec<String> {
    let mut inputs: Vec<String> = Vec::with_capacity(paths.len());
    for path in paths {
        let Some(text) = path.to_str() else {
            panic!(
                "iris-sys: SDK 路径必须是 UTF-8 可表示: {}",
                path.to_string_lossy()
            );
        };
        if text.contains('\n') || text.contains('\r') {
            panic!("iris-sys: SDK 路径不允许包含换行: {text}");
        }
        inputs.push(text.to_string());
    }
    let joined = inputs.join("\n");

    // 脚本逐行(按序号)输出 "<index> <sha256>"。
    let script = concat!(
        "$ErrorActionPreference = 'Stop'\n",
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n",
        "$files = $env:IRIS_HASH_INPUTS -split \"`n\"\n",
        "for ($i = 0; $i -lt $files.Count; $i++) {\n",
        "  $h = (Get-FileHash -LiteralPath $files[$i] -Algorithm SHA256).Hash.ToLowerInvariant()\n",
        "  Write-Output (\"{0} {1}\" -f $i, $h)\n",
        "}\n"
    );

    // -Command - 的逐行 stdin 解释依赖多行语句终止空行；直接提交完整脚本。
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("IRIS_HASH_INPUTS", &joined)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap_or_else(|error| {
            panic!("iris-sys: 无法启动 PowerShell(Get-FileHash)进行哈希校验: {error}")
        });
    if !output.status.success() {
        panic!(
            "iris-sys: PowerShell 哈希校验失败(exit {}):\n{}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut hashes: Vec<Option<String>> = vec![None; paths.len()];
    for line in stdout.lines() {
        let line = line.trim();
        let Some((index, hash)) = line.split_once(' ') else {
            continue;
        };
        let Ok(index) = index.parse::<usize>() else {
            continue;
        };
        if index >= hashes.len() || hashes[index].is_some() {
            panic!("iris-sys: 哈希输出序号异常: {line}");
        }
        hashes[index] = Some(hash.to_ascii_lowercase());
    }
    hashes
        .into_iter()
        .enumerate()
        .map(|(index, hash)| hash.unwrap_or_else(|| panic!("iris-sys: 哈希输出缺少序号 {index}")))
        .collect()
}
