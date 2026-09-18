#ifndef STRAVIA_IRIS_ENGINE_PROTOCOL_H_
#define STRAVIA_IRIS_ENGINE_PROTOCOL_H_

#include <cstdint>

namespace iris_engine {

// 私有协议由引擎 build ID 绑定，不属于 SDK 对业务公开的 C ABI。
inline constexpr char kBuildIdSymbol[] = "iris_engine_build_id";
inline constexpr char kDebuggingCallbackSymbol[] =
    "iris_engine_set_debugging_callback";
inline constexpr char kSeedSwitch[] = "iris-seed";
inline constexpr char kTimezoneSwitch[] = "iris-timezone";
inline constexpr std::int32_t kInvalidArgumentExit = 0x49520001;
inline constexpr std::int32_t kProfileUnavailableExit = 0x49520002;

using BuildIdFunction = const char*(__cdecl*)();

// 在 UI 线程交付真实 HTTP 服务启动结果。status=0 表示绑定成功且仅监听
// loopback；非零表示失败，native_error 保留原始错误，无原始错误时为 0。
// port 是实际监听端口。CefInitialize 前注册；UI 线程建立后注册/注销
// 只允许在该线程调用。传入空 callback 注销，必须在 CefShutdown 前注销。
using DebuggingCallback = void(__cdecl*)(std::int32_t status,
                                        std::int32_t native_error,
                                        std::uint32_t port,
                                        void* user_data);
using SetDebuggingCallbackFunction = void(__cdecl*)(DebuggingCallback callback,
                                                  void* user_data);

}  // namespace iris_engine

#endif  // STRAVIA_IRIS_ENGINE_PROTOCOL_H_
