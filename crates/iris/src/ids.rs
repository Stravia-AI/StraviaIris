//! opaque ID。
//!
//! [`BrowserId`]/[`RequestId`] 是 native 分配的不透明值:可以存储、
//! 比较、跨事件保留,但每次使用都经 Session 查表校验(Pending 返回
//! `NotReady`,已关闭/未知返回 `BrowserClosed`)。不提供 from_raw,
//! 也不暴露内部 u64。

use std::fmt;

/// browser 的不透明标识;native 侧单调递增、从不复用。
#[repr(transparent)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct BrowserId(u64);

impl BrowserId {
    pub(crate) fn new(raw: u64) -> Self {
        BrowserId(raw)
    }

    pub(crate) fn as_native(self) -> u64 {
        self.0
    }
}

impl fmt::Display for BrowserId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.0, formatter)
    }
}

/// CDP 命令的不透明请求标识。
#[repr(transparent)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct RequestId(u64);

impl RequestId {
    pub(crate) fn new(raw: u64) -> Self {
        RequestId(raw)
    }
}

impl fmt::Display for RequestId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.0, formatter)
    }
}
