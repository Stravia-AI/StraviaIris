mod options;
mod server;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use iris::serde_json::{self, Value, json};
use iris::{BrowserId, ControlFlow, Error, Event, RequestId, Session, WindowMode};
use options::Options;
use std::collections::BTreeMap;

const BUILD_ID: &str = include_str!("../../../crates/iris-sys/engine-build-id.txt");
const LOADED: &str = "if(document.readyState !== 'complete') await new Promise(resolve => window.addEventListener('load', resolve, {once:true}));";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Task {
    Page,
    Lifecycle,
    Runtime,
    Permission,
    Version,
    Navigate,
    Probe,
    Focus,
    Insert,
    Submit,
    Metrics,
    Screenshot,
    CompleteNavigate,
    Complete,
}

struct Navigation {
    final_page: bool,
    ack: Option<(String, String)>,
    committed: Option<(String, String)>,
    loaded: Option<(String, String)>,
}

struct Client<'a> {
    options: &'a Options,
    origin: String,
    url: String,
    browser: Option<BrowserId>,
    pending: BTreeMap<RequestId, Task>,
    contexts: BTreeMap<i64, String>,
    context: Option<i64>,
    navigation: Option<Navigation>,
    version: Option<Value>,
    probe: Option<Value>,
    submission: Option<Value>,
    metrics: Option<Value>,
    screenshot: Option<Vec<u8>>,
    completion: Option<Value>,
    done: bool,
}

fn failure(message: impl Into<String>) -> Error {
    Error::application(message)
}
fn string(value: &Value, key: &str) -> Result<String, Error> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| failure(format!("missing string {key}: {value}")))
}
fn evaluated(value: Value) -> Result<Value, Error> {
    if value.get("exceptionDetails").is_some() {
        return Err(failure(format!("JavaScript exception: {value}")));
    }
    value
        .get("result")
        .and_then(|v| v.get("value"))
        .cloned()
        .ok_or_else(|| failure(format!("evaluation did not return JSON by value: {value}")))
}

