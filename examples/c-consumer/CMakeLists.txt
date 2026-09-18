# StraviaIris 独立 C 接入样例：共享库交付的链接证明。
#
# 只通过安装后的 find_package(StraviaIris CONFIG REQUIRED) 链接，不引用
# 引擎源码、不复制 wrapper、不使用任何 CEF 头文件（RunConsoleMain 的
# version_info 参数在本样例中按不透明指针转发）。
#
# 构建：
#   cmake -S examples/c-consumer -B out/c-consumer ^
#     -DStraviaIris_DIR=<absolute out/sdk>/lib/cmake/StraviaIris
#   cmake --build out/c-consumer --config Release
#
# 运行（由 bootstrapc 加载客户端 DLL；stravia_iris.dll 必须与客户端 DLL
# 同目录，运行时目录由分发组装器提供）：
#   bootstrapc.exe --module=iris_c_sample --url=https://example.invalid/ ^
#     --seed=42 --cache-dir=C:\temp\iris-c --headless

cmake_minimum_required(VERSION 3.21)

project(iris_c_consumer LANGUAGES C)

find_package(StraviaIris CONFIG REQUIRED)

# 客户端 DLL：被 bootstrapc.exe 经 --module 加载。
add_library(iris_c_sample MODULE iris_c_sample.c)
target_compile_options(iris_c_sample PRIVATE /utf-8)

target_link_libraries(iris_c_sample PRIVATE StraviaIris::iris)

set_target_properties(iris_c_sample PROPERTIES
  OUTPUT_NAME "iris_c_sample"
  PREFIX "")

# 与 SDK 一致的静态 CRT（包配置亦设置了默认值，此处显式声明）。
set_property(TARGET iris_c_sample PROPERTY
  MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
