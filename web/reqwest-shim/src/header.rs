//! Header names, values and a case-insensitive multi-map, shaped like the
//! `http` crate types that `reqwest::header` re-exports.

use std::fmt;

/// A lowercase header name.
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct HeaderName(String);

impl HeaderName {
    pub fn from_static(name: &'static str) -> Self {
        Self(name.to_ascii_lowercase())
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, InvalidHeaderName> {
        let s = std::str::from_utf8(bytes).map_err(|_| InvalidHeaderName)?;
        if s.is_empty() || !s.bytes().all(|b| b.is_ascii_graphic() && b != b':') {
            return Err(InvalidHeaderName);
        }
        Ok(Self(s.to_ascii_lowercase()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for HeaderName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(&self.0, f)
    }
}

impl fmt::Display for HeaderName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl AsRef<str> for HeaderName {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl std::str::FromStr for HeaderName {
    type Err = InvalidHeaderName;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::from_bytes(s.as_bytes())
    }
}

/// A header value. Browsers only hand back text, so it is stored as a string.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct HeaderValue(String);

impl HeaderValue {
    pub fn from_static(value: &'static str) -> Self {
        Self(value.to_string())
    }

    pub fn from_str(value: &str) -> Result<Self, InvalidHeaderValue> {
        if value.bytes().any(|b| b == b'\r' || b == b'\n' || b == 0) {
            return Err(InvalidHeaderValue);
        }
        Ok(Self(value.to_string()))
    }

    pub fn from_bytes(value: &[u8]) -> Result<Self, InvalidHeaderValue> {
        let s = std::str::from_utf8(value).map_err(|_| InvalidHeaderValue)?;
        Self::from_str(s)
    }

    pub fn to_str(&self) -> Result<&str, ToStrError> {
        Ok(&self.0)
    }

    pub fn as_bytes(&self) -> &[u8] {
        self.0.as_bytes()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Debug for HeaderValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(&self.0, f)
    }
}

impl std::str::FromStr for HeaderValue {
    type Err = InvalidHeaderValue;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        HeaderValue::from_str(s)
    }
}

impl TryFrom<&str> for HeaderValue {
    type Error = InvalidHeaderValue;

    fn try_from(s: &str) -> Result<Self, Self::Error> {
        HeaderValue::from_str(s)
    }
}

impl TryFrom<String> for HeaderValue {
    type Error = InvalidHeaderValue;

    fn try_from(s: String) -> Result<Self, Self::Error> {
        HeaderValue::from_str(&s)
    }
}

impl From<u64> for HeaderValue {
    fn from(n: u64) -> Self {
        Self(n.to_string())
    }
}

#[derive(Debug)]
pub struct InvalidHeaderName;

impl fmt::Display for InvalidHeaderName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("invalid HTTP header name")
    }
}

impl std::error::Error for InvalidHeaderName {}

#[derive(Debug)]
pub struct InvalidHeaderValue;

impl fmt::Display for InvalidHeaderValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("invalid HTTP header value")
    }
}

impl std::error::Error for InvalidHeaderValue {}

#[derive(Debug)]
pub struct ToStrError;

impl fmt::Display for ToStrError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("failed to convert header to a str")
    }
}

impl std::error::Error for ToStrError {}

/// Anything usable where a header name is expected when building a request.
pub trait IntoHeaderName {
    fn into_header_name(self) -> Result<HeaderName, InvalidHeaderName>;
}

impl IntoHeaderName for HeaderName {
    fn into_header_name(self) -> Result<HeaderName, InvalidHeaderName> {
        Ok(self)
    }
}

impl IntoHeaderName for &HeaderName {
    fn into_header_name(self) -> Result<HeaderName, InvalidHeaderName> {
        Ok(self.clone())
    }
}

impl IntoHeaderName for &str {
    fn into_header_name(self) -> Result<HeaderName, InvalidHeaderName> {
        HeaderName::from_bytes(self.as_bytes())
    }
}

impl IntoHeaderName for String {
    fn into_header_name(self) -> Result<HeaderName, InvalidHeaderName> {
        HeaderName::from_bytes(self.as_bytes())
    }
}

impl IntoHeaderName for &String {
    fn into_header_name(self) -> Result<HeaderName, InvalidHeaderName> {
        HeaderName::from_bytes(self.as_bytes())
    }
}

/// Anything usable where a header value is expected when building a request.
pub trait IntoHeaderValue {
    fn into_header_value(self) -> Result<HeaderValue, InvalidHeaderValue>;
}

impl IntoHeaderValue for HeaderValue {
    fn into_header_value(self) -> Result<HeaderValue, InvalidHeaderValue> {
        Ok(self)
    }
}

impl IntoHeaderValue for &HeaderValue {
    fn into_header_value(self) -> Result<HeaderValue, InvalidHeaderValue> {
        Ok(self.clone())
    }
}

impl IntoHeaderValue for &str {
    fn into_header_value(self) -> Result<HeaderValue, InvalidHeaderValue> {
        HeaderValue::from_str(self)
    }
}

impl IntoHeaderValue for String {
    fn into_header_value(self) -> Result<HeaderValue, InvalidHeaderValue> {
        HeaderValue::from_str(&self)
    }
}

