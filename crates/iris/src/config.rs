//! 启动配置。
//!
//! 字段与默认值由计划第 5/6 节固定:默认 Windowed、跟随宿主时区、CDP
//! 关闭;起始 viewport 固定 1280×720(不暴露任意 Chromium flag)。
//! 缓存路径以 Windows 原生 UTF-16(WTF-16)精确传递:含内嵌 NUL 即拒绝,
//! 绝不做 lossy 转换。

use std::num::NonZeroU16;
use std::path::{Path, PathBuf};

use iris_sys::IrisConfig;

use crate::error::{Error, ErrorKind};
use crate::views;

/// 浏览器呈现模式;两模式同为 `CEF_RUNTIME_STYLE_ALLOY`、同一 profile、
/// 同一控制与消息循环。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub enum WindowMode {
    /// 独立 browser 窗口(默认)。
    #[default]
    Windowed,
    /// 离屏渲染(OSR):GetViewRect/GetScreenInfo + OnPaint,
    /// 无 HWND/纹理输出接口。
    Windowless,
}

impl WindowMode {
    pub(crate) fn as_native(self) -> u32 {
        match self {
            WindowMode::Windowed => iris_sys::WINDOW_MODE_WINDOWED,
            WindowMode::Windowless => iris_sys::WINDOW_MODE_WINDOWLESS,
        }
    }
}

/// `iris_run` 的启动配置。
#[derive(Debug, Clone)]
pub struct Config {
    pub(crate) cache_path: PathBuf,
    pub(crate) seed: u64,
    pub(crate) window_mode: WindowMode,
    /// None 或空字符串 = 跟随宿主时区。
    pub(crate) timezone: Option<String>,
    pub(crate) remote_debugging_port: Option<NonZeroU16>,
}

impl Config {
    /// 以缓存目录与随机种子创建配置。
    ///
    /// seed 是唯一随机化输入(允许 0);相同 seed 相同输入产生相同指纹
    /// 摘要,身份字段不随 seed 变化。其余默认:Windowed、跟随宿主时区、
    /// CDP 关闭。
    ///
    /// 复用同一绝对缓存目录可保留站点存储和未过期的持久 cookie。
    /// 会话 cookie 仍遵循 CEF 默认的临时语义，不保证重启后保留登录。
    /// 同一目录不能被多个运行实例同时占用；复用时保持 seed 与时区一致。
    pub fn new(cache_path: PathBuf, seed: u64) -> Config {
        Config {
            cache_path,
            seed,
            window_mode: WindowMode::Windowed,
            timezone: None,
            remote_debugging_port: None,
        }
    }

    /// 设置呈现模式。
    pub fn window_mode(mut self, window_mode: WindowMode) -> Self {
        self.window_mode = window_mode;
        self
    }

    /// 设置 IANA 时区;空字符串与未设置等价(跟随宿主)。
    /// 合法性由 native 在创建首个网页前校验,非法 zone 拒绝启动。
    pub fn timezone(mut self, timezone: String) -> Self {
        self.timezone = Some(timezone);
        self
    }

    /// 启用 CEF 原生 CDP 调试端口。端口范围 1..=65535 由 `NonZeroU16`
    /// 保证;监听限定 loopback,被占用时启动失败,不自动换端口。
    pub fn remote_debugging_port(mut self, port: NonZeroU16) -> Self {
        self.remote_debugging_port = Some(port);
        self
    }

    /// 转为 native 配置。缓冲区由 [`OwnedNativeConfig`] 持有,
    /// 视图仅借用,存活期覆盖整个 `iris_run` 调用。
    pub(crate) fn into_native(self) -> Result<OwnedNativeConfig, Error> {
        let cache_utf16 = encode_path_utf16(&self.cache_path)?;
        let timezone = self.timezone.unwrap_or_default();
        let timezone_utf8 = timezone.into_bytes();
        if timezone_utf8.contains(&0) {
            return Err(Error::new(
                ErrorKind::InvalidArgument,
                "timezone contains an embedded NUL",
            ));
        }
        Ok(OwnedNativeConfig {
            seed: self.seed,
            window_mode: self.window_mode.as_native(),
            remote_debugging_port: self
                .remote_debugging_port
                .map(|port| u32::from(port.get()))
                .unwrap_or(0),
            cache_utf16,
            timezone_utf8,
        })
    }
}

/// 持有配置值和缓冲；仅在调用 FFI 时生成借用视图，避免存储自引用指针。
pub(crate) struct OwnedNativeConfig {
    seed: u64,
    window_mode: u32,
    remote_debugging_port: u32,
    cache_utf16: Vec<u16>,
    timezone_utf8: Vec<u8>,
}

impl OwnedNativeConfig {
    /// 返回的指针只在 self 存活且缓冲未修改时有效。
    pub(crate) fn as_raw(&self) -> IrisConfig {
        IrisConfig {
            struct_size: std::mem::size_of::<IrisConfig>(),
            seed: self.seed,
            window_mode: self.window_mode,
            remote_debugging_port: self.remote_debugging_port,
            cache_path_utf16: views::utf16(&self.cache_utf16),
            timezone_utf8: views::utf8(&self.timezone_utf8),
        }
    }
}

/// 将路径按 Windows 原生 UTF-16 精确编码;含内嵌 NUL 即拒绝。
///
/// Windows 下用 `encode_wide` 保留原始 WTF-16(包括无法转换的
/// code unit),不做 lossy 转换;非 Windows 宿主仅供源码阅读,
/// 要求路径可 UTF-8 表示,否则显式失败。
pub(crate) fn encode_path_utf16(path: &Path) -> Result<Vec<u16>, Error> {
    #[cfg(windows)]
    let units: Vec<u16> = {
        use std::os::windows::ffi::OsStrExt;
        path.as_os_str().encode_wide().collect()
    };
    #[cfg(not(windows))]
    let units: Vec<u16> = match path.to_str() {
        Some(text) => text.encode_utf16().collect(),
        None => {
            return Err(Error::new(
                ErrorKind::InvalidArgument,
                "cache path is not valid UTF-8 on this platform",
            ));
        }
    };
    if units.contains(&0) {
        return Err(Error::new(
            ErrorKind::InvalidArgument,
            "cache path contains an embedded NUL",
        ));
    }
    Ok(units)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 内嵌 NUL 的缓存路径必须被拒绝,而不是被截断或 lossy 处理。
    #[test]
    fn cache_path_with_embedded_nul_is_rejected() {
        let path = PathBuf::from("C:\\ca\0che");
        let error = Config::new(path, 0)
            .into_native()
            .err()
            .expect("含 NUL 的路径必须失败");
        assert_eq!(error.kind(), ErrorKind::InvalidArgument);
    }

    /// 内嵌 NUL 的时区同样拒绝。
    #[test]
    fn timezone_with_embedded_nul_is_rejected() {
        let error = Config::new(PathBuf::from("cache"), 0)
            .timezone("Europe/Ber\0lin".to_string())
            .into_native()
            .err()
            .expect("含 NUL 的时区必须失败");
        assert_eq!(error.kind(), ErrorKind::InvalidArgument);
    }

    /// 路径编码必须精确保留非 ASCII 与星面(astral)字符,
    /// 不做 lossy 转换。
    #[test]
    fn cache_path_preserves_astral_and_non_ascii_units() {
        let text = "缓存-𐐷-Ünïcode";
        let owned = Config::new(PathBuf::from(text), 0)
            .into_native()
            .expect("合法路径");
        let expected: Vec<u16> = text.encode_utf16().collect();
        assert_eq!(owned.cache_utf16, expected);
    }
}
