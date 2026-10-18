//! The browser build's bridge between the generator and the web page.
//!
//! Compiled only for `wasm32-unknown-emscripten`. The Emscripten module runs
//! inside a dedicated Web Worker (`web/app/engine-worker.js`), every Rust
//! thread is a further worker, and the page talks to it with messages.
//!
//! * The page calls the same `gui_*` commands the desktop app sends to Tauri.
//!   [`arnis_web_invoke`] receives them and answers through
//!   `arnis_invoke_reply`, implemented in `web/engine/arnis-lib.js`.
//! * Progress and other events go the other way through
//!   [`BrowserWindow::emit`], standing in for Tauri's window.
//! * Files live in the browser's private storage (OPFS) under `/data`,
//!   mounted by [`arnis_web_init`], so worlds and download caches survive a
//!   reload and the page can zip a finished world straight from storage.

use std::ffi::c_void;
use std::path::Path;

/// Where every world is written.
pub const WORLDS_DIR: &str = "/data/worlds";
/// Bedrock `.mcworld` files land here.
pub const EXPORTS_DIR: &str = "/data/exports";
/// `dirs::cache_dir()` points here, so the tile caches persist as well.
pub const CACHE_DIR: &str = "/data/cache";

extern "C" {
    /// Posts an event to the page. Proxied to the module's main thread.
    fn arnis_emit_event(name: *const u8, name_len: usize, json: *const u8, json_len: usize);
    /// Answers an invoke. `kind` 0 is JSON, 1 is raw bytes. Proxied likewise.
    fn arnis_invoke_reply(id: u32, ok: i32, kind: i32, data: *const u8, len: usize);
    /// WasmFS: the Origin Private File System backend, null when unavailable.
    fn wasmfs_create_opfs_backend() -> *mut c_void;
    /// WasmFS: creates a directory served by `backend`.
    fn wasmfs_create_directory(path: *const std::ffi::c_char, mode: u32, backend: *mut c_void) -> i32;
    /// JS: whether the page can offer OPFS to this worker.
    fn arnis_opfs_available() -> i32;
}

/// `errno` 0.2 (via rusty-leveldb) asks for the C symbol `errno_location` on
/// Emscripten, which names it `__errno_location`.
#[no_mangle]
pub extern "C" fn errno_location() -> *mut i32 {
    // SAFETY: returns the calling thread's errno slot.
    unsafe { libc::__errno_location() }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/// Stands in for Tauri's `WebviewWindow` in `progress.rs`.
#[derive(Debug, Clone, Copy)]
pub struct BrowserWindow;

impl BrowserWindow {
    /// Same shape as `tauri::Emitter::emit`.
    pub fn emit<S: serde::Serialize>(&self, event: &str, payload: S) -> Result<(), String> {
        let json = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
        // SAFETY: both buffers outlive the synchronously proxied call.
        unsafe {
            arnis_emit_event(event.as_ptr(), event.len(), json.as_ptr(), json.len());
        }
        Ok(())
    }
}

/// Stands in for `tauri::ipc::Response`: bytes that skip JSON.
pub struct BinaryResponse(Vec<u8>);

impl BinaryResponse {
    pub fn new(bytes: Vec<u8>) -> Self {
        Self(bytes)
    }
}

// ---------------------------------------------------------------------------
// A tiny runtime standing in for `tauri::async_runtime`
// ---------------------------------------------------------------------------

/// The desktop build awaits blocking work on Tauri's Tokio runtime. Here every
/// command already runs on a thread of its own, so "spawning" blocking work
/// just runs it, and an async command is driven to completion in place.
pub mod rt {
    use std::fmt;
    use std::future::Future;
    use std::pin::pin;
    use std::task::{Context, Poll, Waker};

    /// The work panicked.
    #[derive(Debug)]
    pub struct JoinError(String);

    impl fmt::Display for JoinError {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            write!(f, "task panicked: {}", self.0)
        }
    }

    impl std::error::Error for JoinError {}

    fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
        if let Some(s) = payload.downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = payload.downcast_ref::<String>() {
            s.clone()
        } else {
            "unknown panic".to_string()
        }
    }

    /// Runs `f` when awaited, on the awaiting thread, catching a panic the
    /// way Tokio's `JoinHandle` reports one.
    pub fn spawn_blocking<F, T>(f: F) -> impl Future<Output = Result<T, JoinError>>
    where
        F: FnOnce() -> T + Send + 'static,
        T: Send + 'static,
    {
        async move {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(f))
                .map_err(|p| JoinError(panic_message(p.as_ref())))
        }
    }

    /// Runs a future to completion on a new thread, detached.
    pub fn spawn<F>(future: F)
    where
        F: Future<Output = ()> + Send + 'static,
    {
        let spawned = std::thread::Builder::new()
            .name("arnis-task".to_string())
            .spawn(move || block_on(future));
        if let Err(e) = spawned {
            eprintln!("Failed to start a background task: {e}");
        }
    }

    /// Drives a future on the current thread. Every future here resolves
    /// without waiting on another, so it never actually parks.
    pub fn block_on<F: Future>(future: F) -> F::Output {
        let mut future = pin!(future);
        let mut cx = Context::from_waker(Waker::noop());
        loop {
            if let Poll::Ready(out) = future.as_mut().poll(&mut cx) {
                return out;
            }
            std::thread::yield_now();
        }
    }
}

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------