impl Client<'_> {
    fn send(
        &mut self,
        session: &mut Session<'_>,
        task: Task,
        method: &str,
        params: Value,
    ) -> Result<(), Error> {
        let browser = self.browser.ok_or_else(|| failure("browser unavailable"))?;
        let id = session.command(browser, method, params)?;
        self.pending.insert(id, task);
        Ok(())
    }

    fn evaluate(&mut self, session: &mut Session<'_>, task: Task, body: &str) -> Result<(), Error> {
        let context = self
            .context
            .ok_or_else(|| failure("main execution context unavailable"))?;
        self.send(
            session,
            task,
            "Runtime.evaluate",
            json!({
                "expression": format!("(async () => {{ {body} }})()"),
                "contextId": context, "awaitPromise": true, "returnByValue": true
            }),
        )
    }

    fn navigate(&mut self, session: &mut Session<'_>, final_page: bool) -> Result<(), Error> {
        // Old contexts must never be selected for the new document, even if the
        // navigate response arrives before executionContextsCleared.
        self.contexts.clear();
        self.context = None;
        self.navigation = Some(Navigation {
            final_page,
            ack: None,
            committed: None,
            loaded: None,
        });
        let url = if final_page {
            format!("{}/complete", self.origin)
        } else {
            self.url.clone()
        };
        self.send(
            session,
            if final_page {
                Task::CompleteNavigate
            } else {
                Task::Navigate
            },
            "Page.navigate",
            json!({"url": url}),
        )
    }

    fn maybe_evaluate(&mut self, session: &mut Session<'_>) -> Result<(), Error> {
        let Some(nav) = &self.navigation else {
            return Ok(());
        };
        let Some((frame, loader)) = &nav.ack else {
            return Ok(());
        };
        if !self.options.self_test {
            // 普通网页可以主动替换文档；不能把旧 context 的 load Promise
            // 当作浏览器生命周期。只接受当前主文档的原生加载事件。
            if nav.committed.as_ref().is_none_or(|(id, _)| id != frame)
                || nav.loaded != nav.committed
            {
                return Ok(());
            }
            self.navigation = None;
            if self.options.mode == WindowMode::Windowless && self.options.cdp.is_none() {
                self.done = true;
            }
            return Ok(());
        }
        if nav.committed.as_ref() != Some(&(frame.clone(), loader.clone())) {
            return Ok(());
        }
        let Some((&context, _)) = self.contexts.iter().find(|(_, f)| *f == frame) else {
            return Ok(());
        };
        let final_page = nav.final_page;
        self.context = Some(context);
        self.navigation = None;
        if final_page {
            self.evaluate(session, Task::Complete, &format!("{LOADED} return {{url:location.href, complete:document.body?.dataset.irisComplete === 'true'}};"))
        } else {
            self.evaluate(session, Task::Probe, &format!("{LOADED} if (!(window.irisProbe instanceof Promise)) throw new Error('irisProbe is not a Promise'); return await window.irisProbe;"))
        }
    }

    fn response(
        &mut self,
        session: &mut Session<'_>,
        task: Task,
        value: Value,
    ) -> Result<(), Error> {
        match task {
            Task::Page => {
                if self.options.self_test {
                    self.send(session, Task::Runtime, "Runtime.enable", json!({}))?;
                } else {
                    self.send(session, Task::Lifecycle, "Page.setLifecycleEventsEnabled", json!({"enabled":true}))?;
                }
            }
            Task::Lifecycle => self.send(session, Task::Runtime, "Runtime.enable", json!({}))?,
            Task::Runtime => self.send(session, Task::Permission, "Browser.setPermission", json!({
                "permission":{"name":"local-fonts"}, "setting":"granted", "origin":self.origin
            }))?,
            Task::Permission => self.send(session, Task::Version, "Browser.getVersion", json!({}))?,
            Task::Version => { self.version = Some(value); self.navigate(session, false)?; }
            Task::Navigate | Task::CompleteNavigate => {
                if value.get("errorText").is_some() || value.get("isDownload") == Some(&Value::Bool(true)) {
                    return Err(failure(format!("navigation failed: {value}")));
                }
                let frame = string(&value, "frameId")?;
                let loader = string(&value, "loaderId")?;
                let nav = self.navigation.as_mut().ok_or_else(|| failure("unexpected navigation response"))?;
                nav.ack = Some((frame, loader));
                self.maybe_evaluate(session)?;
            }
            Task::Probe => {
                let probe = evaluated(value)?;
                let checks = probe.get("checks").and_then(Value::as_array)
                    .filter(|checks| !checks.is_empty()).ok_or_else(|| failure("probe checks must be a nonempty array"))?;
                let webgpu_unavailable = probe.pointer("/raw/webgpu").is_some_and(|gpu| {
                    gpu.get("supported") == Some(&Value::Bool(false))
                        && gpu.get("error").is_none() && gpu.get("timeout").is_none()
                        && matches!(gpu.get("unavailable").and_then(Value::as_str),
                            Some("api-unavailable" | "adapter-unavailable"))
                });
                let failed: Vec<_> = checks.iter().filter(|check| {
                    let optional_unavailable = webgpu_unavailable
                        && check.get("passed") == Some(&Value::Bool(false))
                        && check.get("status").and_then(Value::as_str) == Some("unsupported")
                        && matches!(check.get("id").and_then(Value::as_str),
                            Some("webgpu-adapter-metadata" | "webgpu-render"));
                    !check.is_object() || check.get("id").and_then(Value::as_str).is_none_or(str::is_empty)
                        || (check.get("passed") != Some(&Value::Bool(true)) && !optional_unavailable)
                }).collect();
                if !probe.is_object() || !failed.is_empty() {
                    let directory = self.options.output.as_ref().ok_or_else(|| failure("missing output directory"))?;
                    std::fs::create_dir_all(directory).map_err(|e| failure(format!("create output directory: {e}")))?;
                    let bytes = serde_json::to_vec_pretty(&probe).map_err(|e| failure(format!("serialize failed probe: {e}")))?;
                    std::fs::write(directory.join("probe-failure.json"), bytes)
                        .map_err(|e| failure(format!("write failed probe: {e}")))?;
                    let ids: Vec<_> = failed.iter().map(|check| check["id"].as_str().unwrap_or("<malformed>")).collect();
                    return Err(failure(format!("probe checks failed (probe-failure.json): {}", ids.join(", "))));
                }
                if probe.get("irisSdk").is_some() { return Err(failure("probe uses reserved irisSdk report field")); }
                self.probe = Some(probe);
                self.evaluate(session, Task::Focus, "const input=document.querySelector('input#name'); if(!input) throw new Error('missing name input'); input.focus(); if(document.activeElement!==input) throw new Error('focus failed'); return true;")?;
            }
            Task::Focus => {
                if evaluated(value)? != Value::Bool(true) { return Err(failure("focus failed")); }
                self.send(session, Task::Insert, "Input.insertText", json!({"text":"StraviaIris"}))?;
            }
            Task::Insert => self.evaluate(session, Task::Submit, "const form=document.querySelector('form#demo-form'); const input=document.querySelector('input#name'); if(!form || input?.value!=='StraviaIris') throw new Error('input insertion failed'); form.requestSubmit(); if(!(window.irisSubmission instanceof Promise)) throw new Error('irisSubmission is not a Promise'); return await window.irisSubmission;")?,
            Task::Submit => {
                let submission = evaluated(value)?;
                if submission.get("value").and_then(Value::as_str) != Some("StraviaIris")
                    || submission.get("method").and_then(Value::as_str) != Some("POST") {
                    return Err(failure(format!("server submission failed: {submission}")));
                }
                self.submission = Some(submission);
                self.send(session, Task::Metrics, "Page.getLayoutMetrics", json!({}))?;
            }
            Task::Metrics => {
                self.metrics = Some(value);
                self.send(session, Task::Screenshot, "Page.captureScreenshot", json!({"format":"png"}))?;
            }
            Task::Screenshot => {
                let data = STANDARD.decode(string(&value, "data")?)
                    .map_err(|e| failure(format!("invalid screenshot base64: {e}")))?;
                if !data.starts_with(b"\x89PNG\r\n\x1a\n") { return Err(failure("screenshot is not PNG")); }
                self.screenshot = Some(data);
                self.navigate(session, true)?;
            }
            Task::Complete => {
                let result = evaluated(value)?;
                let expected = format!("{}/complete", self.origin);
                if result.get("complete") != Some(&Value::Bool(true))
                    || result.get("url").and_then(Value::as_str) != Some(expected.as_str()) {
                    return Err(failure(format!("final document verification failed: {result}")));
                }
                self.completion = Some(result);
                self.done = true;
            }
        }
        Ok(())
    }

    fn event(&mut self, session: &mut Session<'_>, event: Event) -> Result<(), Error> {
        match event {
            Event::Ready => {
                println!("iris-demo: Ready");
                self.browser = Some(session.create_browser("about:blank")?);
            }
            Event::BrowserCreated { browser } if Some(browser) == self.browser => {
                self.send(session, Task::Page, "Page.enable", json!({}))?;
            }
            Event::CommandResult {
                browser,
                request,
                result,
            } if Some(browser) == self.browser => {
                let task = self
                    .pending
                    .remove(&request)
                    .ok_or_else(|| failure(format!("untracked request {request}")))?;
                self.response(session, task, result?)?;
            }
            Event::ProtocolEvent {
                browser,
                method,
                params,
            } if Some(browser) == self.browser => {
                match method.as_str() {
                    "Page.frameNavigated" => {
                        let frame = &params["frame"];
                        if frame.get("parentId").is_none() {
                            if let Some(nav) = self.navigation.as_mut() {
                                nav.committed =
                                    Some((string(frame, "id")?, string(frame, "loaderId")?));
                            }
                        }
                    }
                    "Page.lifecycleEvent" if !self.options.self_test => {
                        if params["name"] == "load" {
                            let document =
                                (string(&params, "frameId")?, string(&params, "loaderId")?);
                            if let Some(nav) = self.navigation.as_mut() {
                                if nav.committed.as_ref() == Some(&document) {
                                    nav.loaded = Some(document);
                                }
                            }
                        }
                    }
                    "Runtime.executionContextCreated" => {
                        let ctx = &params["context"];
                        if ctx["auxData"]["isDefault"] == Value::Bool(true) {
                            let id = ctx["id"]
                                .as_i64()
                                .ok_or_else(|| failure("invalid execution context ID"))?;
                            let frame = string(&ctx["auxData"], "frameId")?;
                            self.contexts.insert(id, frame);
                        }
                    }
                    "Runtime.executionContextDestroyed" => {
                        let id = params["executionContextId"]
                            .as_i64()
                            .ok_or_else(|| failure("invalid destroyed context ID"))?;
                        self.contexts.remove(&id);
                        if self.context == Some(id) {
                            if self.options.self_test {
                                return Err(failure("selected main context was destroyed"));
                            }
                            self.context = None;
                        }
                    }
                    "Runtime.executionContextsCleared" => {
                        self.contexts.clear();
                        if self.context.take().is_some() && self.options.self_test {
                            return Err(failure("selected main context was cleared"));
                        }
                    }
                    _ => {}
                }
                self.maybe_evaluate(session)?;
            }
            Event::LoadError {
                browser,
                code,
                message,
                url,
            } => {
                return Err(failure(format!(
                    "LoadError browser={browser} code={code} url={url}: {message}"
                )));
            }
            Event::RendererTerminated {
                browser,
                status,
                error_code,
            } => {
                return Err(failure(format!(
                    "RendererTerminated browser={browser} status={status} error_code={error_code}"
                )));
            }
            Event::BrowserClosed { browser } if Some(browser) == self.browser => {
                if self.options.self_test && !self.done {
                    return Err(failure("browser closed before self-test completed"));
                }
                self.done = true;
            }
            _ => {}
        }
        Ok(())
    }

    fn write_report(&mut self) -> Result<(), Error> {
        if !self.done {
            return Err(failure("self-test did not complete"));
        }
        let directory = self
            .options
            .output
            .as_ref()
            .ok_or_else(|| failure("missing output directory"))?;
        let mut report = self.probe.take().ok_or_else(|| failure("missing probe"))?;
        let version = self
            .version
            .take()
            .ok_or_else(|| failure("missing Browser.getVersion"))?;
        let metrics = self
            .metrics
            .take()
            .ok_or_else(|| failure("missing layout metrics"))?;
        let submission = self
            .submission
            .take()
            .ok_or_else(|| failure("missing submission"))?;
        let completion = self
            .completion
            .take()
            .ok_or_else(|| failure("missing completion"))?;
        let screenshot = self
            .screenshot
            .take()
            .ok_or_else(|| failure("missing screenshot"))?;
        report.as_object_mut().ok_or_else(|| failure("probe is not an object"))?.insert("irisSdk".into(), json!({
            "browserVersion":version, "bindingBuildId":BUILD_ID.trim(),
            "seed":self.options.seed,
            "windowMode":if self.options.mode == WindowMode::Windowed { "windowed" } else { "headless" },
            "layoutMetrics":metrics, "submission":submission, "finalNavigation":completion
        }));
        let bytes = serde_json::to_vec_pretty(&report)
            .map_err(|e| failure(format!("serialize report: {e}")))?;
        std::fs::create_dir_all(directory)
            .map_err(|e| failure(format!("create output directory: {e}")))?;
        std::fs::write(directory.join("screenshot.png"), screenshot)
            .map_err(|e| failure(format!("write screenshot: {e}")))?;
        std::fs::write(directory.join("report.json"), bytes)
            .map_err(|e| failure(format!("write report: {e}")))?;
        Ok(())
    }
}

