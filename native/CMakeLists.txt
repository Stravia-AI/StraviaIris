# StraviaIris 原生共享 SDK 构建。
#
# 输入：
#   CEF_ROOT（缓存变量或环境变量）——打补丁引擎的标准分发根目录，包含
#   include/、Release/、Resources/、cmake/、iris-distribution.json 与
#   include/iris_profile_data.h。原版 Official 基线没有 engine_build_id，
#   在配置阶段即被拒绝。
#
# 输出（cmake --install）：
#   include/stravia_iris.h、include/iris_build_id.h、bin/stravia_iris.dll
#   （本库实现；libcef_dll_wrapper、libcef 导入库、系统库与 delay-load
#   全部 PRIVATE 消化）、lib/stravia_iris.lib（DLL 导入库）、
#   lib/libcef.lib（引擎导入库副本）、lib/cmake/StraviaIris/
#   （find_package 包）以及 SDK 根目录的 iris-sdk.json 清单（按真实文件
#   哈希生成）。
#
# 约定：仅 Windows x64 + MSVC；静态 CRT（与 CEF 分发的
# CEF_RUNTIME_LIBRARY_FLAG=/MT 一致）；不混用 Debug/Release 归档。

cmake_minimum_required(VERSION 3.21)

project(stravia_iris LANGUAGES C CXX)

if(NOT WIN32)
  message(FATAL_ERROR "StraviaIris 原生 SDK 仅支持 Windows。")
endif()

if(NOT CEF_ROOT)
  if(DEFINED ENV{CEF_ROOT})
    file(TO_CMAKE_PATH "$ENV{CEF_ROOT}" CEF_ROOT)
  endif()
endif()
if(NOT CEF_ROOT)
  message(FATAL_ERROR "必须通过 -DCEF_ROOT=<打补丁引擎标准分发根目录> 或环境变量指定 CEF_ROOT。")
endif()
if(NOT IS_DIRECTORY "${CEF_ROOT}/cmake")
  message(FATAL_ERROR "CEF_ROOT 未指向标准分发根目录（缺少 cmake/）：${CEF_ROOT}")
endif()

