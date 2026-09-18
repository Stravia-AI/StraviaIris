use std::collections::BTreeMap;
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddr, SocketAddrV4, TcpListener, TcpStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const INDEX: &str = include_str!("../fixtures/index.html");
const CONTEXT: &str = include_str!("../fixtures/context.html");
const PROBE: &str = include_str!("../fixtures/probe.js");
const WORKER: &str = include_str!("../fixtures/worker.js");
const SERVICE_WORKER: &str = include_str!("../fixtures/service-worker.js");
const FONT: &[u8] = include_bytes!("../fixtures/Ahem.ttf");
const MARKER: &str = "@@IRIS_NAVIGATION@@";
const ACCEPT_CH: &str = "Sec-CH-UA-Full-Version-List, Sec-CH-UA-Full-Version, Sec-CH-UA-Platform-Version, Sec-CH-UA-Arch, Sec-CH-UA-Bitness, Sec-CH-UA-Model, Sec-CH-UA-WoW64, Device-Memory";
const HEADER_LIMIT: usize = 32 * 1024;
const BODY_LIMIT: usize = 64 * 1024;
const IO_BUDGET: Duration = Duration::from_secs(10);

type ServiceResult = Result<(), String>;

/// An embedded, concurrent HTTP/1.1 fixture server. Each connection carries one
/// request. Stopping wakes blocking accept; the accept thread owns and joins all
/// connection threads before it returns.
pub struct FixtureServer {
    origin: String,
    address: SocketAddr,
    stopping: Arc<AtomicBool>,
    accept_thread: Option<JoinHandle<ServiceResult>>,
}

impl FixtureServer {
    pub fn start() -> Result<Self, iris::Error> {
        if INDEX.matches(MARKER).count() != 1 {
            return Err(iris::Error::application(
                "fixture index.html must contain exactly one navigation marker",
            ));
        }
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
            .map_err(|error| application("bind fixture listener", error))?;
        let address = listener
            .local_addr()
            .map_err(|error| application("read fixture listener address", error))?;
        let stopping = Arc::new(AtomicBool::new(false));
        let thread_stopping = Arc::clone(&stopping);
        let accept_thread = thread::Builder::new()
            .name("iris-fixture-accept".to_owned())
            .spawn(move || accept_connections(listener, thread_stopping))
            .map_err(|error| application("spawn fixture accept thread", error))?;
        Ok(Self {
            origin: format!("http://127.0.0.1:{}", address.port()),
            address,
            stopping,
            accept_thread: Some(accept_thread),
        })
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    pub fn finish(mut self) -> Result<(), iris::Error> {
        self.stop_and_join().map_err(iris::Error::application)
    }

    fn stop_and_join(&mut self) -> ServiceResult {
        let Some(handle) = self.accept_thread.take() else {
            return Ok(());
        };
        self.stopping.store(true, Ordering::Release);
        // Connecting is the wakeup, not a request. accept_connections checks the
        // stop flag immediately after accept and explicitly closes this socket.
        // A blocking local connect also handles a temporarily full accept queue:
        // the accept thread continues draining it until it observes stopping.
        let wake_result = TcpStream::connect(self.address);
        let mut errors = Vec::new();
        match wake_result {
            Ok(wake) => {
                let _ = wake.shutdown(Shutdown::Both);
                drop(wake);
            }
            Err(error) => errors.push(format!("wake fixture listener: {error}")),
        }
        match handle.join() {
            Ok(Ok(())) => {}
            Ok(Err(error)) => errors.push(error),
            Err(payload) => errors.push(format!(
                "fixture accept thread panicked: {}",
                panic_message(payload.as_ref())
            )),
        }
        combine_errors(errors)
    }
}

impl Drop for FixtureServer {
    fn drop(&mut self) {
        // finish is the error-reporting API. Drop must still perform all joins,
        // including when unwinding, but must never turn an error into a panic.
        let _ = self.stop_and_join();
    }
}

fn application(context: &str, error: impl std::fmt::Display) -> iris::Error {
    iris::Error::application(format!("{context}: {error}"))
}

fn panic_message(payload: &(dyn std::any::Any + Send)) -> &str {
    if let Some(message) = payload.downcast_ref::<String>() {
        message.as_str()
    } else if let Some(message) = payload.downcast_ref::<&str>() {
        message
    } else {
        "non-string panic payload"
    }
}

fn combine_errors(errors: Vec<String>) -> ServiceResult {
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("\n"))
    }
}

