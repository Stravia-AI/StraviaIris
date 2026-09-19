// StraviaIris 原生共享 SDK 的公共 C ABI。
//
// 本头文件固定 SDK 对业务方（Rust facade 与 C 接入方）的全部契约：
//   - 只使用固定宽度整数与 size_t，不跨堆释放，不跨 C++ STL/CEF ABI；
//   - 输入视图（字符串/UTF-16 路径）借用至函数返回；配置在 iris_run 开始时
//     深拷贝；事件 payload 缓冲借用至事件回调返回；
//   - 所有 C++ 对象与临时分配均由本库在原侧创建与释放。
//
// 生命周期约束（违反时函数返回明确错误状态，不崩溃、不静默）：
//   - 必须先经 bootstrapc.exe + 客户端 DLL 的标准入口进入
//     iris_bootstrap_main（沙箱信息与版本信息由 bootstrap 提供）；
//   - CefExecuteProcess 在 application_main 之前执行；只有 browser 进程路径
//     才调用 application_main；
//   - iris_run 只能成功进入一次，且必须在 bootstrap 主线程（即 CEF UI 线程）
//     调用；其余会话函数只能在事件回调内（UI 线程）调用；
//   - 消息循环退出条件：显式 shutdown 并 drain 完所有 browser 关闭事件，或
//     曾创建过 browser 且最后一个关闭事件已交付、无存活/待定 browser。
//
// 该 ABI 与 Rust 层 repr(C) 声明一一对应；枚举编号为固定契约，不得重排。

#ifndef STRAVIA_IRIS_STRAVIA_IRIS_H_
#define STRAVIA_IRIS_STRAVIA_IRIS_H_

#include <stddef.h>
#include <stdint.h>

// SDK 以 stravia_iris.dll 交付：构建侧由 CMake 自动定义
// stravia_iris_EXPORTS 导出符号，消费侧经 lib/stravia_iris.lib 导入库解析。
#if defined(_WIN32)
#  if defined(stravia_iris_EXPORTS)
#    define IRIS_EXPORT __declspec(dllexport)
#  else
#    define IRIS_EXPORT __declspec(dllimport)
#  endif
#else
#  define IRIS_EXPORT
#endif

