//! 错误模型。
//!
//! 前 13 类错误的顺序由 native C ABI 固定；之后的类别不参与 native
//! 编号。[`Error`] 在类别之外始终保留
//! `native_code`(CEF/OS 原始错误码)与协议失败时的原始 CDP payload,
//! 保证 native 侧失败对调用方完整可见。

use std::fmt;

use serde_json::Value;

use iris_sys::IrisStatus;

/// 前十三类对应 native 状态码 1..=13，之后为 Rust 侧错误。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ErrorKind {
    /// 未经过有效的 bootstrap 入口(`iris_bootstrap_main` 尚未在主线程
    /// 建立 entry context)即调用 `run`。
    NotInBootstrap,
    /// 同一进程内重复 `run`。
    AlreadyRun,
    /// 输入参数非法(路径或时区含 NUL、method 为空、params 不是 JSON
    /// object 等)。
    InvalidArgument,
    /// profile 不可用(例如虚拟字体集合在本机不满足)。
    ProfileUnavailable,
    /// 引擎身份校验失败(CEF API hash / 版本 / build ID 不匹配,
    /// 例如误配了原版 libcef)。
    VersionMismatch,
    /// CEF 或 browser 初始化失败。
    InitializationFailed,
    /// 目标 browser 仍处于 Pending(BrowserCreated 事件尚未交付)。
    NotReady,
    /// 目标 browser 已关闭,或 ID 未知。
    BrowserClosed,
    /// CDP 协议层错误(命令被协议拒绝或返回错误对象)。
    Protocol,
    /// 命令被取消(agent detach、browser 关闭或 renderer 崩溃)。
    CommandCancelled,
    /// 命令 30 秒无结果。
    Timeout,
    /// renderer 进程终止。
    RendererTerminated,
    /// 业务回调 panic:panic 已被捕获,native 完成资源关闭与 drain 后
    /// 由 `run` 返回本错误;不会跨 FFI unwind。
    CallbackPanicked,
    /// native 返回不符合已绑定 ABI 的事件或状态；不是 CDP 协议错误。
    NativeContractViolation,
    /// 调用方业务失败，例如参数解析、测试断言或报告写入失败。
    Application,
}

impl ErrorKind {
    /// native 类别为 1..=13；Rust 侧类别使用负值，不能传入 native。
    pub fn code(self) -> i32 {
        match self {
            Self::NativeContractViolation => -1,
            Self::Application => -2,
            _ => self as i32 + 1,
        }
    }

    /// 由 native 状态码反查;仅接受 1..=13。
    pub fn from_code(code: i32) -> Option<ErrorKind> {
        match code {
            1 => Some(ErrorKind::NotInBootstrap),
            2 => Some(ErrorKind::AlreadyRun),
            3 => Some(ErrorKind::InvalidArgument),
            4 => Some(ErrorKind::ProfileUnavailable),
            5 => Some(ErrorKind::VersionMismatch),
            6 => Some(ErrorKind::InitializationFailed),
            7 => Some(ErrorKind::NotReady),
            8 => Some(ErrorKind::BrowserClosed),
            9 => Some(ErrorKind::Protocol),
            10 => Some(ErrorKind::CommandCancelled),
            11 => Some(ErrorKind::Timeout),
            12 => Some(ErrorKind::RendererTerminated),
            13 => Some(ErrorKind::CallbackPanicked),
            _ => None,
        }
    }
}

impl fmt::Display for ErrorKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            ErrorKind::NotInBootstrap => "NotInBootstrap",
            ErrorKind::AlreadyRun => "AlreadyRun",
            ErrorKind::InvalidArgument => "InvalidArgument",
            ErrorKind::ProfileUnavailable => "ProfileUnavailable",
            ErrorKind::VersionMismatch => "VersionMismatch",
            ErrorKind::InitializationFailed => "InitializationFailed",
            ErrorKind::NotReady => "NotReady",
            ErrorKind::BrowserClosed => "BrowserClosed",
            ErrorKind::Protocol => "Protocol",
            ErrorKind::CommandCancelled => "CommandCancelled",
            ErrorKind::Timeout => "Timeout",
            ErrorKind::RendererTerminated => "RendererTerminated",
            ErrorKind::CallbackPanicked => "CallbackPanicked",
            ErrorKind::NativeContractViolation => "NativeContractViolation",
            ErrorKind::Application => "Application",
        };
        formatter.write_str(name)
    }
}

