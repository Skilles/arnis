//! The boundary with JavaScript.
//!
//! `arnis_http_request` is implemented in `web/engine/arnis-lib.js` and linked
//! in by Emscripten. It performs one synchronous request on the calling thread
//! (always a Web Worker) and returns a buffer it allocated with `malloc`:
//!
//! ```text
//! u32 outcome   0 completed, 1 timeout, 2 network/CORS failure, 3 other
//! u32 status    HTTP status, 0 when not completed
//! u32 head_len  length of the JSON head
//! u32 body_len  length of the body
//! u32 body_ptr  a separate malloc'd buffer holding the body, 0 when empty
//! [head_len]    JSON {"url": "...", "headers": [["k","v"],...], "error": "..."}
//! ```
//!
//! The body buffer becomes the response's `Vec` as it is, so a large body is
//! never held twice.

#[cfg_attr(not(target_os = "emscripten"), allow(dead_code))]
pub enum Outcome {
    Completed,
    Timeout,
    Network,
    Other,
}

pub struct RawResponse {
    pub outcome: Outcome,
    pub status: u16,
    pub head: Vec<u8>,
    pub body: Vec<u8>,
}

#[cfg(target_os = "emscripten")]
mod imp {
    use super::{Outcome, RawResponse};

    extern "C" {
        fn arnis_http_request(
            request_json: *const u8,
            request_json_len: usize,
            body: *const u8,
            body_len: usize,
        ) -> *mut u8;
        fn free(ptr: *mut std::ffi::c_void);
    }

    fn read_u32(bytes: &[u8], at: usize) -> u32 {
        u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
    }

    pub fn request(request_json: &[u8], body: &[u8]) -> RawResponse {
        // SAFETY: the JavaScript side reads exactly the lengths given and
        // returns either null or a malloc'd buffer laid out as documented
        // above, which is freed here once copied.
        unsafe {
            let ptr = arnis_http_request(
                request_json.as_ptr(),
                request_json.len(),
                body.as_ptr(),
                body.len(),
            );
            if ptr.is_null() {
                return RawResponse {
                    outcome: Outcome::Other,
                    status: 0,
                    head: br#"{"error":"the browser bridge returned nothing"}"#.to_vec(),
                    body: Vec::new(),
                };
            }
            let header = std::slice::from_raw_parts(ptr, 20);
            let outcome = read_u32(header, 0);
            let status = read_u32(header, 4);
            let head_len = read_u32(header, 8) as usize;
            let body_len = read_u32(header, 12) as usize;
            let body_ptr = read_u32(header, 16) as usize as *mut u8;
            let head = std::slice::from_raw_parts(ptr.add(20), head_len).to_vec();
            free(ptr.cast());
            // The system allocator, which this build uses, allocates byte
            // buffers with malloc and frees them with free, so a malloc'd
            // buffer of exactly body_len bytes is a valid Vec<u8> allocation.
            let body = if body_ptr.is_null() || body_len == 0 {
                Vec::new()
            } else {
                Vec::from_raw_parts(body_ptr, body_len, body_len)
            };
            RawResponse {
                outcome: match outcome {
                    0 => Outcome::Completed,
                    1 => Outcome::Timeout,
                    2 => Outcome::Network,
                    _ => Outcome::Other,
                },
                status: u16::try_from(status).unwrap_or(0),
                head,
                body,
            }
        }
    }
}

#[cfg(not(target_os = "emscripten"))]
mod imp {
    use super::{Outcome, RawResponse};

    /// Native builds use the real `reqwest`; this stub only lets the crate's
    /// own tests compile on the host.
    pub fn request(_request_json: &[u8], _body: &[u8]) -> RawResponse {
        RawResponse {
            outcome: Outcome::Other,
            status: 0,
            head: br#"{"error":"arnis-web-reqwest only performs requests in the browser"}"#.to_vec(),
            body: Vec::new(),
        }
    }
}

pub use imp::request;
