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
    if !["close-pending", "panic", "timeout", "crash"].contains(&case.as_str()) {
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
                    return Err(Error::application(format!(
                        "unexpected load error {code}: {message}"
                    )));
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
    let repeated = iris::run(
        Config::new(std::env::temp_dir().join("iris-repeat-unused"), 42),
        |_, _| ControlFlow::Break(()),
    );
    let repeated_kind = repeated.unwrap_err().kind();
    let report = json!({
        "case": case, "runError": observed_error, "panicTriggered": panic_triggered,
        "crashSeen": crash_seen, "cancellationSeen": cancellation_seen, "timeoutSeen": timeout_seen,
        "rendererRecovered": recovered, "identity": identity, "repeatError": format!("{repeated_kind:?}"),
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
        assert_eq!(closed.len(), if case == "close-pending" { 2 } else { 1 });
        match case.as_str() {
            "close-pending" => assert!(cancellation_seen),
            "timeout" => assert!(timeout_seen),
            "crash" => assert!(crash_seen && cancellation_seen && recovered),
            _ => unreachable!(),
        }
    }
    assert_eq!(repeated_kind, ErrorKind::AlreadyRun);
    println!("iris-lifecycle: {case} passed; repeated run rejected");
    Ok(())
}

iris::export_app!(app);
