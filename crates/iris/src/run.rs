//! `run`:驱动整个会话的唯一入口。
//!
//! native 侧按“先排队事件,再在 UI task drain 中串行调用 host 回调”
//! 交付事件:回调不重入,`FnMut` 借用不会别名。业务回调的 panic 在
//! trampoline 内 `catch_unwind` 捕获并向 native 返回
//! `CALLBACK_PANICKED`:native 强制关闭全部 browser 并 drain 至
//! OnBeforeClose 之后,`iris_run` 才返回;此时 `run` 才以
//! `CallbackPanicked` 报告,绝不吞错、绝不跨 FFI unwind。

use std::any::Any;
use std::ffi::c_void;
use std::ops::ControlFlow;
use std::panic::{AssertUnwindSafe, catch_unwind};

use crate::config::Config;
use crate::error::{Error, ErrorKind, check_status};
use crate::event::{self, Event};
use crate::session::Session;

/// 运行会话至全部 browser 关闭或业务请求退出。
///
/// 必须在 [`crate::export_app!`] 生成的 browser 路径内调用(否则 native
/// 返回 `NotInBootstrap`);同一进程只允许运行一次(`AlreadyRun`)。
/// 事件在 UI 线程串行交付;handler 返回
/// [`ControlFlow::Continue`] 继续事件循环,返回 [`ControlFlow::Break`]
/// 请求关闭全部 browser 并等待 drain(期间仍会交付剩余关闭事件)。
///
/// handler panic:panic 被捕获并打印,待 native 完成资源关闭后
/// 本函数返回 `Err(CallbackPanicked)`。
pub fn run<F>(config: Config, handler: F) -> Result<(), Error>
where
    F: for<'a> FnMut(&mut Session<'a>, Event) -> ControlFlow<()>,
{
    let native = config.into_native()?;
    let native_view = native.as_raw();
    let mut handler = handler;
    let mut state = RunState {
        handler: &mut handler,
        panic: None,
        error: None,
    };
    // Safety:user_data 指向本栈上的 state,在 iris_run 同步返回前一直
    // 存活;native 保证同一 run 的事件回调串行且不重入,因此 state 的
    // &mut 借用不会别名。
    let user_data: *mut c_void = std::ptr::from_mut(&mut state).cast();
    let status = unsafe { iris_sys::iris_run(&native_view, event_trampoline::<F>, user_data) };
    if let Some(payload) = state.panic.take() {
        // panic 路径:native 已完成 drain 与 CefShutdown,这里才报告。
        let message = panic_message(&payload).to_string();
        drop_panic_payload(payload);
        return Err(
            Error::new(ErrorKind::CallbackPanicked, message).with_native_code(status.native_code)
        );
    }
    if let Some(error) = state.error.take() {
        return Err(error);
    }
    check_status(status, "run failed")
}

/// trampoline 与 run 共享的可变状态。
struct RunState<'handler, F>
where
    F: for<'a> FnMut(&mut Session<'a>, Event) -> ControlFlow<()>,
{
    handler: &'handler mut F,
    /// 任意用户 payload 的析构也可能 panic，必须延迟到 native 已关闭。
    panic: Option<Box<dyn Any + Send>>,
    error: Option<Error>,
}

