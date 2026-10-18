//! A small, blocking, `reqwest`-shaped HTTP client for the Arnis web build.
//!
//! The browser has no sockets, so every request is handed to JavaScript, which
//! performs it with a synchronous `XMLHttpRequest`. Synchronous requests are
//! allowed in Web Workers, and every thread of the Emscripten build is a
//! worker, so the generator's blocking call sites keep working unchanged.
//!
//! Only the slice of the `reqwest` API that Arnis actually uses is provided.
//! The crate is swapped in for `reqwest` on `target_os = "emscripten"` with
//! `extern crate arnis_web_reqwest as reqwest;` at the crate root.

use std::fmt;
use std::io::{self, Cursor, Read};
use std::time::Duration;

pub use bytes::Bytes;

mod ffi;
pub mod header;

pub use header::{HeaderMap, HeaderName, HeaderValue};

/// Alias matching `reqwest::Result`.
pub type Result<T> = std::result::Result<T, Error>;

// ---------------------------------------------------------------------------
// Status codes
// ---------------------------------------------------------------------------

/// An HTTP status code.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct StatusCode(u16);

impl StatusCode {
    pub const CONTINUE: Self = Self(100);
    pub const OK: Self = Self(200);
    pub const CREATED: Self = Self(201);
    pub const ACCEPTED: Self = Self(202);
    pub const NO_CONTENT: Self = Self(204);
    pub const PARTIAL_CONTENT: Self = Self(206);
    pub const MOVED_PERMANENTLY: Self = Self(301);
    pub const FOUND: Self = Self(302);
    pub const NOT_MODIFIED: Self = Self(304);
    pub const BAD_REQUEST: Self = Self(400);
    pub const UNAUTHORIZED: Self = Self(401);
    pub const FORBIDDEN: Self = Self(403);
    pub const NOT_FOUND: Self = Self(404);
    pub const REQUEST_TIMEOUT: Self = Self(408);
    pub const GONE: Self = Self(410);
    pub const RANGE_NOT_SATISFIABLE: Self = Self(416);
    pub const TOO_MANY_REQUESTS: Self = Self(429);
    pub const INTERNAL_SERVER_ERROR: Self = Self(500);
    pub const BAD_GATEWAY: Self = Self(502);
    pub const SERVICE_UNAVAILABLE: Self = Self(503);
    pub const GATEWAY_TIMEOUT: Self = Self(504);

    pub fn from_u16(code: u16) -> std::result::Result<Self, InvalidStatusCode> {
        if (100..1000).contains(&code) {
            Ok(Self(code))
        } else {
            Err(InvalidStatusCode)
        }
    }

    pub fn as_u16(&self) -> u16 {
        self.0
    }

    pub fn as_str(&self) -> String {
        self.0.to_string()
    }

    pub fn is_informational(&self) -> bool {
        (100..200).contains(&self.0)
    }

    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.0)
    }

    pub fn is_redirection(&self) -> bool {
        (300..400).contains(&self.0)
    }

    pub fn is_client_error(&self) -> bool {
        (400..500).contains(&self.0)
    }

    pub fn is_server_error(&self) -> bool {
        (500..600).contains(&self.0)
    }

    pub fn canonical_reason(&self) -> Option<&'static str> {
        Some(match self.0 {
            200 => "OK",
            201 => "Created",
            204 => "No Content",
            206 => "Partial Content",
            301 => "Moved Permanently",
            302 => "Found",
            304 => "Not Modified",
            400 => "Bad Request",
            401 => "Unauthorized",
            403 => "Forbidden",
            404 => "Not Found",
            408 => "Request Timeout",
            410 => "Gone",
            416 => "Range Not Satisfiable",
            429 => "Too Many Requests",
            500 => "Internal Server Error",
            502 => "Bad Gateway",
            503 => "Service Unavailable",
            504 => "Gateway Timeout",
            _ => return None,
        })
    }
}

