//! bootstrap 装配(私有,供 [`crate::export_app!`] 展开)。
//!
//! 流程:第一步即转交 native `iris_bootstrap_main`——子进程路径直接
//! 返回 `CefExecuteProcess` 退出码,不执行业务入口;只有 browser 路径
//! 才调用业务函数(其内部再调用 [`crate::run`] 驱动消息循环)。
//! 业务函数的错误与 panic 都被就地捕获并转换为进程退出码
//! (错误 = 1,panic = 101),不跨 FFI unwind,不吞错。
//! sandbox/version 指针原样转发,业务代码无需接触。

use std::ffi::{c_char, c_int, c_void};
use std::io::Write;
use std::panic::catch_unwind;

use crate::error::Error;
use crate::run::{drop_panic_payload, panic_message};

/// `export_app!` 生成的 `RunConsoleMain` 导出落到这里;业务代码不直接
/// 调用。
///
/// # Safety
/// 必须由匹配的 bootstrapc.exe 在主线程调用；argc/argv、sandbox_info
/// 和 version_info 必须满足 CEF bootstrap 的有效性与借用期契约。
#[doc(hidden)]
pub unsafe fn run_console_main(
    mut entry: fn() -> Result<(), Error>,
    argc: c_int,
    argv: *mut *mut c_char,
    sandbox_info: *mut c_void,
    version_info: *const c_void,
) -> c_int {
    // native 同步调用业务入口，不保留该栈上函数指针。
    let user_data: *mut c_void = std::ptr::from_mut(&mut entry).cast();
    match catch_unwind(|| {
        // Safety:argc/argv/sandbox_info/version_info 由 bootstrapc.exe
        // 提供;本函数不解引用它们,只原样转发给 native(由其按 CEF
        // 契约消费)。application_main 是 Rust 侧定义的 C ABI 回调。
        unsafe {
            iris_sys::iris_bootstrap_main(
                argc,
                argv,
                sandbox_info,
                version_info,
                application_main,
                user_data,
            )
        }
    }) {
        Ok(exit_code) => exit_code,
        Err(payload) => {
            let _ = writeln!(
                std::io::stderr(),
                "iris: application bootstrap panicked: {}",
                panic_message(&payload)
            );
            drop_panic_payload(payload);
            101
        }
    }
}

/// browser 路径的业务入口 trampoline。
extern "C" fn application_main(user_data: *mut c_void) -> c_int {
    // Safety:user_data 指向尚未返回的 run_console_main 栈上的函数指针。
    let entry = unsafe { *user_data.cast::<fn() -> Result<(), Error>>() };
    match catch_unwind(entry) {
        Ok(Ok(())) => 0,
        Ok(Err(error)) => {
            let _ = writeln!(
                std::io::stderr(),
                "iris: application returned error: {error}"
            );
            1
        }
        Err(payload) => {
            let _ = writeln!(
                std::io::stderr(),
                "iris: application panicked: {}",
                panic_message(&payload)
            );
            drop_panic_payload(payload);
            101
        }
    }
}
