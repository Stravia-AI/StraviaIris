//! StraviaIris 原生共享 SDK 的私有 C ABI 声明。
//!
//! 仅声明 `native/include/stravia_iris.h` 公开子集的最小 FFI,只供
//! `crates/iris` 内部使用;业务代码不得依赖本 crate,也不存在任何
//! raw CEF 类型的 re-export。结构体字段、顺序与编号由计划第 5 节与
//! `local://iris-sdk-contract.json` 固定,修改前必须同步 native 头文件。
//!
//! ABI 约定(与计划一致):
//! - 视图为计长借用:`iris_utf8_t`/`iris_utf16_t` 不含 NUL 终止符,
//!   输入借用至函数返回,事件缓冲区借用至回调返回;空视图允许 null+0;
//! - 跨 ABI 不释放对端内存:C++ 对象与临时分配始终由 native 侧释放;
//! - `iris_status_t.code`=0 成功,其余按 `iris::ErrorKind` 顺序自 1 编号,
//!   `native_code` 保留 CEF/OS 原始错误码。

use std::ffi::{c_char, c_int, c_void};

/// `iris_status_t.code`:操作成功。
pub const IRIS_OK: i32 = 0;

/// `iris_config_t.window_mode`:独立窗口(native 0)。
pub const WINDOW_MODE_WINDOWED: u32 = 0;
/// `iris_config_t.window_mode`:离屏渲染 OSR(native 1)。
pub const WINDOW_MODE_WINDOWLESS: u32 = 1;

/// `iris_event_t.kind`:与 `iris::Event` 变体顺序一致,自 1 编号。
pub mod event_kind {
    /// 会话就绪;payload 恒为 `{}`。
    pub const READY: u32 = 1;
    /// browser 创建成功;payload 恒为 `{}`。
    pub const BROWSER_CREATED: u32 = 2;
    /// browser 已关闭;payload 恒为 `{}`。
    pub const BROWSER_CLOSED: u32 = 3;
    /// CDP 命令结果;payload 为 CEF 原 result/error object。
    pub const COMMAND_RESULT: u32 = 4;
    /// CDP 协议事件;payload 为原 CDP `{method, params}`。
    pub const PROTOCOL_EVENT: u32 = 5;
    /// 加载失败;payload 为 `{code, message, url}`。
    pub const LOAD_ERROR: u32 = 6;
    /// renderer 终止;payload 为 `{status, error_code}`。
    pub const RENDERER_TERMINATED: u32 = 7;
}

/// 事件回调返回值:继续运行。
pub const CALLBACK_CONTINUE: u32 = 0;
/// 事件回调返回值:请求关闭全部 browser 并 drain 至 OnBeforeClose。
pub const CALLBACK_SHUTDOWN: u32 = 1;
/// 事件回调返回值:业务回调 panic;native 强制关闭并 drain 后以
/// CallbackPanicked 结束 `iris_run`。
pub const CALLBACK_PANICKED: u32 = 2;

/// opaque `iris_browser_id_t`:单调递增、从不复用。
pub type IrisBrowserId = u64;
/// opaque `iris_request_id_t`。
pub type IrisRequestId = u64;

/// `iris_utf8_t`:计长 UTF-8 字节视图,不含 NUL 终止符。
#[repr(C)]
#[derive(Clone, Copy)]
pub struct IrisUtf8View {
    pub data: *const u8,
    pub len: usize,
}

/// `iris_utf16_t`:计长 UTF-16 code unit 视图,len 以 code unit 计,
/// 不含终止符;保留 Windows 原生 WTF-16,不做 lossy 转换。
#[repr(C)]
#[derive(Clone, Copy)]
pub struct IrisUtf16View {
    pub data: *const u16,
    pub len: usize,
}

/// `iris_status_t`:code=0 成功,其余按 `iris::ErrorKind` 顺序自 1 编号;
/// native_code 保留 CEF/OS 原始错误码(无原始错误时为 0)。
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IrisStatus {
    pub code: i32,
    pub native_code: i32,
}