fn mount_storage() -> &'static str {
    let path = std::ffi::CString::new("/data").expect("static path");
    // SAFETY: plain FFI into WasmFS with a valid C string.
    let mounted = unsafe {
        if arnis_opfs_available() != 0 {
            let backend = wasmfs_create_opfs_backend();
            !backend.is_null() && wasmfs_create_directory(path.as_ptr(), 0o777, backend) == 0
        } else {
            false
        }
    };
    if mounted {
        "opfs"
    } else {
        // Private browsing and a few older browsers have no OPFS: keep going
        // in memory, which only costs persistence across reloads.
        let _ = std::fs::create_dir_all("/data");
        "memory"
    }
}

/// Called once by the engine worker before anything else.
///
/// Returns 0 for persistent storage, 1 when the session is memory-only.
#[no_mangle]
pub extern "C" fn arnis_web_init() -> i32 {
    let storage = mount_storage();
    for dir in [WORLDS_DIR, EXPORTS_DIR, CACHE_DIR] {
        if let Err(e) = std::fs::create_dir_all(dir) {
            eprintln!("Failed to create {dir}: {e}");
        }
    }

    // `dirs` resolves the cache, desktop and data folders from the XDG
    // variables, so every cache the generator keeps lands in storage.
    // SAFETY: called once at start-up before any other thread exists.
    unsafe {
        std::env::set_var("HOME", "/data");
        std::env::set_var("XDG_CACHE_HOME", CACHE_DIR);
        std::env::set_var("XDG_DATA_HOME", "/data/share");
        std::env::set_var("XDG_DESKTOP_DIR", EXPORTS_DIR);
    }

    crate::progress::set_main_window(BrowserWindow);
    crate::telemetry::install_panic_hook();
    crate::floodfill_cache::configure_rayon_thread_pool(1.0);
    crate::elevation_data::cleanup_old_cached_tiles();

    println!("Arnis web engine ready (storage: {storage}).");
    i32::from(storage != "opfs")
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// What a command answers with.
pub enum Reply {
    Json(serde_json::Value),
    Bytes(Vec<u8>),
}

impl From<BinaryResponse> for Reply {
    fn from(r: BinaryResponse) -> Self {
        Reply::Bytes(r.0)
    }
}

/// Reads one named argument, accepting the camelCase key Tauri's JavaScript
/// API sends (`bboxText`) as well as the Rust name (`bbox_text`).
pub fn arg<T: serde::de::DeserializeOwned>(args: &serde_json::Value, name: &str) -> Result<T, serde_json::Value> {
    let camel = to_camel_case(name);
    let value = args
        .get(&camel)
        .or_else(|| args.get(name))
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    serde_json::from_value(value)
        .map_err(|e| serde_json::Value::String(format!("invalid argument `{camel}`: {e}")))
}

fn to_camel_case(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut upper = false;
    for c in name.chars() {
        if c == '_' {
            upper = true;
        } else if upper {
            out.extend(c.to_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}

/// Serializes a command's `Result` the way Tauri does: `Ok` resolves the
/// promise with the value, `Err` rejects it with the error value.
pub fn json_result<T: serde::Serialize, E: serde::Serialize>(
    r: Result<T, E>,
) -> Result<Reply, serde_json::Value> {
    match r {
        Ok(v) => serde_json::to_value(v)
            .map(Reply::Json)
            .map_err(|e| serde_json::Value::String(e.to_string())),
        Err(e) => Err(serde_json::to_value(e).unwrap_or(serde_json::Value::Null)),
    }
}

/// Serializes an infallible command's value.
pub fn json_value<T: serde::Serialize>(v: T) -> Result<Reply, serde_json::Value> {
    json_result::<T, String>(Ok(v))
}

fn reply(id: u32, result: Result<Reply, serde_json::Value>) {
    let (ok, kind, data) = match result {
        Ok(Reply::Json(v)) => (1, 0, serde_json::to_vec(&v).unwrap_or_else(|_| b"null".to_vec())),
        Ok(Reply::Bytes(b)) => (1, 1, b),
        Err(e) => (0, 0, serde_json::to_vec(&e).unwrap_or_else(|_| b"null".to_vec())),
    };
    // SAFETY: `data` outlives the synchronously proxied call.
    unsafe {
        arnis_invoke_reply(id, ok, kind, data.as_ptr(), data.len());
    }
}

/// Runs one command on a thread of its own and answers through
/// `arnis_invoke_reply`. The module's main thread must never block: it is the
/// one that starts new threads and relays every message to the page.
///
/// # Safety
///
/// `cmd` and `args` must point to `cmd_len` and `args_len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn arnis_web_invoke(
    id: u32,
    cmd: *const u8,
    cmd_len: usize,
    args: *const u8,
    args_len: usize,
) {
    // SAFETY: guaranteed by the caller.
    let (cmd, args) = unsafe {
        (
            String::from_utf8_lossy(std::slice::from_raw_parts(cmd, cmd_len)).into_owned(),
            std::slice::from_raw_parts(args, args_len).to_vec(),
        )
    };
    let spawned = std::thread::Builder::new()
        .name(format!("arnis-{cmd}"))
        .spawn(move || {
            let args: serde_json::Value =
                serde_json::from_slice(&args).unwrap_or(serde_json::Value::Null);
            let result = std::panic::catch_unwind(|| dispatch(&cmd, &args)).unwrap_or_else(|p| {
                let msg = p
                    .downcast_ref::<&str>()
                    .map(|s| (*s).to_string())
                    .or_else(|| p.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "unknown panic".to_string());
                Err(serde_json::Value::String(format!("{cmd} panicked: {msg}")))
            });
            reply(id, result);
        });
    if let Err(e) = spawned {
        reply(
            id,
            Err(serde_json::Value::String(format!("could not start a thread: {e}"))),
        );
    }
}

fn dispatch(cmd: &str, args: &serde_json::Value) -> Result<Reply, serde_json::Value> {
    match cmd {
        // Browser-only commands.
        "web_storage_paths" => json_value(serde_json::json!({
            "worlds": WORLDS_DIR,
            "exports": EXPORTS_DIR,
            "cache": CACHE_DIR,
        })),
        "web_remove_path" => {
            let path: String = arg(args, "path")?;
            json_result(remove_path(&path))
        }
        "web_list_outputs" => json_result(list_outputs()),
        "web_list_tree" => {
            let path: String = arg(args, "path")?;
            json_result(list_tree(&path))
        }
        "web_read_chunk" => {
            let path: String = arg(args, "path")?;
            let offset: u64 = arg(args, "offset")?;
            let length: u64 = arg(args, "length")?;
            read_chunk(&path, offset, length)
                .map(Reply::Bytes)
                .map_err(serde_json::Value::String)
        }
        // Everything the desktop app sends to Tauri.
        _ => crate::gui::web_dispatch(cmd, args),
    }
}

/// Accepts only paths inside the app's storage, without `..` components.
fn checked_path(path: &str) -> Result<&Path, String> {
    let p = Path::new(path);
    let inside = p.starts_with("/data")
        && !p
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir));
    if inside {
        Ok(p)
    } else {
        Err("refusing a path outside the app's storage".to_string())
    }
}

/// One finished world or export, as the page's "Your worlds" list shows it.
#[derive(serde::Serialize)]
struct OutputEntry {
    path: String,
    name: String,
    /// "java", "bedrock" or "luanti".
    kind: &'static str,
    /// The world is a folder the page zips; an export is one file.
    is_dir: bool,
    bytes: u64,
    /// Seconds since the Unix epoch.
    modified: u64,
}

fn modified_secs(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs())
}