# 使用标准分发自带的 CMake 配置（获得 libcef 导入库路径、编译约定、
# delay-load 列表与 libcef_dll_wrapper 子工程）。
list(APPEND CMAKE_MODULE_PATH "${CEF_ROOT}/cmake")
find_package(CEF REQUIRED)
if(NOT MSVC OR NOT PROJECT_ARCH STREQUAL "x86_64" OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
  message(FATAL_ERROR "StraviaIris 仅支持 Windows x64 MSVC。")
endif()
if(NOT USE_SANDBOX OR USE_INSTALLER)
  message(FATAL_ERROR "SDK 要求启用 sandbox 且不配置 bootstrap installer。")
endif()
if(NOT CEF_RUNTIME_LIBRARY_FLAG STREQUAL "/MT")
  message(FATAL_ERROR "SDK 与 CEF wrapper 必须使用静态 CRT /MT。")
endif()

# ---------------------------------------------------------------------------
# 引擎分发清单校验与 build ID 头生成
# ---------------------------------------------------------------------------

set(IRIS_ENGINE_MANIFEST "${CEF_ROOT}/iris-distribution.json")
if(NOT EXISTS "${IRIS_ENGINE_MANIFEST}")
  message(FATAL_ERROR
    "缺少引擎分发清单 ${IRIS_ENGINE_MANIFEST}。原版 CEF 分发没有该清单，"
    "不能用于构建本 SDK；请先以 tools/engine.py 产出打补丁分发。")
endif()
file(READ "${IRIS_ENGINE_MANIFEST}" _iris_manifest_json)
string(JSON IRIS_ENGINE_BUILD_ID ERROR_VARIABLE _iris_json_error
       GET "${_iris_manifest_json}" engine_build_id)
string(LENGTH "${IRIS_ENGINE_BUILD_ID}" _iris_build_id_length)
if(_iris_json_error OR NOT _iris_build_id_length EQUAL 64
   OR IRIS_ENGINE_BUILD_ID MATCHES "[^0-9a-f]")
  message(FATAL_ERROR
    "引擎分发清单缺少合法的 engine_build_id（64 位小写十六进制）。"
    "原版基线被显式拒绝。")
endif()
string(JSON _iris_schema GET "${_iris_manifest_json}" schema_version)
if(NOT _iris_schema EQUAL 1)
  message(FATAL_ERROR "不支持的引擎清单 schema_version。")
endif()
string(JSON _iris_file_count LENGTH "${_iris_manifest_json}" files)
if(_iris_file_count LESS 1)
  message(FATAL_ERROR "引擎清单 files 不得为空。")
endif()
math(EXPR _iris_file_last "${_iris_file_count} - 1")
foreach(_index RANGE 0 ${_iris_file_last})
  string(JSON _relative MEMBER "${_iris_manifest_json}" files ${_index})
  if(_relative MATCHES "(^/|:|\\\\|(^|/)\\.\\.(/|$))")
    message(FATAL_ERROR "引擎清单含非法相对路径：${_relative}")
  endif()
  string(JSON _expected GET "${_iris_manifest_json}" files "${_relative}")
  if(NOT EXISTS "${CEF_ROOT}/${_relative}" OR IS_DIRECTORY "${CEF_ROOT}/${_relative}")
    message(FATAL_ERROR "引擎清单文件缺失：${_relative}")
  endif()
  file(SHA256 "${CEF_ROOT}/${_relative}" _actual)
  if(NOT _actual STREQUAL _expected)
    message(FATAL_ERROR "引擎文件与清单 SHA-256 不匹配：${_relative}")
  endif()
  set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${CEF_ROOT}/${_relative}")
endforeach()
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${IRIS_ENGINE_MANIFEST}")

if(NOT EXISTS "${CEF_ROOT}/include/iris_profile_data.h")
  message(FATAL_ERROR
    "缺少 ${CEF_ROOT}/include/iris_profile_data.h（由 profiles/windows-desktop.json"
    " 生成的 profile 唯一数据来源）。")
endif()

configure_file(cmake/iris_build_id.h.in
               "${CMAKE_CURRENT_BINARY_DIR}/generated/iris_build_id.h" @ONLY)

# ---------------------------------------------------------------------------
# 编译目标
# ---------------------------------------------------------------------------

# 静态 CRT：与 CEF 分发一致（cef_variables.cmake 的 /MT）。
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

if(NOT EXISTS "${CEF_LIBCEF_DLL_WRAPPER_PATH}/CMakeLists.txt")
  message(FATAL_ERROR
    "标准分发缺少 libcef_dll/CMakeLists.txt：${CEF_LIBCEF_DLL_WRAPPER_PATH}")
endif()
add_subdirectory("${CEF_LIBCEF_DLL_WRAPPER_PATH}" libcef_dll_wrapper)

add_library(stravia_iris SHARED
  src/bootstrap.cc
  src/engine_link.cc
  src/session.cc
)

target_include_directories(stravia_iris PRIVATE
  "${CEF_INCLUDE_PATH}"
  "${CMAKE_CURRENT_SOURCE_DIR}/include"
  "${CMAKE_CURRENT_SOURCE_DIR}/src"
  "${CMAKE_CURRENT_BINARY_DIR}/generated"
)

set(_iris_defines ${CEF_COMPILER_DEFINES})
# engine/wrapper 保持上游配置；SDK 自身必须能捕获 C++ consumer 的异常。
list(REMOVE_ITEM _iris_defines "_HAS_EXCEPTIONS=0")
target_compile_definitions(stravia_iris PRIVATE ${_iris_defines} _HAS_EXCEPTIONS=1
  $<$<CONFIG:Release>:${CEF_COMPILER_DEFINES_RELEASE}>)

# 复用 CEF 分发的编译约定（含逐配置 /MT、/std:c++20、安全加固选项）。
target_compile_options(stravia_iris PRIVATE
  ${CEF_COMPILER_FLAGS} ${CEF_CXX_COMPILER_FLAGS} /EHsc
  $<$<AND:$<COMPILE_LANGUAGE:CXX>,$<CONFIG:Debug>>:${CEF_COMPILER_FLAGS_DEBUG}>
  $<$<AND:$<COMPILE_LANGUAGE:CXX>,$<CONFIG:Release>>:${CEF_COMPILER_FLAGS_RELEASE}>
)

# delay-load 集合沿用 CEF 对客户端的要求；剔除 libcef.dll——SDK 静态导入
# 引擎（无 installer 模式，缺失即显式加载失败，不引入下载回退）。
set(IRIS_DELAYLOAD_DLLS "")
set(IRIS_DELAYLOAD_FLAGS "")
foreach(_flag ${CEF_DELAYLOAD_FLAGS})
  string(REGEX REPLACE "^/DELAYLOAD:" "" _dll "${_flag}")
  if(NOT _dll STREQUAL "libcef.dll")
    list(APPEND IRIS_DELAYLOAD_DLLS "${_dll}")
    list(APPEND IRIS_DELAYLOAD_FLAGS "${_flag}")
  endif()
endforeach()

# SDK DLL 内部消化的链接要求：wrapper、libcef 导入库、CEF 标准系统库与
# delayimp 都 PRIVATE，消费方只面对 stravia_iris 导入库。
set(_iris_private_libs ${CEF_STANDARD_LIBS})
separate_arguments(_iris_default_system_libs WINDOWS_COMMAND "${CMAKE_CXX_STANDARD_LIBRARIES}")
list(APPEND _iris_private_libs ${_iris_default_system_libs} dwrite.lib)
if(IRIS_DELAYLOAD_DLLS)
  list(APPEND _iris_private_libs delayimp.lib)
endif()
list(REMOVE_DUPLICATES _iris_private_libs)

target_link_libraries(stravia_iris PRIVATE
  libcef_dll_wrapper
  "${CEF_LIB_RELEASE}"
  ${_iris_private_libs}
)
target_link_options(stravia_iris PRIVATE ${IRIS_DELAYLOAD_FLAGS})

# ---------------------------------------------------------------------------
# 安装布局与消费方链接契约
# ---------------------------------------------------------------------------

# 消费方链接契约：SDK 是共享库，wrapper/libcef/系统库/delay-load 已全部
# PRIVATE 进 stravia_iris.dll；清单 link 段对消费方不再有额外要求。
set(IRIS_SYSTEM_LIBS_JSON "")
set(IRIS_DELAYLOAD_DLLS_JSON "")

set(IRIS_CRT "static")
set(IRIS_SDK_TARGET "x86_64-pc-windows-msvc")

include(CMakePackageConfigHelpers)
configure_package_config_file(cmake/StraviaIrisConfig.cmake.in
               "${CMAKE_CURRENT_BINARY_DIR}/StraviaIrisConfig.cmake"
               INSTALL_DESTINATION lib/cmake/StraviaIris)
configure_file(cmake/StraviaIrisConfigVersion.cmake.in
               "${CMAKE_CURRENT_BINARY_DIR}/StraviaIrisConfigVersion.cmake" @ONLY)

install(FILES
  "${CMAKE_CURRENT_SOURCE_DIR}/include/stravia_iris.h"
  "${CMAKE_CURRENT_BINARY_DIR}/generated/iris_build_id.h"
  DESTINATION include)

# libcef.lib：引擎导入库（不是静态实现），随 SDK 分发。
install(FILES "${CEF_LIB_RELEASE}" DESTINATION lib)

install(FILES
  "${CMAKE_CURRENT_BINARY_DIR}/StraviaIrisConfig.cmake"
  "${CMAKE_CURRENT_BINARY_DIR}/StraviaIrisConfigVersion.cmake"
  DESTINATION lib/cmake/StraviaIris)

# 共享库：stravia_iris.dll → bin/，其导入库 stravia_iris.lib → lib/。
install(TARGETS stravia_iris
  RUNTIME DESTINATION bin
  ARCHIVE DESTINATION lib)

# SDK 清单最后生成（对已安装文件计算真实 SHA-256）。
install(CODE
  "set(IRIS_SDK_ROOT \"\${CMAKE_INSTALL_PREFIX}\")
   set(IRIS_ENGINE_BUILD_ID \"${IRIS_ENGINE_BUILD_ID}\")
   set(IRIS_SDK_TARGET \"${IRIS_SDK_TARGET}\")
   set(IRIS_CRT \"${IRIS_CRT}\")
   set(IRIS_SYSTEM_LIBS_JSON [==[${IRIS_SYSTEM_LIBS_JSON}]==])
   set(IRIS_DELAYLOAD_DLLS_JSON [==[${IRIS_DELAYLOAD_DLLS_JSON}]==])
   include(\"${CMAKE_CURRENT_SOURCE_DIR}/cmake/iris_generate_manifest.cmake\")")
