//! 真实 SDK 生命周期回归驱动。每个场景使用独立 bootstrap 进程与 fresh cache。
use iris::serde_json::{self, json};
use iris::{Config, ControlFlow, Error, ErrorKind, Event, WindowMode};
use std::collections::{BTreeMap, BTreeSet};
use std::time::Instant;

const IDENTITY_JS: &str = r#"(() => {
    const canvas = new OffscreenCanvas(8, 8);
    const context = canvas.getContext('2d');
    context.fillStyle = 'rgb(64,128,192)';
    context.fillRect(0, 0, 8, 8);
    return {
        ua: navigator.userAgent, platform: navigator.platform,
        languages: Array.from(navigator.languages), cores: navigator.hardwareConcurrency,
        webdriver: typeof navigator.webdriver, webdriverIn: 'webdriver' in navigator,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        pixels: Array.from(context.getImageData(0, 0, 8, 8).data)
    };
})()"#;

fn app() -> Result<(), Error> {
    let case =
        std::env::var("IRIS_SDK_TEST_CASE").map_err(|e| Error::application(e.to_string()))?;
    let cache = std::env::var_os("IRIS_SDK_TEST_CACHE")
        .ok_or_else(|| Error::application("missing IRIS_SDK_TEST_CACHE"))?;
    let output = std::env::var_os("IRIS_SDK_TEST_REPORT")
        .ok_or_else(|| Error::application("missing IRIS_SDK_TEST_REPORT"))?;
    if !["close-pending", "panic", "timeout", "crash", "profiles"]
        .contains(&case.as_str())
    {
        return Err(Error::application("unknown lifecycle case"));
    }
    let config = Config::new(cache.into(), 42).window_mode(WindowMode::Windowless);
    let mut pending = BTreeMap::new();
    let mut completed = BTreeSet::new();
    let mut closed = BTreeSet::new();
    let mut records = Vec::new();
    let mut first = None;
    let mut keeper = None;
    let mut failure = None;
    let mut panic_triggered = false;
    let mut crash_seen = false;
    let mut cancellation_seen = false;
    let mut timeout_seen = false;
    let mut identity = None;
    let mut recovered = false;
    let mut recovery_frame_seen = false;
    let mut recovery_read_sent = false;
    // profiles 用例：alpha/beta 为两个隔离 profile,gamma 复用 alpha,
    // delta 验证 Windows 保留名(经 iris-profile- 前缀映射后合法)。
    let mut alpha = None;
    let mut beta = None;
    let mut gamma = None;
    let mut delta = None;
    let mut isolation_seen = false;
    let mut sharing_seen = false;
    let started = Instant::now();
    let result = iris::run(config, |session, event| {
        records.push(
            json!({"elapsedMs": started.elapsed().as_millis(), "event": format!("{event:?}")}),
        );
        if failure.is_some() {
            return ControlFlow::Break(());
        }
        let step = (|| -> Result<(), Error> {
            match event {
                Event::Ready => {
                    println!("iris-lifecycle: Ready ({case})");
                    if case == "profiles" {
                        for bad in ["..", "a/b", "a\\b", "has space", "."] {
                            assert_eq!(
                                session
                                    .create_browser_in_profile("about:blank", bad)
                                    .unwrap_err()
                                    .kind(),
                                ErrorKind::InvalidArgument
                            );
                        }
                        assert_eq!(
                            session
                                .create_browser_in_profile("about:blank", &"p".repeat(65))
                                .unwrap_err()
                                .kind(),
                            ErrorKind::InvalidArgument
                        );
                        alpha = Some(session.create_browser_in_profile(
                            "about:blank",
                            "alpha",
                        )?);
                        beta = Some(session.create_browser_in_profile(
                            "about:blank",
                            "beta",
                        )?);
                        delta = Some(session.create_browser_in_profile(
                            "about:blank",
                            "com9",
                        )?);
                    } else {
                        let browser = session.create_browser("about:blank")?;
                        first = Some(browser);
                        assert_eq!(
                            session
                                .command(browser, "Runtime.enable", json!({}))
                                .unwrap_err()
                                .kind(),
                            ErrorKind::NotReady
                        );
                        assert_eq!(
                            session.create_browser("").unwrap_err().kind(),
                            ErrorKind::InvalidArgument
                        );
                        if case == "close-pending" {
                            keeper = Some(session.create_browser("about:blank")?);
                        }
                    }
                }
                Event::BrowserCreated { browser } if case == "profiles" => {
                    const PROBE_URL: &str = "https://probe.invalid/";
                    if Some(browser) == alpha {
                        let id = session.command(browser, "Network.setCookie", json!({
                            "url": PROBE_URL, "name": "probe", "value": "alpha"
                        }))?;
                        pending.insert(id, ("set-alpha", started.elapsed()));
                    } else if Some(browser) == beta {
                        let id = session.command(browser, "Network.getCookies", json!({
                            "urls": [PROBE_URL]
                        }))?;
                        pending.insert(id, ("get-beta-empty", started.elapsed()));
                    } else if Some(browser) == gamma {
                        let id = session.command(browser, "Network.getCookies", json!({
                            "urls": [PROBE_URL]
                        }))?;
                        pending.insert(id, ("get-gamma-shared", started.elapsed()));
                    } else if Some(browser) == delta {
                        session.close_browser(browser)?;
                    }
                }
                Event::BrowserCreated { browser } if Some(browser) == first => {
                    if case == "panic" {
                        panic_triggered = true;
                        panic!("intentional callback panic with live browser");
                    }
                    if case == "crash" {
                        let id = session.command(browser, "Page.enable", json!({}))?;
                        pending.insert(id, ("enable-page", started.elapsed()));
                    }
                    let id = session.command(browser, "Runtime.evaluate", json!({
                        "expression": "new Promise(() => {})", "awaitPromise": true, "returnByValue": true
                    }))?;
                    pending.insert(id, ("unresolved", started.elapsed()));
                    let id = session.command(
                        browser,
                        "Runtime.evaluate",
                        json!({
                            "expression": IDENTITY_JS, "returnByValue": true
                        }),
                    )?;
                    pending.insert(id, ("barrier", started.elapsed()));
                }
                Event::CommandResult {
                    browser,
                    request,
                    result,
                } => {
                    assert!(completed.insert(request), "duplicate request completion");
                    let (kind, submitted) = pending.remove(&request).expect("untracked completion");
                    match kind {
                        "barrier" => {
                            let value = result?;
                            assert_eq!(value["result"]["value"]["webdriver"], "undefined");
                            assert_eq!(value["result"]["value"]["webdriverIn"], false);
                            identity = Some(value["result"]["value"].clone());
                            if case == "close-pending" {
                                session.close_browser(browser)?;
                            } else if case == "crash" {
                                let id = session.command(browser, "Page.crash", json!({}))?;
                                pending.insert(id, ("crash", started.elapsed()));
                            }
                        }
                        "unresolved" => {
                            let error =
                                result.expect_err("unresolved Promise unexpectedly completed");
                            if case == "timeout" {
                                assert_eq!(error.kind(), ErrorKind::Timeout);
                                assert!(
                                    started.elapsed().saturating_sub(submitted).as_secs() >= 30
                                );
                                timeout_seen = true;
                                let id = session.command(
                                    browser,
                                    "Runtime.evaluate",
                                    json!({"expression":"21*2","returnByValue":true}),
                                )?;
                                pending.insert(id, ("after-timeout", started.elapsed()));
                            } else {
                                assert!(matches!(
                                    error.kind(),
                                    ErrorKind::CommandCancelled
                                        | ErrorKind::BrowserClosed
                                        | ErrorKind::RendererTerminated
                                ));
                                cancellation_seen = true;
                            }
                        }
                        "after-timeout" => {
                            assert_eq!(result?["result"]["value"], 42);
                            session.close_browser(browser)?;
                        }
                        "crash" => {
                            let error = result.expect_err("Page.crash unexpectedly succeeded");
                            assert!(matches!(
                                error.kind(),
                                ErrorKind::CommandCancelled | ErrorKind::RendererTerminated
                            ));
                        }
                        "enable-page" => {
                            result?;
                        }
                        "recovery-navigation" => {
                            let value = result?;
                            assert!(
                                value.get("errorText").is_none(),
                                "renderer recovery navigation failed"
                            );
                        }
                        "recovery-identity" => {
                            assert_eq!(
                                result?["result"]["value"],
                                *identity.as_ref().unwrap(),
                                "recreated renderer changed first-script identity or canvas seed"
                            );
                            recovered = true;
                            session.close_browser(browser)?;
                        }
                        "set-alpha" => {
                            result?;
                            // 写入提交后再建同 profile 的第二个 browser，
                            // 保证共享存储的读取顺序确定。
                            gamma = Some(session.create_browser_in_profile(
                                "about:blank",
                                "alpha",
                            )?);
                            session.close_browser(browser)?;
                        }
                        "get-beta-empty" => {
                            let value = result?;
                            assert!(
                                value["cookies"].as_array().is_some_and(Vec::is_empty),
                                "beta profile must not see alpha cookies: {value}"
                            );
                            isolation_seen = true;
                            let id = session.command(browser, "Network.setCookie", json!({
                                "url": "https://probe.invalid/",
                                "name": "probe", "value": "beta"
                            }))?;
                            pending.insert(id, ("set-beta", started.elapsed()));
                        }
                        "set-beta" => {
                            result?;
                            let id = session.command(browser, "Network.getCookies", json!({
                                "urls": ["https://probe.invalid/"]
                            }))?;
                            pending.insert(id, ("get-beta-own", started.elapsed()));
                        }
                        "get-beta-own" => {
                            let value = result?;
                            assert!(
                                value["cookies"].as_array().is_some_and(|cookies| {
                                    cookies.iter().any(|c| c["value"] == "beta")
                                }),
                                "beta profile must see its own cookie: {value}"
                            );
                            session.close_browser(browser)?;
                        }
                        "get-gamma-shared" => {
                            let value = result?;
                            assert!(
                                value["cookies"].as_array().is_some_and(|cookies| {
                                    cookies.iter().any(|c| c["value"] == "alpha")
                                }),
                                "second alpha browser must share the profile store: {value}"
                            );
                            sharing_seen = true;
                            session.close_browser(browser)?;
                        }
                        _ => unreachable!(),
                    }
                }
                Event::RendererTerminated { browser, .. } => {
                    assert_eq!(case, "crash");
                    assert!(!crash_seen, "replacement renderer also terminated");
                    crash_seen = true;
                    let id = session.command(browser, "Page.navigate", json!({
                        "url": format!("data:text/html,<script>globalThis.__irisFirst={IDENTITY_JS}</script>")
                    }))?;
                    pending.insert(id, ("recovery-navigation", started.elapsed()));
                }
                Event::ProtocolEvent {
                    browser,
                    method,
                    params,
                } if crash_seen => {
                    if method == "Page.frameNavigated"
                        && params["frame"]["url"]
                            .as_str()
                            .is_some_and(|url| url.starts_with("data:text/html"))
                    {
                        recovery_frame_seen = true;
                    }
                    if method == "Page.loadEventFired" && recovery_frame_seen && !recovery_read_sent
                    {
                        recovery_read_sent = true;
                        let id = session.command(
                            browser,
                            "Runtime.evaluate",
                            json!({"expression":"globalThis.__irisFirst","returnByValue":true}),
                        )?;
                        pending.insert(id, ("recovery-identity", started.elapsed()));
                    }
                }
                Event::BrowserClosed { browser } => {
                    assert!(closed.insert(browser), "duplicate BrowserClosed");
                    assert_eq!(
                        session
                            .command(browser, "Runtime.enable", json!({}))
                            .unwrap_err()
                            .kind(),
                        ErrorKind::BrowserClosed
                    );
                    if Some(browser) == first {
                        if let Some(keeper) = keeper {
                            session.close_browser(keeper)?;
                        }
                    }
                }
                Event::LoadError { code, message, .. } => {
                    // profiles 用例的 browser 只加载 about:blank：deferred
                    // 创建使初始导航在关闭时仍可能在途，ERR_ABORTED(-3) 是
                    // 预期拆卸噪声；异步创建失败经 code=0 + 不同 message
                    // 上报，不被本分支掩盖。
                    if !(case == "profiles" && code == -3) {
                        return Err(Error::application(format!(
                            "unexpected load error {code}: {message}"
                        )));
                    }
                }
                _ => {}
            }
            Ok(())
        })();
        if let Err(error) = step {
            failure = Some(error);
            return ControlFlow::Break(());
        }
        ControlFlow::Continue(())
    });
    let observed_error = result.as_ref().err().map(|e| format!("{:?}", e.kind()));
    // run_started 只在配置校验通过后置位:首轮 InvalidArgument 未占用
    // 一次性运行标记,此时重复运行合法,跳过 AlreadyRun 探针,真正错误
    // 由下方 result? 报告。
    let repeated_kind = if matches!(
        result.as_ref().err().map(Error::kind),
        Some(ErrorKind::InvalidArgument)
    ) {
        None
    } else {
        Some(
            iris::run(
                Config::new(std::env::temp_dir().join("iris-repeat-unused"), 42),
                |_, _| ControlFlow::Break(()),
            )
            .unwrap_err()
            .kind(),
        )
    };
    let report = json!({
        "case": case, "runError": observed_error, "panicTriggered": panic_triggered,
        "crashSeen": crash_seen, "cancellationSeen": cancellation_seen, "timeoutSeen": timeout_seen,
        "rendererRecovered": recovered, "identity": identity,
        "repeatError": repeated_kind.map(|k| format!("{k:?}")),
        "isolationSeen": isolation_seen, "sharingSeen": sharing_seen,
        "pendingRemaining": pending.len(), "closedBrowsers": closed.len(),
        "completedRequests": completed.len(), "records": records
    });
    std::fs::write(
        output,
        serde_json::to_vec_pretty(&report).map_err(|e| Error::application(e.to_string()))?,
    )
    .map_err(|e| Error::application(e.to_string()))?;
    if case == "panic" {
        assert!(panic_triggered);
        assert_eq!(result.unwrap_err().kind(), ErrorKind::CallbackPanicked);
    } else {
        result?;
        if let Some(error) = failure {
            return Err(error);
        }
        assert!(pending.is_empty(), "pending commands leaked after shutdown");
        let expected_closed = match case.as_str() {
            "close-pending" => 2,
            "profiles" => 4,
            _ => 1,
        };
        assert_eq!(closed.len(), expected_closed);
        match case.as_str() {
            "close-pending" => assert!(cancellation_seen),
            "timeout" => assert!(timeout_seen),
            "crash" => assert!(crash_seen && cancellation_seen && recovered),
            "profiles" => assert!(isolation_seen && sharing_seen),
            _ => unreachable!(),
        }
    }
    if let Some(kind) = repeated_kind {
        assert_eq!(kind, ErrorKind::AlreadyRun);
    }
    println!("iris-lifecycle: {case} passed; repeated run rejected");
    Ok(())
}

iris::export_app!(app);