fn tree_size(path: &Path) -> (u64, u64) {
    let mut bytes = 0;
    let mut newest = 0;
    let Ok(entries) = std::fs::read_dir(path) else {
        return (0, 0);
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        newest = newest.max(modified_secs(&meta));
        if meta.is_dir() {
            let (b, m) = tree_size(&entry.path());
            bytes += b;
            newest = newest.max(m);
        } else {
            bytes += meta.len();
        }
    }
    (bytes, newest)
}

/// Every world folder and export file, newest first.
fn list_outputs() -> Result<Vec<OutputEntry>, String> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(WORLDS_DIR) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let kind = if path.join("world.mt").exists() {
                "luanti"
            } else if path.join("level.dat").exists() {
                "java"
            } else {
                // A world whose generation never got going.
                continue;
            };
            let (bytes, modified) = tree_size(&path);
            out.push(OutputEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: path.display().to_string(),
                kind,
                is_dir: true,
                bytes,
                modified,
            });
        }
    }
    if let Ok(entries) = std::fs::read_dir(EXPORTS_DIR) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            out.push(OutputEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: path.display().to_string(),
                kind: "bedrock",
                is_dir: false,
                bytes: meta.len(),
                modified: modified_secs(&meta),
            });
        }
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

#[derive(serde::Serialize)]
struct TreeFile {
    /// Path relative to the listed folder, with `/` separators.
    path: String,
    bytes: u64,
}