/// `iris_config_t`:字段顺序由 C ABI 固定,不可调整。
#[repr(C)]
#[derive(Clone, Copy)]
pub struct IrisConfig {
    pub struct_size: usize,
    pub seed: u64,
    pub window_mode: u32,
    /// 0=disabled;其余为 1..=65535。
    pub remote_debugging_port: u32,
    pub cache_path_utf16: IrisUtf16View,
    /// 空=跟随宿主时区;否则为合法 IANA zone。
    pub timezone_utf8: IrisUtf8View,
}

/// `iris_event_t`:payload_json 在回调返回前保持有效(借用)。
#[repr(C)]
pub struct IrisEvent {
    pub kind: u32,
    pub browser: IrisBrowserId,
    pub request: IrisRequestId,
    pub status: IrisStatus,
    pub payload_json: IrisUtf8View,
}

/// opaque `iris_session_t`:仅以指针形式跨 ABI;不可构造、不可解引用,
/// 有效性由 native 保证(仅在该 session 的 `iris_run` 回调期间有效)。
#[repr(C)]
pub struct IrisSession {
    _private: [u8; 0],
}

/// `int32_t (*)(void*)`:browser 路径执行的业务入口,由 native 在
/// `CefExecuteProcess` 判定为主进程后调用。
pub type IrisApplicationMain = extern "C" fn(user_data: *mut c_void) -> c_int;

/// `iris_event_fn`:native 在 UI 线程串行调用,禁止重入。
pub type IrisEventCallback = extern "C" fn(
    session: *mut IrisSession,
    event: *const IrisEvent,
    user_data: *mut c_void,
) -> u32;

// 编译期布局断言:x64 下 usize/u64 对齐 8、u32 对齐 4。
// 断言失败即说明本声明与 C ABI 不再一致,必须先修声明。
const _: () = assert!(std::mem::size_of::<IrisUtf8View>() == 16);
const _: () = assert!(std::mem::size_of::<IrisUtf16View>() == 16);
const _: () = assert!(std::mem::size_of::<IrisStatus>() == 8);
const _: () = assert!(std::mem::size_of::<IrisConfig>() == 56);
const _: () = assert!(std::mem::size_of::<IrisEvent>() == 48);

unsafe extern "C" {
    /// bootstrap 入口:先执行 `CefExecuteProcess`,子进程直接返回退出码;
    /// 只有 browser 路径才调用 `application_main`,并保存主线程 scoped
    /// entry context 供 `iris_run` 使用。version_info 为 CEF
    /// `cef_version_info_t*`,由 bootstrapc.exe 提供,本侧不解引用。
    pub fn iris_bootstrap_main(
        argc: c_int,
        argv: *mut *mut c_char,
        sandbox_info: *mut c_void,
        version_info: *const c_void,
        application_main: IrisApplicationMain,
        user_data: *mut c_void,
    ) -> c_int;

    /// 驱动 CEF 初始化、消息循环与关闭;全部在该(bootstrap 主)线程。
    /// callback 由 native 串行调用;返回 0/1/2,见 `CALLBACK_*`。
    pub fn iris_run(
        config: *const IrisConfig,
        callback: IrisEventCallback,
        user_data: *mut c_void,
    ) -> IrisStatus;

    /// 显式创建 browser(`CefBrowserHost::CreateBrowserSync`):
    /// 返回的 ID 在 BrowserCreated 事件交付前处于 Pending。
    pub fn iris_create_browser(
        session: *mut IrisSession,
        url: IrisUtf8View,
        browser: *mut IrisBrowserId,
    ) -> IrisStatus;

    /// 执行 CDP 命令:method 非空、params 必须为 JSON object;
    /// 公开 u64 request id 与 native int message id 由 native 映射。
    pub fn iris_command(
        session: *mut IrisSession,
        browser: IrisBrowserId,
        method: IrisUtf8View,
        params_json: IrisUtf8View,
        request: *mut IrisRequestId,
    ) -> IrisStatus;

    /// 关闭指定 browser(程序化强制关闭)。
    pub fn iris_close_browser(session: *mut IrisSession, browser: IrisBrowserId) -> IrisStatus;

    /// 请求关闭整个会话:关闭全部 browser 并 drain 至 OnBeforeClose。
    pub fn iris_request_shutdown(session: *mut IrisSession) -> IrisStatus;
}