impl IntoHeaderValue for &String {
    fn into_header_value(self) -> Result<HeaderValue, InvalidHeaderValue> {
        HeaderValue::from_str(self)
    }
}

/// Anything a [`HeaderMap`] can be looked up by.
pub trait AsHeaderName {
    fn header_key(&self) -> String;
}

impl AsHeaderName for HeaderName {
    fn header_key(&self) -> String {
        self.0.clone()
    }
}

impl AsHeaderName for &HeaderName {
    fn header_key(&self) -> String {
        self.0.clone()
    }
}

impl AsHeaderName for &str {
    fn header_key(&self) -> String {
        self.to_ascii_lowercase()
    }
}

impl AsHeaderName for String {
    fn header_key(&self) -> String {
        self.to_ascii_lowercase()
    }
}

impl AsHeaderName for &String {
    fn header_key(&self) -> String {
        self.to_ascii_lowercase()
    }
}

/// An ordered, case-insensitive header multi-map.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct HeaderMap {
    entries: Vec<(HeaderName, HeaderValue)>,
}

impl HeaderMap {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            entries: Vec::with_capacity(capacity),
        }
    }

    /// Replaces every value of `key` with `value`, returning the first old one.
    pub fn insert<K: IntoHeaderName>(&mut self, key: K, value: HeaderValue) -> Option<HeaderValue> {
        let key = key.into_header_name().ok()?;
        let old = self
            .entries
            .iter()
            .position(|(k, _)| *k == key)
            .map(|i| self.entries[i].1.clone());
        self.entries.retain(|(k, _)| *k != key);
        self.entries.push((key, value));
        old
    }

    pub fn append<K: IntoHeaderName>(&mut self, key: K, value: HeaderValue) -> bool {
        match key.into_header_name() {
            Ok(key) => {
                let existed = self.entries.iter().any(|(k, _)| *k == key);
                self.entries.push((key, value));
                existed
            }
            Err(_) => false,
        }
    }

    pub fn get<K: AsHeaderName>(&self, key: K) -> Option<&HeaderValue> {
        let key = key.header_key();
        self.entries.iter().find(|(k, _)| k.0 == key).map(|(_, v)| v)
    }

    pub fn get_all<K: AsHeaderName>(&self, key: K) -> impl Iterator<Item = &HeaderValue> {
        let key = key.header_key();
        self.entries
            .iter()
            .filter(move |(k, _)| k.0 == key)
            .map(|(_, v)| v)
    }

    pub fn contains_key<K: AsHeaderName>(&self, key: K) -> bool {
        self.get(key).is_some()
    }

    pub fn remove<K: AsHeaderName>(&mut self, key: K) -> Option<HeaderValue> {
        let key = key.header_key();
        let first = self
            .entries
            .iter()
            .find(|(k, _)| k.0 == key)
            .map(|(_, v)| v.clone());
        self.entries.retain(|(k, _)| k.0 != key);
        first
    }

    pub fn iter(&self) -> impl Iterator<Item = (&HeaderName, &HeaderValue)> {
        self.entries.iter().map(|(k, v)| (k, v))
    }

    pub fn keys(&self) -> impl Iterator<Item = &HeaderName> {
        self.entries.iter().map(|(k, _)| k)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

impl fmt::Debug for HeaderMap {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_map().entries(self.entries.iter().map(|(k, v)| (k, v))).finish()
    }
}

macro_rules! standard_headers {
    ($($konst:ident => $name:literal),* $(,)?) => {
        $(
            #[allow(clippy::declare_interior_mutable_const)]
            pub const $konst: StaticHeader = StaticHeader($name);
        )*
    };
}

/// A header-name constant. A `String` cannot be built in a `const`, so the
/// constants are this thin wrapper, usable wherever a name is accepted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StaticHeader(&'static str);

impl StaticHeader {
    pub fn as_str(&self) -> &'static str {
        self.0
    }
}

impl From<StaticHeader> for HeaderName {
    fn from(h: StaticHeader) -> Self {
        HeaderName(h.0.to_string())
    }
}

impl IntoHeaderName for StaticHeader {
    fn into_header_name(self) -> Result<HeaderName, InvalidHeaderName> {
        Ok(self.into())
    }
}

impl AsHeaderName for StaticHeader {
    fn header_key(&self) -> String {
        self.0.to_string()
    }
}

impl fmt::Display for StaticHeader {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}

standard_headers! {
    ACCEPT => "accept",
    ACCEPT_ENCODING => "accept-encoding",
    ACCEPT_LANGUAGE => "accept-language",
    ACCEPT_RANGES => "accept-ranges",
    AUTHORIZATION => "authorization",
    CACHE_CONTROL => "cache-control",
    CONTENT_ENCODING => "content-encoding",
    CONTENT_LENGTH => "content-length",
    CONTENT_RANGE => "content-range",
    CONTENT_TYPE => "content-type",
    ETAG => "etag",
    IF_MODIFIED_SINCE => "if-modified-since",
    IF_NONE_MATCH => "if-none-match",
    LAST_MODIFIED => "last-modified",
    LOCATION => "location",
    RANGE => "range",
    REFERER => "referer",
    RETRY_AFTER => "retry-after",
    USER_AGENT => "user-agent",
}