/// native 事件回调:解码、构造借用受限的 Session、驱动业务回调,
/// 并把回调结果映射为 native 返回值(0/1/2)。
///
/// 必须声明为 `extern "C"`:fn 指针不存在跨 ABI 的隐式转换,
/// `iris_run` 的回调参数类型即本签名。
extern "C" fn event_trampoline<F>(
    session: *mut iris_sys::IrisSession,
    raw_event: *const iris_sys::IrisEvent,
    user_data: *mut c_void,
) -> u32
where
    F: for<'a> FnMut(&mut Session<'a>, Event) -> ControlFlow<()>,
{
    // Safety:user_data 由 run() 传入,指向同步调用期间存活的 RunState;
    // native 保证回调串行且不重入,此处 &mut 不会别名。
    let Some(state) = (unsafe { (user_data as *mut RunState<'_, F>).as_mut() }) else {
        // 契约之外(伪造 user_data):保守请求关闭。
        return iris_sys::CALLBACK_SHUTDOWN;
    };
    if state.panic.is_some() {
        return iris_sys::CALLBACK_PANICKED;
    }
    if state.error.is_some() {
        return iris_sys::CALLBACK_SHUTDOWN;
    }

    match catch_unwind(AssertUnwindSafe(|| {
        if session.is_null() || raw_event.is_null() {
            return Err(Error::contract(
                "native callback contains a null session/event",
            ));
        }
        // Safety:native 保证事件在回调期间有效，payload 解码为 owned 数据。
        let decoded = event::decode(unsafe { &*raw_event })?;
        // Session 的生命周期被钉在本次回调内，不能逃逸。
        let mut session = Session::from_raw(session);
        Ok((state.handler)(&mut session, decoded))
    })) {
        Ok(Ok(ControlFlow::Continue(()))) => iris_sys::CALLBACK_CONTINUE,
        Ok(Ok(ControlFlow::Break(()))) => iris_sys::CALLBACK_SHUTDOWN,
        Ok(Err(error)) => {
            state.error = Some(error);
            iris_sys::CALLBACK_SHUTDOWN
        }
        Err(payload) => {
            state.panic = Some(payload);
            iris_sys::CALLBACK_PANICKED
        }
    }
}

/// 提取 panic 消息(`&str`/`String`,其余统一说明)。
pub(crate) fn panic_message(payload: &Box<dyn Any + Send>) -> &str {
    if let Some(text) = payload.downcast_ref::<&str>() {
        text
    } else if let Some(text) = payload.downcast_ref::<String>() {
        text
    } else {
        "panic with non-string payload"
    }
}

/// 用户可 panic_any 一个 Drop 也会 panic 的值；二次 payload 不能递归析构。
pub(crate) fn drop_panic_payload(payload: Box<dyn Any + Send>) {
    if let Err(secondary) = catch_unwind(AssertUnwindSafe(|| drop(payload))) {
        std::mem::forget(secondary);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    fn ready() -> iris_sys::IrisEvent {
        iris_sys::IrisEvent {
            kind: iris_sys::event_kind::READY,
            browser: 0,
            request: 0,
            status: iris_sys::IrisStatus {
                code: 0,
                native_code: 0,
            },
            payload_json: iris_sys::IrisUtf8View {
                data: b"{}".as_ptr(),
                len: 2,
            },
        }
    }

    fn deliver<F>(state: &mut RunState<'_, F>, event: *const iris_sys::IrisEvent) -> u32
    where
        F: for<'a> FnMut(&mut Session<'a>, Event) -> ControlFlow<()>,
    {
        // 仅测 facade 边界；handler 不调用会话方法，该哨兵永不解引用。
        event_trampoline::<F>(
            std::ptr::NonNull::dangling().as_ptr(),
            event,
            std::ptr::from_mut(state).cast(),
        )
    }

    #[test]
    fn malformed_callback_latches_failure_and_stops_handler_during_drain() {
        let calls = Cell::new(0);
        let mut handler = |_: &mut Session<'_>, _: Event| {
            calls.set(calls.get() + 1);
            ControlFlow::Continue(())
        };
        let mut state = RunState {
            handler: &mut handler,
            panic: None,
            error: None,
        };
        assert_eq!(
            deliver(&mut state, std::ptr::null()),
            iris_sys::CALLBACK_SHUTDOWN
        );
        let first_message = state.error.as_ref().unwrap().message().to_string();
        assert_eq!(deliver(&mut state, &ready()), iris_sys::CALLBACK_SHUTDOWN);
        assert_eq!(calls.get(), 0);
        assert_eq!(
            state.error.as_ref().unwrap().kind(),
            ErrorKind::NativeContractViolation
        );
        assert_eq!(state.error.as_ref().unwrap().message(), first_message);
    }

    #[test]
    fn panicking_payload_destructor_cannot_unwind_across_callback() {
        struct PanicOnDrop(Arc<AtomicUsize>);
        impl Drop for PanicOnDrop {
            fn drop(&mut self) {
                self.0.fetch_add(1, Ordering::SeqCst);
                panic!("payload destructor");
            }
        }
        let drops = Arc::new(AtomicUsize::new(0));
        let calls = Cell::new(0);
        let mut handler = |_: &mut Session<'_>, _: Event| -> ControlFlow<()> {
            calls.set(calls.get() + 1);
            std::panic::panic_any(PanicOnDrop(drops.clone()));
        };
        let mut state = RunState {
            handler: &mut handler,
            panic: None,
            error: None,
        };
        assert_eq!(deliver(&mut state, &ready()), iris_sys::CALLBACK_PANICKED);
        assert_eq!(deliver(&mut state, &ready()), iris_sys::CALLBACK_PANICKED);
        assert_eq!(calls.get(), 1);
        assert_eq!(drops.load(Ordering::SeqCst), 0);
        drop_panic_payload(state.panic.take().unwrap());
        assert_eq!(drops.load(Ordering::SeqCst), 1);
    }
}