fn accept_connections(listener: TcpListener, stopping: Arc<AtomicBool>) -> ServiceResult {
    let mut connections = Vec::new();
    let mut errors = Vec::new();
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                if stopping.load(Ordering::Acquire) {
                    let _ = stream.shutdown(Shutdown::Both);
                    drop(stream);
                    break;
                }
                // Set bounds before handing ownership to the connection thread.
                if let Err(error) = stream.set_read_timeout(Some(IO_BUDGET)) {
                    errors.push(format!("set fixture read timeout: {error}"));
                    continue;
                }
                if let Err(error) = stream.set_write_timeout(Some(IO_BUDGET)) {
                    errors.push(format!("set fixture write timeout: {error}"));
                    continue;
                }
                match thread::Builder::new()
                    .name("iris-fixture-connection".to_owned())
                    .spawn(move || serve_connection(stream))
                {
                    Ok(handle) => connections.push(handle),
                    Err(error) => errors.push(format!("spawn fixture connection: {error}")),
                }
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => {
                errors.push(format!("accept fixture connection: {error}"));
                break;
            }
        }
    }
    // Close the listener, including queued connections, before joining workers.
    drop(listener);
    for handle in connections {
        match handle.join() {
            Ok(Ok(())) => {}
            Ok(Err(error)) => errors.push(error),
            Err(payload) => errors.push(format!(
                "fixture connection thread panicked: {}",
                panic_message(payload.as_ref())
            )),
        }
    }
    combine_errors(errors)
}

struct Request {
    method: String,
    path: String,
    headers: BTreeMap<String, String>,
    body: String,
}

enum ReadFailure {
    Io(io::Error),
    BadRequest(&'static str),
    TooLarge,
}

impl From<io::Error> for ReadFailure {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

fn remaining(deadline: Instant) -> io::Result<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|duration| !duration.is_zero())
        .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "fixture I/O deadline expired"))
}

fn read_some(stream: &mut TcpStream, bytes: &mut [u8], deadline: Instant) -> io::Result<usize> {
    stream.set_read_timeout(Some(remaining(deadline)?))?;
    stream.read(bytes)
}

fn token(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte)
}