#ifdef __cplusplus
extern "C" {
#endif

///
/// 不透明会话句柄。仅在事件回调参数中出现；业务方不得解引用、不得缓存到
/// 回调之外使用（跨线程/跨回调使用返回 IRIS_NOT_READY）。
///
typedef struct iris_session_t iris_session_t;

///
/// 单调递增且从不复用的浏览器公开 ID。0 表示“与此事件无关”。
///
typedef uint64_t iris_browser_id_t;

///
/// 单调递增且从不复用的 CDP 命令公开请求 ID。0 表示“与此事件无关”。
///
typedef uint64_t iris_request_id_t;

///
/// UTF-8 字节视图。len 为字节数。空视图允许 {NULL, 0}；len 非 0 时 data
/// 必须可读 len 字节且不得包含嵌入 NUL。借用至函数返回。
///
typedef struct iris_utf8_t {
  const uint8_t* data;
  size_t len;
} iris_utf8_t;

///
/// UTF-16 视图（Windows 路径保真）。len 为 UTF-16 code unit 数。空视图允许
/// {NULL, 0}；len 非 0 时 data 必须可读 len 个 code unit 且不得包含嵌入
/// NUL。借用至函数返回。
///
typedef struct iris_utf16_t {
  const uint16_t* data;
  size_t len;
} iris_utf16_t;

///
/// 统一状态。code=0 成功；其余按 Rust 错误枚举顺序从 1 编号；
/// native_code 保留 CEF/操作系统的原始错误码，无原始值时为 0。
///
typedef struct iris_status_t {
  int32_t code;
  int32_t native_code;
} iris_status_t;

///
/// 状态码（编号为固定契约，与 Rust Error 枚举顺序一致）。
///
typedef enum iris_status_code_t {
  IRIS_OK = 0,
  IRIS_NOT_IN_BOOTSTRAP = 1,        ///< 未经有效 bootstrap 入口或线程错误
  IRIS_ALREADY_RUN = 2,             ///< iris_bootstrap_main/iris_run 重复进入
  IRIS_INVALID_ARGUMENT = 3,        ///< 参数、视图、JSON/URL 非法
  IRIS_PROFILE_UNAVAILABLE = 4,     ///< profile 前置条件（字体）缺失
  IRIS_VERSION_MISMATCH = 5,        ///< 引擎 build ID/CEF 版本不匹配
  IRIS_INITIALIZATION_FAILED = 6,   ///< CefInitialize 失败或启动校验失败
  IRIS_NOT_READY = 7,               ///< 会话未就绪（Ready 前）或 ID 处于 Pending
  IRIS_BROWSER_CLOSED = 8,          ///< 目标 browser 不存在或已关闭
  IRIS_PROTOCOL = 9,                ///< CDP 协议层错误（命令结果失败）
  IRIS_COMMAND_CANCELLED = 10,      ///< browser 关闭/detach/crash 取消命令
  IRIS_TIMEOUT = 11,                ///< 命令 30 秒无结果
  IRIS_RENDERER_TERMINATED = 12,    ///< 渲染进程终止相关失败
  IRIS_CALLBACK_PANICKED = 13,      ///< 宿主回调 panic 后强制关闭
} iris_status_code_t;

///
/// 事件种类（编号为固定契约，与 Rust Event 枚举顺序一致，从 1 起）。
///
typedef enum iris_event_kind_t {
  IRIS_EVENT_READY = 1,               ///< payload "{}"
  IRIS_EVENT_BROWSER_CREATED = 2,     ///< payload "{}"
  IRIS_EVENT_BROWSER_CLOSED = 3,      ///< payload "{}"
  IRIS_EVENT_COMMAND_RESULT = 4,      ///< payload 为 CEF 原 result/error object
  IRIS_EVENT_PROTOCOL_EVENT = 5,      ///< payload 为 CDP {method,params}
  IRIS_EVENT_LOAD_ERROR = 6,          ///< payload 为 {code,message,url}
  IRIS_EVENT_RENDERER_TERMINATED = 7, ///< payload 为 {status,error_code}
} iris_event_kind_t;

///
/// 事件回调的返回值。其他值按 IRIS_INVALID_ARGUMENT 关闭运行。
///
#define IRIS_CALLBACK_CONTINUE 0u
#define IRIS_CALLBACK_SHUTDOWN 1u
#define IRIS_CALLBACK_PANICKED 2u

///
/// 事件。不相关 ID 为 0。payload_json 借用至回调返回。
///
typedef struct iris_event_t {
  uint32_t kind;  ///< iris_event_kind_t
  iris_browser_id_t browser;
  iris_request_id_t request;
  iris_status_t status;  ///< 事件附加状态（多数为成功）
  iris_utf8_t payload_json;
} iris_event_t;

///
/// 事件回调。native 在 UI 线程任务中串行调用，禁止重入。返回值语义见
/// IRIS_CALLBACK_* 宏：SHUTDOWN/PANICKED 强制关闭所有 browser 并 drain。
///
typedef uint32_t (*iris_event_fn)(iris_session_t* session,
                                  const iris_event_t* event,
                                  void* user_data);

///
/// 窗口模式。
///
#define IRIS_WINDOW_MODE_WINDOWED 0u
#define IRIS_WINDOW_MODE_WINDOWLESS 1u

///
/// 运行配置。iris_run 开始时深拷贝；cache_path 必须为非空绝对路径；
/// remote_debugging_port 为 0（禁用）或 1..65535；timezone_utf8 为空表示跟随
/// 宿主，否则必须是合法 IANA 时区名（由引擎在创建网页前校验）。
/// 初始 viewport 固定 1280x720；不提供任意 Chromium flag 透传。
///
typedef struct iris_config_t {
  size_t struct_size;
  uint64_t seed;  ///< 指纹种子，允许 0
  uint32_t window_mode;
  uint32_t remote_debugging_port;
  iris_utf16_t cache_path_utf16;
  iris_utf8_t timezone_utf8;
} iris_config_t;

///
/// bootstrap 客户端入口。由客户端 DLL 的 RunConsoleMain 转交调用：
///   1. 校验一次性进入、application_main/sandbox_info/version_info 非空；
///   2. 校验编译头与 libcef 的 API hash/版本/沙箱兼容哈希及私有 build ID；
///   3. 执行 CefExecuteProcess——子进程直接返回其退出码，不调用
///      application_main；browser 进程路径保存主线程 scoped 上下文后调用
///      application_main(user_data)，其返回值作为进程退出码。
/// 非法进入返回 iris_status_code_t 错误码（非 0）。禁止从 DllMain 调用。
///
IRIS_EXPORT int32_t iris_bootstrap_main(int argc,
                            char** argv,
                            void* sandbox_info,
                            const void* version_info,
                            int32_t (*application_main)(void*),
                            void* user_data);

///
/// 初始化 CEF 并运行消息循环，阻塞至运行结束。事件经 callback 串行交付；
/// 首个事件为 READY（在 WebRTC 偏好校验与可选调试端点结果确认之后）。
/// 必须在 iris_bootstrap_main 的 browser 路径内、bootstrap 主线程调用。
///
IRIS_EXPORT iris_status_t iris_run(const iris_config_t* config,
                       iris_event_fn callback,
                       void* user_data);

///
/// 创建 browser（Alloy 风格，1280x720 初始 viewport；windowless 为 OSR）。
/// profile 为空视图时使用全局默认上下文；非空时必须是 1..64 个
/// ASCII 字母/数字/`-`/`_` 字符，映射为
/// <cache_path>/iris-profile-<profile> 下独立的 request context：cookie、
/// 站点存储与 HTTP 缓存按 profile 隔离，同 profile 的 browser（含其
/// popup）共享同一上下文。指纹 seed 与时区为会话级，不随 profile 变化；
/// 同一具名目录不能被多个运行实例同时占用。
/// ID 在对应的 IRIS_EVENT_BROWSER_CREATED 交付前处于 Pending，提前操作返回
/// IRIS_NOT_READY。同步校验或创建失败（参数非法、隔离上下文创建失败、
/// CreateBrowserSync 返回空）立即返回 IRIS_INVALID_ARGUMENT 或
/// IRIS_INITIALIZATION_FAILED，不发布有效 ID。具名 profile 的上下文
/// 异步初始化，初始化或偏好下发失败、或随后的创建失败经
/// IRIS_EVENT_LOAD_ERROR（IRIS_INITIALIZATION_FAILED）通知，该 Pending
/// ID 随之作废；网站 popup 的异步创建失败同样经此通知。
/// 必须在事件回调内调用。
///
IRIS_EXPORT iris_status_t iris_create_browser(iris_session_t* session,
                                  iris_utf8_t url,
                                  iris_utf8_t profile,
                                  iris_browser_id_t* browser_out);

///
/// 在指定 browser 上执行 CDP 命令。method 非空；params_json 必须是 JSON
/// object（空视图等价于 "{}"），非法输入同步返回 IRIS_INVALID_ARGUMENT。
/// 每条命令 30 秒无结果以 IRIS_EVENT_COMMAND_RESULT（IRIS_TIMEOUT）交付并
/// 移除，迟到结果被忽略。browser 关闭/agent detach/renderer crash 取消该
/// browser 全部待定命令（IRIS_COMMAND_CANCELLED）。必须在事件回调内调用。
///
IRIS_EXPORT iris_status_t iris_command(iris_session_t* session,
                           iris_browser_id_t browser,
                           iris_utf8_t method,
                           iris_utf8_t params_json,
                           iris_request_id_t* request_out);

///
/// 请求关闭指定 browser（程序化强制关闭）。BrowserClosed 事件交付后该 ID
/// 失效。对未知/已关闭 ID 返回 IRIS_BROWSER_CLOSED。必须在事件回调内调用。
///
IRIS_EXPORT iris_status_t iris_close_browser(iris_session_t* session,
                                 iris_browser_id_t browser);

///
/// 请求关闭整个运行：强制关闭全部存活 browser（含待定 popup），在全部
/// OnBeforeClose 完成并交付关闭事件后退出消息循环。必须在事件回调内调用。
///
IRIS_EXPORT iris_status_t iris_request_shutdown(iris_session_t* session);

#ifdef __cplusplus
}  // extern "C"
#endif

#endif  // STRAVIA_IRIS_STRAVIA_IRIS_H_