impl fmt::Display for StatusCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.canonical_reason() {
            Some(reason) => write!(f, "{} {}", self.0, reason),
            None => write!(f, "{}", self.0),
        }
    }
}

impl fmt::Debug for StatusCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(&self.0, f)
    }
}

impl From<StatusCode> for u16 {
    fn from(status: StatusCode) -> u16 {
        status.0
    }
}

impl PartialEq<u16> for StatusCode {
    fn eq(&self, other: &u16) -> bool {
        self.0 == *other
    }
}

/// Returned by [`StatusCode::from_u16`] for a code outside 100..=999.
#[derive(Debug)]
pub struct InvalidStatusCode;

impl fmt::Display for InvalidStatusCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("invalid status code")
    }
}

impl std::error::Error for InvalidStatusCode {}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ErrorKind {
    Builder,
    Request,
    Timeout,
    Connect,
    Status,
    Decode,
    Body,
}

/// The error type of every fallible call, shaped like `reqwest::Error`.
#[derive(Debug)]
pub struct Error {
    kind: ErrorKind,
    url: Option<String>,
    status: Option<StatusCode>,
    message: String,
}

impl Error {
    fn new(kind: ErrorKind, url: Option<&str>, message: impl Into<String>) -> Self {
        Self {
            kind,
            url: url.map(str::to_string),
            status: None,
            message: message.into(),
        }
    }

    fn status_error(url: &str, status: StatusCode) -> Self {
        Self {
            kind: ErrorKind::Status,
            url: Some(url.to_string()),
            status: Some(status),
            message: format!("HTTP status {status}"),
        }
    }

    pub fn is_builder(&self) -> bool {
        self.kind == ErrorKind::Builder
    }

    pub fn is_request(&self) -> bool {
        matches!(self.kind, ErrorKind::Request | ErrorKind::Connect)
    }

    pub fn is_timeout(&self) -> bool {
        self.kind == ErrorKind::Timeout
    }

    pub fn is_connect(&self) -> bool {
        self.kind == ErrorKind::Connect
    }

    pub fn is_status(&self) -> bool {
        self.kind == ErrorKind::Status
    }

    pub fn is_decode(&self) -> bool {
        self.kind == ErrorKind::Decode
    }

    pub fn is_body(&self) -> bool {
        self.kind == ErrorKind::Body
    }

    pub fn is_redirect(&self) -> bool {
        false
    }

    pub fn status(&self) -> Option<StatusCode> {
        self.status
    }

    pub fn url(&self) -> Option<&str> {
        self.url.as_deref()
    }

    pub fn without_url(mut self) -> Self {
        self.url = None;
        self
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let what = match self.kind {
            ErrorKind::Builder => "builder error",
            ErrorKind::Request => "error sending request",
            ErrorKind::Timeout => "operation timed out",
            ErrorKind::Connect => "error sending request (network or CORS failure)",
            ErrorKind::Status => "HTTP status error",
            ErrorKind::Decode => "error decoding response body",
            ErrorKind::Body => "request or response body error",
        };
        write!(f, "{what}")?;
        if let Some(url) = &self.url {
            write!(f, " for url ({url})")?;
        }
        if !self.message.is_empty() {
            write!(f, ": {}", self.message)?;
        }
        Ok(())
    }
}

impl std::error::Error for Error {}

impl From<Error> for io::Error {
    fn from(e: Error) -> Self {
        let kind = if e.is_timeout() {
            io::ErrorKind::TimedOut
        } else {
            io::ErrorKind::Other
        };
        io::Error::new(kind, e)
    }
}

// ---------------------------------------------------------------------------
// The request itself
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Put,
    Delete,
    Head,
    Patch,
}

impl Method {
    pub const GET: Self = Self::Get;
    pub const POST: Self = Self::Post;
    pub const PUT: Self = Self::Put;
    pub const DELETE: Self = Self::Delete;
    pub const HEAD: Self = Self::Head;
    pub const PATCH: Self = Self::Patch;