fn read_request(stream: &mut TcpStream) -> Result<Request, ReadFailure> {
    let deadline = Instant::now() + IO_BUDGET;
    let mut bytes = Vec::new();
    let header_end;
    loop {
        if let Some(position) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            header_end = position + 4;
            break;
        }
        if bytes.len() >= HEADER_LIMIT {
            return Err(ReadFailure::TooLarge);
        }
        let mut chunk = [0_u8; 4096];
        let capacity = chunk.len().min(HEADER_LIMIT - bytes.len());
        let count = read_some(stream, &mut chunk[..capacity], deadline)?;
        if count == 0 {
            return Err(io::Error::from(io::ErrorKind::UnexpectedEof).into());
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    let header = std::str::from_utf8(&bytes[..header_end - 4])
        .map_err(|_| ReadFailure::BadRequest("headers must be UTF-8"))?;
    let mut lines = header.split("\r\n");
    let request_line = lines
        .next()
        .ok_or(ReadFailure::BadRequest("missing request line"))?;
    let parts: Vec<&str> = request_line.split(' ').collect();
    if parts.len() != 3
        || parts[0].is_empty()
        || !parts[0].bytes().all(token)
        || !parts[1].starts_with('/')
        || parts[1].contains('#')
        || parts[1].chars().any(char::is_control)
        || parts[2] != "HTTP/1.1"
    {
        return Err(ReadFailure::BadRequest("invalid HTTP/1.1 request line"));
    }
    let method = parts[0].to_owned();
    let path = parts[1].to_owned();
    let mut headers = BTreeMap::<String, String>::new();
    for line in lines {
        let (name, value) = line
            .split_once(':')
            .ok_or(ReadFailure::BadRequest("invalid header"))?;
        if name.is_empty() || !name.bytes().all(token) {
            return Err(ReadFailure::BadRequest("invalid header name"));
        }
        if value.chars().any(|ch| ch.is_control() && ch != '\t') {
            return Err(ReadFailure::BadRequest("invalid header value"));
        }
        let name = name.to_ascii_lowercase();
        let value = value.trim_matches([' ', '\t']);
        if headers.contains_key(&name)
            && matches!(
                name.as_str(),
                "host" | "content-length" | "content-type" | "transfer-encoding"
            )
        {
            return Err(ReadFailure::BadRequest(
                "duplicate framing or routing header",
            ));
        }
        headers
            .entry(name)
            .and_modify(|existing| {
                existing.push_str(", ");
                existing.push_str(value);
            })
            .or_insert_with(|| value.to_owned());
    }
    if headers.get("host").is_none_or(|host| host.is_empty()) {
        return Err(ReadFailure::BadRequest("Host is required"));
    }
    if headers.contains_key("transfer-encoding") {
        return Err(ReadFailure::BadRequest("Transfer-Encoding is unsupported"));
    }
    if headers.contains_key("expect") {
        return Err(ReadFailure::BadRequest("Expect is unsupported"));
    }
    let content_length = match headers.get("content-length") {
        None => 0,
        Some(value) => {
            if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(ReadFailure::BadRequest("invalid Content-Length"));
            }
            value
                .parse::<usize>()
                .map_err(|_| ReadFailure::BadRequest("Content-Length overflow"))?
        }
    };
    if content_length > BODY_LIMIT {
        return Err(ReadFailure::TooLarge);
    }
    let total = header_end + content_length;
    // Pipelining and bytes beyond the declared body are deliberately unsupported.
    if bytes.len() > total {
        return Err(ReadFailure::BadRequest("bytes beyond Content-Length"));
    }
    while bytes.len() < total {
        let mut chunk = [0_u8; 4096];
        let capacity = chunk.len().min(total - bytes.len());
        let count = read_some(stream, &mut chunk[..capacity], deadline)?;
        if count == 0 {
            return Err(io::Error::from(io::ErrorKind::UnexpectedEof).into());
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    let body = std::str::from_utf8(&bytes[header_end..total])
        .map_err(|_| ReadFailure::BadRequest("body must be UTF-8"))?
        .to_owned();
    Ok(Request {
        method,
        path,
        headers,
        body,
    })
}

fn normal_disconnect(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::BrokenPipe
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::NotConnected
            | io::ErrorKind::UnexpectedEof
    )
}

fn serve_connection(mut stream: TcpStream) -> ServiceResult {
    let response = match read_request(&mut stream) {
        Ok(request) => route(&request),
        Err(ReadFailure::BadRequest(message)) => Response::text("400 Bad Request", message),
        Err(ReadFailure::TooLarge) => Response::text("413 Content Too Large", "request too large"),
        Err(ReadFailure::Io(error)) if normal_disconnect(&error) => return Ok(()),
        // Chromium may open speculative connections without sending any request.
        // These bounds terminate a connection; they never drive a retry loop.
        Err(ReadFailure::Io(error))
            if matches!(
                error.kind(),
                io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
            ) =>
        {
            return Ok(());
        }
        Err(ReadFailure::Io(error)) => return Err(format!("read fixture request: {error}")),
    };
    match response.write_to(&mut stream) {
        Ok(()) => Ok(()),
        Err(error) if normal_disconnect(&error) => Ok(()),
        Err(error) => Err(format!("write fixture response: {error}")),
    }
}

struct Response {
    status: &'static str,
    mime: &'static str,
    body: Vec<u8>,
    redirect: bool,
}

impl Response {
    fn new(status: &'static str, mime: &'static str, body: impl Into<Vec<u8>>) -> Self {
        Self {
            status,
            mime,
            body: body.into(),
            redirect: false,
        }
    }

    fn text(status: &'static str, body: &str) -> Self {
        Self::new(status, "text/plain; charset=utf-8", body.as_bytes())
    }

    fn json(body: String) -> Self {
        Self::new(
            "200 OK",
            "application/json; charset=utf-8",
            body.into_bytes(),
        )
    }

    fn write_to(self, stream: &mut TcpStream) -> io::Result<()> {
        let location = if self.redirect {
            "Location: /echo?redirected=1\r\n"
        } else {
            ""
        };
        let head = format!(
            "HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nAccept-CH: {}\r\n{}\r\n",
            self.status,
            self.mime,
            self.body.len(),
            ACCEPT_CH,
            location
        );
        let deadline = Instant::now() + IO_BUDGET;
        write_bounded(stream, head.as_bytes(), deadline)?;
        write_bounded(stream, &self.body, deadline)
    }
}

fn write_bounded(stream: &mut TcpStream, mut bytes: &[u8], deadline: Instant) -> io::Result<()> {
    while !bytes.is_empty() {
        stream.set_write_timeout(Some(remaining(deadline)?))?;
        let count = stream.write(bytes)?;
        if count == 0 {
            return Err(io::Error::from(io::ErrorKind::WriteZero));
        }
        bytes = &bytes[count..];
    }
    Ok(())
}

fn route(request: &Request) -> Response {
    let path = request
        .path
        .split_once('?')
        .map_or(request.path.as_str(), |(path, _)| path);
    // Echo endpoints intentionally accept different methods so their JSON always
    // describes the actual request rather than an assumed navigation method.
    match path {
        "/echo" | "/accept-ch" => return Response::json(request_json(request)),
        "/submit" => return submit(request),
        _ => {}
    }
    if request.method != "GET" {
        return Response::text("405 Method Not Allowed", "GET required");
    }
    match path {
        "/" | "/index.html" => Response::new(
            "200 OK",
            "text/html; charset=utf-8",
            INDEX.replacen(MARKER, &request_json(request), 1).into_bytes(),
        ),
        "/context.html" => Response::new("200 OK", "text/html; charset=utf-8", CONTEXT.as_bytes()),
        "/probe.js" => Response::new("200 OK", "text/javascript; charset=utf-8", PROBE.as_bytes()),
        "/worker.js" => Response::new("200 OK", "text/javascript; charset=utf-8", WORKER.as_bytes()),
        "/service-worker.js" => Response::new(
            "200 OK", "text/javascript; charset=utf-8", SERVICE_WORKER.as_bytes(),
        ),
        "/fonts/Ahem.ttf" => Response::new("200 OK", "font/ttf", FONT),
        "/redirect" => {
            let mut response = Response::text("302 Found", "redirecting");
            response.redirect = true;
            response
        }
        "/complete" => Response::new(
            "200 OK",
            "text/html; charset=utf-8",
            b"<!doctype html><html><head><meta charset=\"utf-8\"><title>Complete</title></head><body data-iris-complete=\"true\">Complete</body></html>".as_slice(),
        ),
        "/favicon.ico" => Response::new("204 No Content", "image/x-icon", Vec::new()),
        _ => Response::text("404 Not Found", "not found"),
    }
}

fn measured_header(name: &str) -> bool {
    name.starts_with("sec-ch-")
        || matches!(
            name,
            "host"
                | "user-agent"
                | "accept-language"
                | "device-memory"
                | "origin"
                | "sec-fetch-site"
                | "sec-fetch-mode"
                | "sec-fetch-dest"
                | "sec-fetch-user"
                | "content-type"
                | "accept"
                | "save-data"
                | "dpr"
                | "width"
                | "viewport-width"
        )
}

fn request_json(request: &Request) -> String {
    let mut json = String::from("{\"method\":");
    json_string(&mut json, &request.method);
    json.push_str(",\"path\":");
    json_string(&mut json, &request.path);
    json.push_str(",\"headers\":{");
    let mut first = true;
    for (name, value) in &request.headers {
        if !measured_header(name) {
            continue;
        }
        if !first {
            json.push(',');
        }
        first = false;
        json_string(&mut json, name);
        json.push(':');
        json_string(&mut json, value);
    }
    json.push_str("}}");
    json
}

// JSON strings are also safe as inline HTML script data. In particular, a
// request target or header cannot introduce a literal closing script tag.
fn json_string(output: &mut String, value: &str) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    output.push('"');
    for ch in value.chars() {
        match ch {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '<' => output.push_str("\\u003c"),
            '>' => output.push_str("\\u003e"),
            '&' => output.push_str("\\u0026"),
            '\u{2028}' => output.push_str("\\u2028"),
            '\u{2029}' => output.push_str("\\u2029"),
            '\u{0000}'..='\u{001f}' => {
                let byte = ch as u8;
                output.push_str("\\u00");
                output.push(char::from(HEX[usize::from(byte >> 4)]));
                output.push(char::from(HEX[usize::from(byte & 15)]));
            }
            _ => output.push(ch),
        }
    }
    output.push('"');
}

