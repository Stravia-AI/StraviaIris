//! 事件缓冲只在回调内读取，转换为 owned 数据后才交付业务。
//! 与固定 ABI 不一致的事件必须显式失败，不能制造默认结果或静默忽略。

use crate::error::{Error, ErrorKind};
use crate::ids::{BrowserId, RequestId};
use iris_sys::IrisEvent;
use serde_json::Value;

/// 会话事件；字段来自 native 实际事件，不由 facade 填充身份或结果。
#[derive(Debug, Clone)]
pub enum Event {
    /// 会话就绪，此后可创建 browser。
    Ready,
    /// ID 从 Pending 转为可用。
    BrowserCreated { browser: BrowserId },
    /// ID 已失效。
    BrowserClosed { browser: BrowserId },
    /// CDP 响应，不表示导航加载完成；错误保留原始 payload。
    CommandResult {
        browser: BrowserId,
        request: RequestId,
        result: Result<Value, Error>,
    },
    /// 原始 CDP 方法与参数对象。
    ProtocolEvent {
        browser: BrowserId,
        method: String,
        params: Value,
    },
    /// 加载或创建失败；创建失败时 Pending ID 失效。
    LoadError {
        browser: BrowserId,
        code: i32,
        message: String,
        url: String,
    },
    /// renderer 终止，尚未完成的命令由独立 CommandResult 取消。
    RendererTerminated {
        browser: BrowserId,
        status: i32,
        error_code: i32,
    },
}

pub(crate) fn decode(event: &IrisEvent) -> Result<Event, Error> {
    use iris_sys::event_kind::*;
    if !(READY..=RENDERER_TERMINATED).contains(&event.kind) {
        return Err(Error::contract(format!(
            "unknown native event kind {}",
            event.kind
        )));
    }
    if event.status.code != iris_sys::IRIS_OK && ErrorKind::from_code(event.status.code).is_none() {
        return Err(Error::from_status(
            event.status,
            "invalid native event status",
        ));
    }
    if (event.kind == READY) != (event.browser == 0)
        || (event.kind == COMMAND_RESULT) != (event.request != 0)
    {
        return Err(Error::contract(
            "native event contains invalid browser/request IDs",
        ));
    }
    if matches!(
        event.kind,
        READY | BROWSER_CREATED | BROWSER_CLOSED | PROTOCOL_EVENT
    ) && event.status.code != iris_sys::IRIS_OK
    {
        return Err(Error::contract(format!(
            "native event {} has unexpected status {}",
            event.kind, event.status.code
        ))
        .with_native_code(event.status.native_code));
    }
    let mut payload = payload_value(event)?;
    let browser = BrowserId::new(event.browser);
    match event.kind {
        READY | BROWSER_CREATED | BROWSER_CLOSED => {
            if !payload.as_object().expect("validated object").is_empty() {
                return Err(Error::contract(
                    "lifecycle event payload must be an empty object",
                ));
            }
            Ok(match event.kind {
                READY => Event::Ready,
                BROWSER_CREATED => Event::BrowserCreated { browser },
                _ => Event::BrowserClosed { browser },
            })
        }
        COMMAND_RESULT => {
            let result = if event.status.code == iris_sys::IRIS_OK {
                Ok(payload)
            } else {
                // 取消/超时由 SDK 产生，payload 合法为 {}，不是缺失协议结果。
                let message = if event.status.code == ErrorKind::Protocol.code() {
                    i32_field(&payload, "code")?;
                    string_field(&payload, "message")?
                } else {
                    "native command failed".to_string()
                };
                Err(Error::from_status(event.status, &message).with_payload(Some(payload)))
            };
            Ok(Event::CommandResult {
                browser,
                request: RequestId::new(event.request),
                result,
            })
        }
        PROTOCOL_EVENT => {
            let method = string_field(&payload, "method")?;
            if method.is_empty() {
                return Err(Error::contract("native protocol event method is empty"));
            }
            let params = payload
                .get_mut("params")
                .filter(|value| value.is_object())
                .ok_or_else(|| Error::contract("native protocol event params must be an object"))?
                .take();
            Ok(Event::ProtocolEvent {
                browser,
                method,
                params,
            })
        }
        LOAD_ERROR => Ok(Event::LoadError {
            browser,
            code: i32_field(&payload, "code")?,
            message: string_field(&payload, "message")?,
            url: string_field(&payload, "url")?,
        }),
        RENDERER_TERMINATED => Ok(Event::RendererTerminated {
            browser,
            status: i32_field(&payload, "status")?,
            error_code: i32_field(&payload, "error_code")?,
        }),
        _ => unreachable!("kind was validated"),
    }
}

fn payload_value(event: &IrisEvent) -> Result<Value, Error> {
    if event.payload_json.data.is_null()
        || event.payload_json.len == 0
        || event.payload_json.len > isize::MAX as usize
    {
        return Err(Error::contract("native event payload view is invalid"));
    }
    // Safety:native 保证非空 payload 在回调期间有效；slice 不逃逸。
    let bytes =
        unsafe { std::slice::from_raw_parts(event.payload_json.data, event.payload_json.len) };
    let payload: Value = serde_json::from_slice(bytes)
        .map_err(|error| Error::contract(format!("invalid native event JSON: {error}")))?;
    if !payload.is_object() {
        return Err(Error::contract(
            "native event payload must be a JSON object",
        ));
    }
    Ok(payload)
}