    fn as_str(&self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
            Self::Put => "PUT",
            Self::Delete => "DELETE",
            Self::Head => "HEAD",
            Self::Patch => "PATCH",
        }
    }
}

/// Everything JavaScript needs to perform one request.
#[derive(serde::Serialize)]
struct WireRequest<'a> {
    method: &'a str,
    url: &'a str,
    headers: Vec<(String, String)>,
    timeout_ms: u64,
    /// A relay for hosts that send no CORS headers, tried only after a direct
    /// request fails outright. Set by the page through `ARNIS_CORS_RELAY`.
    relay: Option<String>,
}

/// What JavaScript hands back for a completed exchange.
#[derive(serde::Deserialize, Default)]
struct WireResponseHead {
    #[serde(default)]
    url: String,
    #[serde(default)]
    headers: Vec<(String, String)>,
    #[serde(default)]
    error: String,
}

fn perform(
    method: Method,
    url: &str,
    headers: &HeaderMap,
    body: Option<&[u8]>,
    timeout: Option<Duration>,
) -> Result<Response> {
    let request = WireRequest {
        method: method.as_str(),
        url,
        headers: headers
            .iter()
            .map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or_default().to_string()))
            .collect(),
        timeout_ms: timeout.map_or(0, |t| t.as_millis().min(u128::from(u64::MAX)) as u64),
        relay: std::env::var("ARNIS_CORS_RELAY").ok().filter(|r| !r.is_empty()),
    };
    let request_json = serde_json::to_vec(&request)
        .map_err(|e| Error::new(ErrorKind::Builder, Some(url), e.to_string()))?;

    let raw = ffi::request(&request_json, body.unwrap_or(&[]));
    let head: WireResponseHead = if raw.head.is_empty() {
        WireResponseHead::default()
    } else {
        serde_json::from_slice(&raw.head).unwrap_or_default()
    };

    match raw.outcome {
        ffi::Outcome::Completed => {}
        ffi::Outcome::Timeout => {
            return Err(Error::new(ErrorKind::Timeout, Some(url), head.error));
        }
        ffi::Outcome::Network => {
            return Err(Error::new(ErrorKind::Connect, Some(url), head.error));
        }
        ffi::Outcome::Other => {
            return Err(Error::new(ErrorKind::Request, Some(url), head.error));
        }
    }

    let status = StatusCode::from_u16(raw.status).map_err(|_| {
        Error::new(
            ErrorKind::Request,
            Some(url),
            format!("the browser reported status {}", raw.status),
        )
    })?;

    let mut response_headers = HeaderMap::new();
    for (k, v) in head.headers {
        if let (Ok(name), Ok(value)) = (HeaderName::from_bytes(k.as_bytes()), HeaderValue::from_str(&v)) {
            response_headers.append(name, value);
        }
    }

    let final_url = if head.url.is_empty() {
        url.to_string()
    } else {
        head.url
    };

    Ok(Response {
        status,
        url: final_url,
        headers: response_headers,
        body: Cursor::new(raw.body),
    })
}