fn app() -> Result<(), Error> {
    let Some(options) = options::parse()? else {
        return Ok(());
    };
    let server = server::FixtureServer::start()?;
    let origin = server.origin().to_owned();
    let mut config =
        iris::Config::new(options.cache.clone(), options.seed).window_mode(options.mode);
    if let Some(zone) = &options.timezone {
        config = config.timezone(zone.clone());
    }
    if let Some(port) = options.cdp {
        config = config.remote_debugging_port(port);
    }
    let mut client = Client {
        options: &options,
        url: options.url.clone().unwrap_or_else(|| format!("{origin}/")),
        origin,
        browser: None,
        pending: BTreeMap::new(),
        contexts: BTreeMap::new(),
        context: None,
        navigation: None,
        version: None,
        probe: None,
        submission: None,
        metrics: None,
        screenshot: None,
        completion: None,
        done: false,
    };
    let mut callback_error = None;
    let run_result = iris::run(config, |session, event| {
        // Break initiates native close/drain; subsequent drain events must not
        // overwrite the original failure or issue any new commands.
        if callback_error.is_some() || client.done {
            return ControlFlow::Break(());
        }
        if let Err(error) = client.event(session, event) {
            callback_error = Some(error);
            return ControlFlow::Break(());
        }
        if client.done {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    });
    let finish_result = server.finish();
    if let Some(error) = callback_error {
        if let Err(secondary) = run_result {
            eprintln!("run cleanup: {secondary}");
        }
        if let Err(secondary) = finish_result {
            eprintln!("server cleanup: {secondary}");
        }
        return Err(error);
    }
    if let Err(error) = run_result {
        if let Err(secondary) = finish_result {
            eprintln!("server cleanup: {secondary}");
        }
        return Err(error);
    }
    finish_result?;
    if options.self_test {
        client.write_report()?;
    }
    Ok(())
}

iris::export_app!(app);