/// 携带上下文的错误:native_code 与(协议失败时的)原始 payload
/// 一并保留。
#[derive(Debug, Clone)]
pub struct Error {
    kind: ErrorKind,
    native_code: i32,
    message: String,
    payload: Option<Value>,
}

impl Error {
    /// 构造业务入口错误，供 `export_app!` 在正常栈展开后返回非零退出码。
    ///
    /// 不伪造 CEF/OS 状态：类别为 [`ErrorKind::Application`]，
    /// `native_code` 为 0，且没有协议 payload。
    pub fn application(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Application, message)
    }

    /// 错误类别。
    pub fn kind(&self) -> ErrorKind {
        self.kind
    }

    /// CEF/OS 原始错误码;无原始错误时为 0。
    pub fn native_code(&self) -> i32 {
        self.native_code
    }

    /// 人类可读的失败说明。
    pub fn message(&self) -> &str {
        &self.message
    }

    /// 协议失败的原始 CDP payload(result/error object);非协议失败为 None。
    pub fn payload(&self) -> Option<&Value> {
        self.payload.as_ref()
    }

    pub(crate) fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Error {
            kind,
            native_code: 0,
            message: message.into(),
            payload: None,
        }
    }

    pub(crate) fn with_native_code(mut self, native_code: i32) -> Self {
        self.native_code = native_code;
        self
    }

    pub(crate) fn with_payload(mut self, payload: Option<Value>) -> Self {
        self.payload = payload;
        self
    }

    pub(crate) fn contract(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::NativeContractViolation, message)
    }

    /// 未知状态码是 ABI 契约错误，保留其 code 与 native_code。
    pub(crate) fn from_status(status: IrisStatus, context: &str) -> Self {
        match ErrorKind::from_code(status.code) {
            Some(kind) => Error {
                kind,
                native_code: status.native_code,
                message: context.to_string(),
                payload: None,
            },
            None => Error {
                kind: ErrorKind::NativeContractViolation,
                native_code: status.native_code,
                message: format!("{context}: unknown native status code {}", status.code),
                payload: None,
            },
        }
    }
}

/// code=0 视为成功,否则携带上下文转为 [`Error`]。
pub(crate) fn check_status(status: IrisStatus, context: &str) -> Result<(), Error> {
    if status.code == iris_sys::IRIS_OK {
        Ok(())
    } else {
        Err(Error::from_status(status, context))
    }
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{}: {} (native_code {})",
            self.kind, self.message, self.native_code
        )
    }
}

impl std::error::Error for Error {}

#[cfg(test)]
mod tests {
    use super::*;

    /// 未知状态码不得误报成 CDP 错误，且必须保留两个原始码。
    #[test]
    fn from_status_retains_unknown_codes() {
        let error = Error::from_status(
            IrisStatus {
                code: 99,
                native_code: 7,
            },
            "command failed",
        );
        assert_eq!(error.kind(), ErrorKind::NativeContractViolation);
        assert_eq!(error.native_code(), 7);
        assert!(
            error.message().contains("99"),
            "message 应保留原始 code: {}",
            error.message()
        );
        assert!(error.message().contains("command failed"));
    }

    /// 已知状态码:native_code 与上下文必须原样保留。
    #[test]
    fn from_status_retains_native_code_for_known_kinds() {
        let error = Error::from_status(
            IrisStatus {
                code: ErrorKind::VersionMismatch.code(),
                native_code: 5,
            },
            "run failed",
        );
        assert_eq!(error.kind(), ErrorKind::VersionMismatch);
        assert_eq!(error.native_code(), 5);
        assert_eq!(error.message(), "run failed");
    }
}