/// Appends serialized query pairs to a URL, keeping any query it already has.
fn append_query<T: serde::Serialize + ?Sized>(url: &mut String, query: &T) -> std::result::Result<(), String> {
    let encoded = serde_urlencoded::to_string(query).map_err(|e| e.to_string())?;
    if encoded.is_empty() {
        return Ok(());
    }
    // Insert before any fragment.
    let fragment = url.find('#').map(|i| url.split_off(i));
    if url.contains('?') {
        if !url.ends_with('?') && !url.ends_with('&') {
            url.push('&');
        }
    } else {
        url.push('?');
    }
    url.push_str(&encoded);
    if let Some(fragment) = fragment {
        url.push_str(&fragment);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Blocking API
// ---------------------------------------------------------------------------

pub mod blocking {
    pub use super::{Error, Result, StatusCode};
    use super::*;

    /// A reusable client. Cheap to clone, like `reqwest::blocking::Client`.
    #[derive(Debug, Clone, Default)]
    pub struct Client {
        timeout: Option<Duration>,
        default_headers: HeaderMap,
    }

    impl Client {
        pub fn new() -> Self {
            Self::default()
        }

        pub fn builder() -> ClientBuilder {
            ClientBuilder::new()
        }

        pub fn get<U: AsRef<str>>(&self, url: U) -> RequestBuilder {
            self.request(Method::Get, url)
        }

        pub fn post<U: AsRef<str>>(&self, url: U) -> RequestBuilder {
            self.request(Method::Post, url)
        }

        pub fn put<U: AsRef<str>>(&self, url: U) -> RequestBuilder {
            self.request(Method::Put, url)
        }

        pub fn delete<U: AsRef<str>>(&self, url: U) -> RequestBuilder {
            self.request(Method::Delete, url)
        }

        pub fn head<U: AsRef<str>>(&self, url: U) -> RequestBuilder {
            self.request(Method::Head, url)
        }

        pub fn patch<U: AsRef<str>>(&self, url: U) -> RequestBuilder {
            self.request(Method::Patch, url)
        }

        pub fn request<U: AsRef<str>>(&self, method: Method, url: U) -> RequestBuilder {
            RequestBuilder {
                method,
                url: url.as_ref().to_string(),
                headers: self.default_headers.clone(),
                body: None,
                timeout: self.timeout,
                error: None,
            }
        }
    }

    /// Builds a [`Client`]. Options the browser decides for itself (pooling,
    /// compression, TLS, redirects) are accepted and ignored.
    #[derive(Debug, Default)]
    #[must_use]
    pub struct ClientBuilder {
        timeout: Option<Duration>,
        default_headers: HeaderMap,
    }

    impl ClientBuilder {
        pub fn new() -> Self {
            Self::default()
        }

        pub fn build(self) -> Result<Client> {
            Ok(Client {
                timeout: self.timeout,
                default_headers: self.default_headers,
            })
        }

        pub fn timeout<T: Into<Option<Duration>>>(mut self, timeout: T) -> Self {
            self.timeout = timeout.into();
            self
        }

        pub fn connect_timeout<T: Into<Option<Duration>>>(self, _timeout: T) -> Self {
            self
        }

        /// Browsers do not let a page set `User-Agent`; kept for API parity.
        pub fn user_agent<V>(self, _value: V) -> Self {
            self
        }

        pub fn default_headers(mut self, headers: HeaderMap) -> Self {
            for (k, v) in headers.iter() {
                self.default_headers.insert(k.clone(), v.clone());
            }
            self
        }

        pub fn gzip(self, _enable: bool) -> Self {
            self
        }

        pub fn brotli(self, _enable: bool) -> Self {
            self
        }

        pub fn zstd(self, _enable: bool) -> Self {
            self
        }

        pub fn deflate(self, _enable: bool) -> Self {
            self
        }

        pub fn pool_max_idle_per_host(self, _max: usize) -> Self {
            self
        }

        pub fn pool_idle_timeout<T: Into<Option<Duration>>>(self, _timeout: T) -> Self {
            self
        }

        pub fn tcp_keepalive<T: Into<Option<Duration>>>(self, _keepalive: T) -> Self {
            self
        }

        pub fn tcp_nodelay(self, _enabled: bool) -> Self {
            self
        }

        pub fn http1_only(self) -> Self {
            self
        }

        pub fn http2_prior_knowledge(self) -> Self {
            self
        }

        pub fn https_only(self, _enabled: bool) -> Self {
            self
        }

        pub fn use_rustls_tls(self) -> Self {
            self
        }

        pub fn use_native_tls(self) -> Self {
            self
        }

        pub fn no_proxy(self) -> Self {
            self
        }

        pub fn redirect<P>(self, _policy: P) -> Self {
            self
        }
    }

    /// One request being put together.
    #[derive(Debug)]
    #[must_use]
    pub struct RequestBuilder {
        method: Method,
        url: String,
        headers: HeaderMap,
        body: Option<Vec<u8>>,
        timeout: Option<Duration>,
        error: Option<String>,
    }

    impl RequestBuilder {
        pub fn header<K, V>(mut self, key: K, value: V) -> Self
        where
            K: header::IntoHeaderName,
            V: header::IntoHeaderValue,
        {
            match (key.into_header_name(), value.into_header_value()) {
                (Ok(k), Ok(v)) => {
                    self.headers.insert(k, v);
                }
                _ => {
                    self.error.get_or_insert_with(|| "invalid header".to_string());
                }
            }
            self
        }

        pub fn headers(mut self, headers: HeaderMap) -> Self {
            for (k, v) in headers.iter() {
                self.headers.insert(k.clone(), v.clone());
            }
            self
        }

        pub fn query<T: serde::Serialize + ?Sized>(mut self, query: &T) -> Self {
            if let Err(e) = append_query(&mut self.url, query) {
                self.error.get_or_insert(e);
            }
            self
        }

        pub fn json<T: serde::Serialize + ?Sized>(mut self, json: &T) -> Self {
            match serde_json::to_vec(json) {
                Ok(body) => {
                    if !self.headers.contains_key("content-type") {
                        self.headers.insert(
                            HeaderName::from_static("content-type"),
                            HeaderValue::from_static("application/json"),
                        );
                    }
                    self.body = Some(body);
                }
                Err(e) => {
                    self.error.get_or_insert(e.to_string());
                }
            }
            self
        }

        pub fn form<T: serde::Serialize + ?Sized>(mut self, form: &T) -> Self {
            match serde_urlencoded::to_string(form) {
                Ok(body) => {
                    self.headers.insert(
                        HeaderName::from_static("content-type"),
                        HeaderValue::from_static("application/x-www-form-urlencoded"),
                    );
                    self.body = Some(body.into_bytes());
                }
                Err(e) => {
                    self.error.get_or_insert(e.to_string());
                }
            }
            self
        }

        pub fn body<B: Into<Body>>(mut self, body: B) -> Self {
            self.body = Some(body.into().0);
            self
        }

        pub fn timeout(mut self, timeout: Duration) -> Self {
            self.timeout = Some(timeout);
            self
        }

        pub fn bearer_auth<T: fmt::Display>(self, token: T) -> Self {
            self.header("authorization", format!("Bearer {token}"))
        }

        pub fn basic_auth<U: fmt::Display, P: fmt::Display>(self, user: U, password: Option<P>) -> Self {
            let raw = match password {
                Some(p) => format!("{user}:{p}"),
                None => format!("{user}:"),
            };
            self.header("authorization", format!("Basic {}", base64_encode(raw.as_bytes())))
        }

        pub fn try_clone(&self) -> Option<Self> {
            Some(Self {
                method: self.method,
                url: self.url.clone(),
                headers: self.headers.clone(),
                body: self.body.clone(),
                timeout: self.timeout,
                error: self.error.clone(),
            })
        }

        pub fn send(self) -> Result<Response> {
            if let Some(e) = self.error {
                return Err(Error::new(ErrorKind::Builder, Some(&self.url), e));
            }
            perform(
                self.method,
                &self.url,
                &self.headers,
                self.body.as_deref(),
                self.timeout,
            )
        }
    }

    /// A request body.
    #[derive(Debug, Clone, Default)]
    pub struct Body(Vec<u8>);

    impl From<Vec<u8>> for Body {
        fn from(v: Vec<u8>) -> Self {
            Self(v)
        }
    }

    impl From<&'static [u8]> for Body {
        fn from(v: &'static [u8]) -> Self {
            Self(v.to_vec())
        }
    }

    impl From<String> for Body {
        fn from(v: String) -> Self {
            Self(v.into_bytes())
        }
    }

    impl From<&'static str> for Body {
        fn from(v: &'static str) -> Self {
            Self(v.as_bytes().to_vec())
        }
    }

    impl From<Bytes> for Body {
        fn from(v: Bytes) -> Self {
            Self(v.to_vec())
        }
    }

    /// A completed response with its whole body already in memory.
    #[derive(Debug)]
    pub struct Response {
        pub(crate) status: StatusCode,
        pub(crate) url: String,
        pub(crate) headers: HeaderMap,
        pub(crate) body: Cursor<Vec<u8>>,
    }

    impl Response {
        pub fn status(&self) -> StatusCode {
            self.status
        }

        pub fn headers(&self) -> &HeaderMap {
            &self.headers
        }

        pub fn url(&self) -> &str {
            &self.url
        }

        /// The size of the body still to be read.
        pub fn content_length(&self) -> Option<u64> {
            let total = self.body.get_ref().len() as u64;
            Some(total.saturating_sub(self.body.position()))
        }

        fn remaining(self) -> Vec<u8> {
            let position = self.body.position() as usize;
            let mut all = self.body.into_inner();
            if position > 0 {
                all.drain(..position.min(all.len()));
            }
            all
        }

        pub fn bytes(self) -> Result<Bytes> {
            Ok(Bytes::from(self.remaining()))
        }

        pub fn text(self) -> Result<String> {
            let bytes = self.remaining();
            Ok(match String::from_utf8(bytes) {
                Ok(text) => text,
                Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
            })
        }

        pub fn json<T: serde::de::DeserializeOwned>(self) -> Result<T> {
            let url = self.url.clone();
            serde_json::from_slice(&self.remaining())
                .map_err(|e| Error::new(ErrorKind::Decode, Some(&url), e.to_string()))
        }

        pub fn error_for_status(self) -> Result<Self> {
            if self.status.is_client_error() || self.status.is_server_error() {
                Err(Error::status_error(&self.url, self.status))
            } else {
                Ok(self)
            }
        }

        pub fn error_for_status_ref(&self) -> Result<&Self> {
            if self.status.is_client_error() || self.status.is_server_error() {
                Err(Error::status_error(&self.url, self.status))
            } else {
                Ok(self)
            }
        }

        pub fn copy_to<W: io::Write + ?Sized>(&mut self, w: &mut W) -> Result<u64> {
            io::copy(&mut self.body, w)
                .map_err(|e| Error::new(ErrorKind::Body, Some(&self.url), e.to_string()))
        }
    }

    impl Read for Response {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.body.read(buf)
        }
    }

    /// Mirrors `reqwest::blocking::get`.
    pub fn get<U: AsRef<str>>(url: U) -> Result<Response> {
        Client::new().get(url).send()
    }
}

pub use blocking::{Body, Response};

fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_is_appended_to_a_bare_url() {
        let mut url = "https://example.org/api".to_string();
        append_query(&mut url, &[("data", "a b"), ("x", "1")]).unwrap();
        assert_eq!(url, "https://example.org/api?data=a+b&x=1");
    }

    #[test]
    fn query_joins_an_existing_one() {
        let mut url = "https://example.org/api?k=v".to_string();
        append_query(&mut url, &[("x", "1")]).unwrap();
        assert_eq!(url, "https://example.org/api?k=v&x=1");
    }

    #[test]
    fn base64_matches_known_values() {
        assert_eq!(base64_encode(b"user:pass"), "dXNlcjpwYXNz");
        assert_eq!(base64_encode(b"a"), "YQ==");
    }

    #[test]
    fn status_classes() {
        assert!(StatusCode::OK.is_success());
        assert!(StatusCode::NOT_FOUND.is_client_error());
        assert!(StatusCode::BAD_GATEWAY.is_server_error());
        assert_eq!(StatusCode::PARTIAL_CONTENT.as_u16(), 206);
    }
}
