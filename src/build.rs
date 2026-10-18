use std::process::Command;

fn main() {
    emit_build_hash();

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("emscripten") {
        emit_web_link_args();
    }

    // The browser build keeps the `gui` feature but has no Tauri shell.
    #[cfg(feature = "gui")]
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("emscripten") {
        tauri_build::build()
    }
}

/// Exposes the commit the binary was built from as `ARNIS_BUILD_HASH`, so a
/// custom build is distinguishable from an official release. Falls back to
/// "unknown" when git is unavailable, e.g. building from a source tarball.
fn emit_build_hash() {
    let hash = match git(&["rev-parse", "--short=7", "HEAD"]) {
        Some(hash) => {
            // Untracked files are ignored so stray local files don't mark an
            // otherwise pristine checkout as modified.
            let dirty = git(&["status", "--porcelain", "--untracked-files=no"])
                .is_some_and(|status| !status.is_empty());
            if dirty {
                format!("{hash}-dirty")
            } else {
                hash
            }
        }
        None => "unknown".to_string(),
    };

    println!("cargo:rustc-env=ARNIS_BUILD_HASH={hash}");

    // Rebuild when the checked-out commit or the staged tree changes.
    for path in [".git/HEAD", ".git/index"] {
        if std::path::Path::new(path).exists() {
            println!("cargo:rerun-if-changed={path}");
        }
    }
}

fn git(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8(output.stdout).ok()?.trim().to_string())
}

/// Emscripten settings for the browser build's `arnis` binary (web/README.md).
///
/// The generator is multithreaded, so the module uses shared memory and every
/// thread runs as a Web Worker; the module itself runs inside a worker too.
/// Files go through WasmFS, which can store them in the browser's Origin
/// Private File System.
fn emit_web_link_args() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
    let js_library = std::path::Path::new(&manifest_dir).join("web/engine/arnis-lib.js");
    println!("cargo:rerun-if-changed=web/engine/arnis-lib.js");

    let args = [
        "-pthread".to_string(),
        "-sWASMFS=1".to_string(),
        "-sMALLOC=mimalloc".to_string(),
        "-sALLOW_MEMORY_GROWTH=1".to_string(),
        "-sINITIAL_MEMORY=256MB".to_string(),
        "-sMAXIMUM_MEMORY=4GB".to_string(),
        "-sSTACK_SIZE=16MB".to_string(),
        "-sDEFAULT_PTHREAD_STACK_SIZE=4MB".to_string(),
        // Workers are started ahead of time: rayon and the per-command
        // threads are created while the page waits, and a pool avoids a
        // stall on each.
        "-sPTHREAD_POOL_SIZE=Math.min(navigator.hardwareConcurrency||4,16)+6".to_string(),
        "-sPTHREAD_POOL_SIZE_STRICT=0".to_string(),
        "-sENVIRONMENT=worker".to_string(),
        "-sMODULARIZE=1".to_string(),
        "-sEXPORT_NAME=createArnisEngine".to_string(),
        "-sINVOKE_RUN=0".to_string(),
        "-sEXIT_RUNTIME=0".to_string(),
        "-sEXPORTED_FUNCTIONS=_main,_arnis_web_init,_arnis_web_invoke,_malloc,_free".to_string(),
        "-sEXPORTED_RUNTIME_METHODS=HEAPU8,ENV".to_string(),
        // Known and accepted: memory growth with threads costs a little in JS.
        "-Wno-pthreads-mem-growth".to_string(),
        format!("--js-library={}", js_library.display()),
    ];
    for arg in args {
        println!("cargo:rustc-link-arg-bins={arg}");
    }
}
