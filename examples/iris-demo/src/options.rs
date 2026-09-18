use iris::{Error, WindowMode};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::{collections::BTreeSet, ffi::OsString, num::NonZeroU16, path::PathBuf};

pub struct Options {
    pub mode: WindowMode,
    pub url: Option<String>,
    pub seed: u64,
    pub timezone: Option<String>,
    pub cache: PathBuf,
    pub cdp: Option<NonZeroU16>,
    pub self_test: bool,
    pub output: Option<PathBuf>,
}

fn text(value: OsString, flag: &str) -> Result<String, Error> {
    value
        .into_string()
        .map_err(|_| Error::application(format!("{flag}: expected Unicode text")))
}

fn decimal(value: OsString, flag: &str) -> Result<u64, Error> {
    let value = text(value, flag)?;
    if value.is_empty() || !value.bytes().all(|c| c.is_ascii_digit()) {
        return Err(Error::application(format!(
            "{flag}: expected unsigned decimal integer"
        )));
    }
    value
        .parse()
        .map_err(|_| Error::application(format!("{flag}: integer out of range")))
}

// Split only ASCII '='; never round-trip a path through Unicode text.
fn split(value: OsString) -> (OsString, Option<OsString>) {
    let units: Vec<u16> = value.encode_wide().collect();
    match units.iter().position(|&u| u == u16::from(b'=')) {
        Some(i) => (
            OsString::from_wide(&units[..i]),
            Some(OsString::from_wide(&units[i + 1..])),
        ),
        None => (value, None),
    }
}

pub fn parse() -> Result<Option<Options>, Error> {
    let mut args = std::env::args_os().skip(1).peekable();
    let mut seen = BTreeSet::new();
    let mut mode = WindowMode::Windowed;
    let mut mode_seen = false;
    let mut url = None;
    let mut seed = None;
    let mut timezone = None;
    let mut cache = None;
    let mut cdp = None;
    let mut self_test = false;
    let mut output = None;
    let mut help = false;
    while let Some(arg) = args.next() {
        let (key, inline) = split(arg);
        let key = text(key, "option name")?;
        if key == "--module" {
            let value = match inline {
                Some(value) => value,
                None => {
                    if args
                        .peek()
                        .is_none_or(|v| v.encode_wide().take(2).eq([45, 45]))
                    {
                        return Err(Error::application("--module: missing value"));
                    }
                    args.next()
                        .ok_or_else(|| Error::application("--module: missing value"))?
                }
            };
            if value.is_empty() {
                return Err(Error::application("--module: empty value"));
            }
            if !seen.insert(key) {
                return Err(Error::application("duplicate --module"));
            }
            continue;
        }
        if !seen.insert(key.clone()) {
            return Err(Error::application(format!("duplicate option: {key}")));
        }
        match key.as_str() {
            "--windowed" | "--headless" | "--self-test" | "--help" | "-h" => {
                if inline.is_some() {
                    return Err(Error::application(format!("{key} takes no value")));
                }
                match key.as_str() {
                    "--windowed" | "--headless" => {
                        if mode_seen {
                            return Err(Error::application("window modes are mutually exclusive"));
                        }
                        mode_seen = true;
                        mode = if key == "--headless" {
                            WindowMode::Windowless
                        } else {
                            WindowMode::Windowed
                        };
                    }
                    "--self-test" => self_test = true,
                    _ => {
                        if help {
                            return Err(Error::application("duplicate help"));
                        }
                        help = true;
                    }
                }
            }
            "--url" | "--seed" | "--timezone" | "--cache-dir" | "--cdp-port" | "--output-dir" => {
                let value = match inline {
                    Some(value) => value,
                    None => {
                        if args
                            .peek()
                            .is_none_or(|v| v.encode_wide().take(2).eq([45, 45]))
                        {
                            return Err(Error::application(format!("{key}: missing value")));
                        }
                        args.next()
                            .ok_or_else(|| Error::application(format!("{key}: missing value")))?
                    }
                };
                if value.is_empty() {
                    return Err(Error::application(format!("{key}: empty value")));
                }
                match key.as_str() {
                    "--seed" => seed = Some(decimal(value, &key)?),
                    "--cdp-port" => {
                        cdp = Some(
                            u16::try_from(decimal(value, &key)?)
                                .ok()
                                .and_then(NonZeroU16::new)
                                .ok_or_else(|| {
                                    Error::application("--cdp-port: expected 1..65535")
                                })?,
                        );
                    }
                    "--cache-dir" => {
                        let path = PathBuf::from(value);
                        if !path.is_absolute() {
                            return Err(Error::application("--cache-dir must be absolute"));
                        }
                        cache = Some(path);
                    }
                    "--output-dir" => output = Some(PathBuf::from(value)),
                    "--timezone" => timezone = Some(text(value, &key)?),
                    "--url" => {
                        let value = text(value, &key)?;
                        let lower = value.to_ascii_lowercase();
                        let prefix = if lower.starts_with("http://") {
                            7
                        } else if lower.starts_with("https://") {
                            8
                        } else {
                            0
                        };
                        if prefix == 0
                            || value.len() == prefix
                            || value.chars().any(char::is_control)
                        {
                            return Err(Error::application(
                                "--url requires a nonempty http(s) URL without control characters",
                            ));
                        }
                        url = Some(value);
                    }
                    _ => unreachable!(),
                }
            }
            _ => return Err(Error::application(format!("unknown option: {key}"))),
        }
    }
    if help {
        println!(
            "iris-demo --seed <decimal-u64> --cache-dir <absolute-path> [--windowed|--headless]\n  [--url <http(s)-url>] [--timezone <IANA-zone>] [--cdp-port <1..65535>]\n  [--self-test --output-dir <path>]\nOptions accept --flag=value or --flag value. Self-test uses local fixtures only."
        );
        return Ok(None);
    }
    if self_test && (output.is_none() || url.is_some()) {
        return Err(Error::application(
            "--self-test requires --output-dir and forbids --url",
        ));
    }
    Ok(Some(Options {
        mode,
        url,
        timezone,
        cdp,
        self_test,
        output,
        seed: seed.ok_or_else(|| Error::application("--seed is required"))?,
        cache: cache.ok_or_else(|| Error::application("--cache-dir is required"))?,
    }))
}