/// Every file under `path`, for the page to zip.
fn list_tree(path: &str) -> Result<Vec<TreeFile>, String> {
    let root = checked_path(path)?;
    let mut files = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        for entry in entries.flatten() {
            let p = entry.path();
            let meta = entry.metadata().map_err(|e| format!("{}: {e}", p.display()))?;
            if meta.is_dir() {
                stack.push(p);
            } else if let Ok(rel) = p.strip_prefix(root) {
                files.push(TreeFile {
                    path: rel
                        .components()
                        .map(|c| c.as_os_str().to_string_lossy())
                        .collect::<Vec<_>>()
                        .join("/"),
                    bytes: meta.len(),
                });
            }
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

/// Up to 32 MiB of one file, for downloads.
fn read_chunk(path: &str, offset: u64, length: u64) -> Result<Vec<u8>, String> {
    use std::io::{Read, Seek, SeekFrom};
    let p = checked_path(path)?;
    let length = length.min(32 << 20);
    let mut file = std::fs::File::open(p).map_err(|e| format!("{}: {e}", p.display()))?;
    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity(length as usize);
    file.take(length).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

/// Deletes a world or export the user discarded from the page. Only paths
/// under `/data` are accepted.
fn remove_path(path: &str) -> Result<(), String> {
    let p = checked_path(path)?;
    if [Path::new("/data"), Path::new(WORLDS_DIR), Path::new(EXPORTS_DIR), Path::new(CACHE_DIR)].contains(&p) {
        return Err("refusing to remove a storage root".to_string());
    }
    if p.is_dir() {
        std::fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else if p.exists() {
        std::fs::remove_file(p).map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::to_camel_case;

    #[test]
    fn camel_case_matches_tauri() {
        assert_eq!(to_camel_case("bbox_text"), "bboxText");
        assert_eq!(to_camel_case("world_name"), "worldName");
        assert_eq!(to_camel_case("aws_only"), "awsOnly");
        assert_eq!(to_camel_case("path"), "path");
    }
}
