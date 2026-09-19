//! # iris — StraviaIris 安全 SDK(Windows x64)
//!
//! 原生共享 SDK(`stravia_iris.dll` + `stravia_iris.lib` 导入库,内部消化
//! libcef_dll_wrapper 与 `libcef.lib`)的 safe facade。业务代码只依赖本 crate:
//! 无 handwritten unsafe、无裸 CEF 类型、无 sandbox/version 指针、
//! 不接触 CefRefPtr;所有 unsafe 都在私有 trampoline 内并附有
//! 真实的安全不变量说明。
//!
//! ## 构建
//!
//! 构建时必须提供已安装并校验的 SDK:显式 `IRIS_SDK_DIR`,或本仓库
//! cmake install 生成的 `<workspace>/out/sdk`。`iris-sys` 的构建脚本
//! 会核对 `iris-sdk.json` 清单(schema/目标/build ID/逐文件 SHA-256/
//! 链接要求)并链接 SDK 导入库;任何缺失或不一致都会立即失败——没有下载、
//! 替换或回退。
//!
//! 最终业务 `cdylib` 还必须在自己的 `build.rs` 中引用分发源码的
//! `crates/iris-sys/sdk_link.rs`，调用 `sdk_link::configure(true)`；
//! 可直接沿用 `examples/iris-demo/build.rs` 的结构并调整相对路径。
//! Cargo 不会通过中间 rlib 传递 `cargo:rustc-link-arg`，因此不能省略
//! 这一最终链接步骤。它根据已验证的清单装配 SDK 导入库与
//! delay-load 所需链接参数，而不是在业务源码中手写 pragma。
//!
//! ## 接入
//!
//! cdylib 业务入口用 [`export_app!`] 导出 bootstrapc.exe 期望的标准
//! `RunConsoleMain`;第一步即转交 native bootstrap,子进程路径直接
//! 返回退出码,只有 browser 路径才执行业务函数:
//!
//! 原名 `bootstrapc.exe` 支持 `--module=<DLL 文件名，不含扩展名>`。
//! 重命名的 bootstrap 则只加载与 EXE 同名的 DLL：本分发的
//! `iris-demo.exe` 对应 `iris-demo.dll`，不能用 `--module=iris_demo`
//! 绕过上游的同名约束。
//!
//! ```no_run
//! use iris::{export_app, Config, ControlFlow, Error, Event};
//!
//! fn app() -> Result<(), Error> {
//!     let config = Config::new(std::env::temp_dir().join("iris-demo-cache"), 42)
//!         .timezone("Europe/Berlin".to_string());
//!     iris::run(config, |session, event| match event {
//!         Event::Ready => {
//!             if let Err(error) = session.create_browser("https://example.invalid/") {
//!                 eprintln!("create_browser failed: {error}");
//!                 return ControlFlow::Break(());
//!             }
//!             ControlFlow::Continue(())
//!         }
//!         _ => ControlFlow::Continue(()),
//!     })
//! }
//!
//! export_app!(app);
//! # fn main() {}
//! ```
//!
//! ## 生命周期约束(编译期保证)
//!
//! [`Session`] 只在事件回调内可用:
//!
//! 不能跨线程(`!Send`):
//!
//! ```compile_fail
//! fn require_send<T: Send>() {}
//! require_send::<iris::Session<'static>>();
//! ```
//!
//! 不能共享(`!Sync`):
//!
//! ```compile_fail
//! fn require_sync<T: Sync>() {}
//! require_sync::<iris::Session<'static>>();
//! ```
//!
//! 不能逃逸回调(高阶生命周期约束):
//!
//! ```compile_fail
//! use iris::ControlFlow;
//!
//! let mut stash: Option<&mut iris::Session<'static>> = None;
//! iris::run(
//!     iris::Config::new(".".into(), 0),
//!     |session, _event| {
//!         stash = Some(session);
//!         ControlFlow::Continue(())
//!     },
//! )
//! .ok();
//! ```
//!
//! [`BrowserId`]/[`RequestId`] 可以存储,但每次使用都经 Session 查表
//! 校验(Pending → [`ErrorKind::NotReady`],已关闭/未知 →
//! [`ErrorKind::BrowserClosed`])。
//!
//! ## 事件与错误
//!
//! 七类事件见 [`Event`]；[`ErrorKind`] 前十三类对应 native 状态码，
//! NativeContractViolation 仅在 facade 发现 ABI 违规时使用，
//! Application 用于调用方业务失败；两者均不传回 native。
//! 协议失败保留 native_code 与原始 CDP payload
//! ([`Error::payload`]),native 侧失败对调用方完整可见。
//! 业务入口可用 [`Error::application`] 传播 I/O 或断言失败，
//! 无需提前 `process::exit` 绕过 bootstrap 的作用域清理。
//!
//! ## 外部 CDP
//!
//! 显式设置端口后，客户端连接并控制由 SDK 创建的既有页面。
//! 新 browser 使用 [`Session::create_browser`]（全局默认上下文）或
//! [`Session::create_browser_in_profile`]（具名隔离 profile），
//! 由同一生命周期跟踪。
//! 不承诺 Playwright/Puppeteer 的 launch、newContext 或 newPage：
//! Chrome `Target.createTarget` 可能生成没有 CefBrowser 的 WebContents，
//! 不属于本 SDK 已验证的窗口所有权路径。