fn string_field(payload: &Value, key: &str) -> Result<String, Error> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| Error::contract(format!("native event field {key} must be a string")))
}

fn i32_field(payload: &Value, key: &str) -> Result<i32, Error> {
    payload
        .get(key)
        .and_then(Value::as_i64)
        .and_then(|value| i32::try_from(value).ok())
        .ok_or_else(|| Error::contract(format!("native event field {key} must be an i32")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_event(kind: u32, payload: &[u8]) -> IrisEvent {
        IrisEvent {
            kind,
            browser: if kind == iris_sys::event_kind::READY {
                0
            } else {
                11
            },
            request: if kind == iris_sys::event_kind::COMMAND_RESULT {
                22
            } else {
                0
            },
            status: iris_sys::IrisStatus {
                code: 0,
                native_code: 0,
            },
            payload_json: iris_sys::IrisUtf8View {
                data: payload.as_ptr(),
                len: payload.len(),
            },
        }
    }

    #[test]
    fn rejects_malformed_lifecycle_payloads_instead_of_signalling_success() {
        for kind in [
            iris_sys::event_kind::READY,
            iris_sys::event_kind::BROWSER_CREATED,
            iris_sys::event_kind::BROWSER_CLOSED,
        ] {
            for payload in [
                b"".as_slice(),
                b"\xff",
                b"{",
                b"null",
                b"[]",
                b"{\"unexpected\":1}",
            ] {
                let error =
                    decode(&make_event(kind, payload)).expect_err("invalid lifecycle event");
                assert_eq!(error.kind(), ErrorKind::NativeContractViolation);
            }
        }
    }

    #[test]
    fn rejects_missing_fields_and_out_of_range_numbers() {
        for (kind, payload) in [
            (
                iris_sys::event_kind::LOAD_ERROR,
                br#"{"message":"failed","url":""}"#.as_slice(),
            ),
            (
                iris_sys::event_kind::LOAD_ERROR,
                br#"{"code":2147483648,"message":"failed","url":""}"#,
            ),
            (
                iris_sys::event_kind::RENDERER_TERMINATED,
                br#"{"status":1,"error_code":-2147483649}"#,
            ),
            (
                iris_sys::event_kind::PROTOCOL_EVENT,
                br#"{"method":"Page.loadEventFired"}"#,
            ),
            (iris_sys::event_kind::COMMAND_RESULT, b"not JSON"),
        ] {
            assert_eq!(
                decode(&make_event(kind, payload))
                    .expect_err("invalid payload")
                    .kind(),
                ErrorKind::NativeContractViolation
            );
        }
    }

    #[test]
    fn rejects_unknown_kind_status_and_null_payload_view() {
        let mut event = make_event(99, b"{}");
        assert_eq!(
            decode(&event).unwrap_err().kind(),
            ErrorKind::NativeContractViolation
        );
        event = make_event(iris_sys::event_kind::COMMAND_RESULT, b"{}");
        event.status = iris_sys::IrisStatus {
            code: 99,
            native_code: 7,
        };
        let error = decode(&event).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::NativeContractViolation);
        assert_eq!(error.native_code(), 7);
        assert!(error.message().contains("99"));
        event.status.code = 0;
        event.payload_json.data = std::ptr::null();
        assert_eq!(
            decode(&event).unwrap_err().kind(),
            ErrorKind::NativeContractViolation
        );
    }

    #[test]
    fn protocol_error_preserves_native_code_and_original_object() {
        let bytes =
            br#"{"code":-32000,"message":"Insufficient resources","data":{"reason":"capacity"}}"#;
        let mut event = make_event(iris_sys::event_kind::COMMAND_RESULT, bytes);
        event.status = iris_sys::IrisStatus {
            code: 9,
            native_code: 0xC0000005u32 as i32,
        };
        let Event::CommandResult {
            result: Err(error), ..
        } = decode(&event).unwrap()
        else {
            panic!("expected protocol failure");
        };
        assert_eq!(error.kind(), ErrorKind::Protocol);
        assert_eq!(error.native_code(), 0xC0000005u32 as i32);
        assert_eq!(error.message(), "Insufficient resources");
        assert_eq!(
            error.payload(),
            Some(&serde_json::from_slice::<Value>(bytes).unwrap())
        );
    }

    #[test]
    fn protocol_error_requires_an_integer_error_code() {
        for payload in [
            br#"{"message":"failed"}"#.as_slice(),
            br#"{"code":"invalid","message":"failed"}"#,
        ] {
            let mut event = make_event(iris_sys::event_kind::COMMAND_RESULT, payload);
            event.status.code = ErrorKind::Protocol.code();
            assert_eq!(
                decode(&event).unwrap_err().kind(),
                ErrorKind::NativeContractViolation
            );
        }
    }

    #[test]
    fn cancellation_without_protocol_payload_remains_a_failure() {
        let mut event = make_event(iris_sys::event_kind::COMMAND_RESULT, b"{}");
        event.status.code = ErrorKind::CommandCancelled.code();
        let Event::CommandResult {
            result: Err(error), ..
        } = decode(&event).unwrap()
        else {
            panic!("cancellation must not become success or a contract failure");
        };
        assert_eq!(error.kind(), ErrorKind::CommandCancelled);
    }
}
