//! Session:仅在事件回调期间可用的操作句柄。
//!
//! 通过 lifetime + `PhantomData<Rc<()>>` 保证:
//! - `!Send + !Sync`:不能跨线程移动;
//! - 借用不能逃逸回调(`run` 的高阶生命周期约束)。
//! compile_fail 文档测试验证这两个性质(见 crate 根)。

use std::marker::PhantomData;
use std::rc::Rc;

use serde_json::{Value, json};

use crate::error::{Error, ErrorKind, check_status};
use crate::ids::{BrowserId, RequestId};
use crate::views;

/// 事件回调内可用的会话句柄;仅在回调栈上构造(native 保证回调期间
/// session 指针有效)。
pub struct Session<'a> {
    raw: *mut iris_sys::IrisSession,
    // Rc<()> 既非 Send 也非 Sync:引用它的 PhantomData 使 Session 继承
    // 同样性质;生命周期把句柄钉在本次回调内。
    _marker: PhantomData<&'a Rc<()>>,
}

impl<'a> Session<'a> {
    pub(crate) fn from_raw(raw: *mut iris_sys::IrisSession) -> Self {
        Session {
            raw,
            _marker: PhantomData,
        }
    }

    fn alive(&self) -> Result<*mut iris_sys::IrisSession, Error> {
        if self.raw.is_null() {
            // native 契约保证回调期间句柄有效;此处仅防御性兜底,
            // 不解引用任何伪造句柄。
            Err(Error::new(
                ErrorKind::NotReady,
                "session handle is unavailable",
            ))
        } else {
            Ok(self.raw)
        }
    }

    /// 显式创建 browser(同步创建,但 ID 在 `BrowserCreated` 事件交付前
    /// 处于 Pending:提前操作返回 `NotReady`)。返回 Pending ID；
    /// 同步创建失败立即返回 InitializationFailed，不发布有效 ID。
    ///
    /// 网站 popup 由 native 按上游正常创建并继承同一 profile,
    /// 不经本方法。
    pub fn create_browser(&mut self, url: &str) -> Result<BrowserId, Error> {
        let session = self.alive()?;
        let url_view = views::utf8(url.as_bytes());
        let mut browser_id: u64 = 0;
        // Safety:session 指针来自 native 回调,在本次回调(即本借用)
        // 期间有效;url 视图借用本地切片,存活至函数返回(满足 C 契约
        // 的“输入借用至函数返回”);出参指向本栈变量且按值返回。
        let status = unsafe { iris_sys::iris_create_browser(session, url_view, &mut browser_id) };
        check_status(status, "create_browser failed").map(|()| BrowserId::new(browser_id))
    }

    /// 导航到 `url`:即 `Page.navigate` 命令的便捷封装。
    /// 返回的 [`RequestId`] 对应随后交付的 `CommandResult` 事件;
    /// 该事件只表示 CDP 响应,不表示页面加载完成。
    pub fn navigate(&mut self, browser: BrowserId, url: &str) -> Result<RequestId, Error> {
        self.command(browser, "Page.navigate", json!({ "url": url }))
    }

    /// 对指定 browser 执行 CDP 命令并返回请求标识。
    ///
    /// `method` 不得为空、`params` 必须是 JSON object(native 同步校验,
    /// 违者 `InvalidArgument`)。结果与协议错误按 request id 以
    /// `CommandResult` 事件交付;30 秒无结果超时,browser 关闭或
    /// renderer 崩溃时取消。
    pub fn command(
        &mut self,
        browser: BrowserId,
        method: &str,
        params: Value,
    ) -> Result<RequestId, Error> {
        let session = self.alive()?;
        // serde_json::Value 恒可序列化;失败仅可能是实现级错误。
        let params_text = match serde_json::to_string(&params) {
            Ok(text) => text,
            Err(error) => {
                return Err(Error::new(
                    ErrorKind::InvalidArgument,
                    format!("params serialization failed: {error}"),
                ));
            }
        };
        let method_view = views::utf8(method.as_bytes());
        let params_view = views::utf8(params_text.as_bytes());
        let mut request_id: u64 = 0;
        // Safety:同 create_browser;method/params 均为本地借用,
        // 存活至函数返回。
        let status = unsafe {
            iris_sys::iris_command(
                session,
                browser.as_native(),
                method_view,
                params_view,
                &mut request_id,
            )
        };
        check_status(status, "command failed").map(|()| RequestId::new(request_id))
    }

    /// 关闭指定 browser(程序化强制关闭;窗口用户关闭保留常规
    /// beforeunload 交互)。随后会收到对应的 `BrowserClosed` 事件。
    pub fn close_browser(&mut self, browser: BrowserId) -> Result<(), Error> {
        let session = self.alive()?;
        // Safety:同 create_browser。
        let status = unsafe { iris_sys::iris_close_browser(session, browser.as_native()) };
        check_status(status, "close_browser failed")
    }

    /// 请求关闭整个会话:native 关闭全部 browser(含 pending 创建)并
    /// drain 至 OnBeforeClose 后结束消息循环。之后仍会交付剩余关闭事件。
    pub fn shutdown(&mut self) -> Result<(), Error> {
        let session = self.alive()?;
        // Safety:同 create_browser。
        let status = unsafe { iris_sys::iris_request_shutdown(session) };
        check_status(status, "shutdown failed")
    }
}