mod app;
mod config;
mod error;
mod event;
mod ids;
mod run;
mod session;
mod views;

#[doc(hidden)]
pub use app::run_console_main as __run_console_main;
pub use config::{Config, WindowMode};
pub use error::{Error, ErrorKind};
pub use event::Event;
pub use ids::{BrowserId, RequestId};
pub use run::run;
pub use session::Session;

/// [`std::ops::ControlFlow<()>`]:`Continue(())` 继续事件循环;
/// `Break(())` 请求关闭全部 browser 并等待 drain。
pub use std::ops::ControlFlow;

/// 事件 payload 使用的 JSON 类型;在此 re-export 保证调用方与 facade
/// 使用同一 serde_json 版本。
pub use serde_json;

/// 导出 CEF bootstrapc.exe 期望的标准 `RunConsoleMain` 入口。
///
/// - 入口类型固定为 `fn() -> Result<(), Error>`;
/// - 生成的导出第一步即调用 native bootstrap(`iris_bootstrap_main`):
///   子进程路径直接返回 `CefExecuteProcess` 的退出码,不执行业务入口;
///   只有 browser 路径才调用 `entry`(其内部用 [`run`] 驱动事件循环);
/// - sandbox/version 指针原样转发,业务代码无需编写 unsafe 或接触
///   这些指针;
/// - 业务入口的错误与 panic 就地转换为进程退出码(错误 = 1,
///   panic = 101),不跨 FFI unwind;回调内 panic 由
/// [`run`] 捕获并在 native 完成关闭后以 `CallbackPanicked` 返回。
///
/// # 示例
///
/// ```no_run
/// use iris::{export_app, Error};
///
/// fn app() -> Result<(), Error> {
///     // 配置会话并在 Ready 后创建 browser……
///     # iris::run(iris::Config::new(".".into(), 0), |_session, _event| iris::ControlFlow::Continue(()))
/// }
///
/// export_app!(app);
/// # fn main() {}
/// ```
#[macro_export]
macro_rules! export_app {
    ($entry:path) => {
        #[unsafe(no_mangle)]
        #[allow(non_snake_case)]
        /// # Safety
        /// 仅由匹配的 bootstrapc.exe 调用；所有指针须符合 CEF bootstrap 契约。
        pub unsafe extern "C" fn RunConsoleMain(
            argc: ::std::ffi::c_int,
            argv: *mut *mut ::std::ffi::c_char,
            sandbox_info: *mut ::std::ffi::c_void,
            version_info: *const ::std::ffi::c_void,
        ) -> ::std::ffi::c_int {
            // Safety:导出的入口沿用调用方提供的 CEF bootstrap 前置条件。
            unsafe { $crate::__run_console_main($entry, argc, argv, sandbox_info, version_info) }
        }
    };
}