fn submit(request: &Request) -> Response {
    if request.method != "POST" {
        return Response::text("405 Method Not Allowed", "POST required");
    }
    let Some(content_type) = request.headers.get("content-type") else {
        return Response::text("415 Unsupported Media Type", "form content type required");
    };
    let mut content_type_parts = content_type.split(';');
    if !content_type_parts
        .next()
        .unwrap_or("")
        .trim()
        .eq_ignore_ascii_case("application/x-www-form-urlencoded")
    {
        return Response::text("415 Unsupported Media Type", "form content type required");
    }
    for parameter in content_type_parts {
        let Some((name, value)) = parameter.trim().split_once('=') else {
            return Response::text(
                "415 Unsupported Media Type",
                "invalid content type parameter",
            );
        };
        if !name.trim().eq_ignore_ascii_case("charset")
            || !value.trim().trim_matches('"').eq_ignore_ascii_case("utf-8")
        {
            return Response::text(
                "415 Unsupported Media Type",
                "only UTF-8 forms are supported",
            );
        }
    }
    if !request.headers.contains_key("content-length") {
        return Response::text("411 Length Required", "Content-Length required");
    }
    let mut value = None;
    for field in request.body.split('&') {
        if field.is_empty() {
            continue;
        }
        let (key, encoded) = field.split_once('=').unwrap_or((field, ""));
        let (Ok(key), Ok(decoded)) = (form_decode(key), form_decode(encoded)) else {
            return Response::text("400 Bad Request", "invalid UTF-8 form encoding");
        };
        if key == "name" {
            if value.replace(decoded).is_some() {
                return Response::text("400 Bad Request", "duplicate name field");
            }
        }
    }
    let Some(value) = value else {
        return Response::text("400 Bad Request", "missing name field");
    };
    let mut json = String::from("{\"value\":");
    json_string(&mut json, &value);
    json.push_str(",\"method\":\"POST\"}");
    Response::json(json)
}

fn form_decode(value: &str) -> Result<String, ()> {
    let mut decoded = Vec::with_capacity(value.len());
    let mut bytes = value.bytes();
    while let Some(byte) = bytes.next() {
        match byte {
            b'+' => decoded.push(b' '),
            b'%' => {
                let high = hex_value(bytes.next().ok_or(())?).ok_or(())?;
                let low = hex_value(bytes.next().ok_or(())?).ok_or(())?;
                decoded.push((high << 4) | low);
            }
            _ => decoded.push(byte),
        }
    }
    String::from_utf8(decoded).map_err(|_| ())
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}
