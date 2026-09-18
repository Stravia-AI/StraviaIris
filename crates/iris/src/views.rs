//! 借用视图构造(私有)。
//!
//! 按 C ABI 契约:输入借用至函数返回;空视图以 null+0 传递,
//! 其余指针必须指向存活至调用返回的缓冲。

/// 由 UTF-8 字节构造计长视图。
pub(crate) fn utf8(bytes: &[u8]) -> iris_sys::IrisUtf8View {
    if bytes.is_empty() {
        iris_sys::IrisUtf8View {
            data: std::ptr::null(),
            len: 0,
        }
    } else {
        iris_sys::IrisUtf8View {
            data: bytes.as_ptr(),
            len: bytes.len(),
        }
    }
}

/// 由 UTF-16 code unit 构造计长视图(len 以 code unit 计)。
pub(crate) fn utf16(units: &[u16]) -> iris_sys::IrisUtf16View {
    if units.is_empty() {
        iris_sys::IrisUtf16View {
            data: std::ptr::null(),
            len: 0,
        }
    } else {
        iris_sys::IrisUtf16View {
            data: units.as_ptr(),
            len: units.len(),
        }
    }
}
