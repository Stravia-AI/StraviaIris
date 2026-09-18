# 在安装阶段生成 SDK 根目录的 iris-sdk.json 清单（契约见
# local://iris-sdk-contract.json 的 sdk_distribution 段）。
#
# 输入变量（由 native/CMakeLists.txt 的 install(CODE) 提供）：
#   IRIS_SDK_ROOT             安装根目录
#   IRIS_ENGINE_BUILD_ID      引擎 64 位小写十六进制 build ID
#   IRIS_SDK_TARGET           x86_64-pc-windows-msvc
#   IRIS_CRT                  static
#   IRIS_SYSTEM_LIBS_JSON     消费方额外系统库 stem（已含引号分隔符；可为空）
#   IRIS_DELAYLOAD_DLLS_JSON  消费方 delay-load DLL 名（已含引号分隔符；可为空）
#
# 对已安装文件计算真实 SHA-256；清单自身不计入 files。

set(_iris_manifest_path "${IRIS_SDK_ROOT}/iris-sdk.json")

file(GLOB_RECURSE _iris_files
  LIST_DIRECTORIES FALSE
  RELATIVE "${IRIS_SDK_ROOT}"
  "${IRIS_SDK_ROOT}/*")

list(SORT _iris_files)

set(_iris_pairs "")
foreach(_iris_rel IN LISTS _iris_files)
  if(_iris_rel STREQUAL "iris-sdk.json")
    continue()
  endif()
  if(_iris_rel MATCHES "/iris-sdk\\.json$")
    continue()
  endif()
  file(SHA256 "${IRIS_SDK_ROOT}/${_iris_rel}" _iris_hash)
  list(APPEND _iris_pairs "    \"${_iris_rel}\": \"${_iris_hash}\"")
endforeach()

string(JOIN ",\n" _iris_files_json ${_iris_pairs})

file(WRITE "${_iris_manifest_path}"
"{
  \"schema_version\": 1,
  \"target\": \"${IRIS_SDK_TARGET}\",
  \"engine_build_id\": \"${IRIS_ENGINE_BUILD_ID}\",
  \"files\": {
${_iris_files_json}
  },
  \"link\": {
    \"crt\": \"${IRIS_CRT}\",
    \"system_libraries\": [${IRIS_SYSTEM_LIBS_JSON}],
    \"delay_load_dlls\": [${IRIS_DELAYLOAD_DLLS_JSON}]
  }
}
")

message(STATUS "iris-sdk.json 已生成：${_iris_manifest_path}")
