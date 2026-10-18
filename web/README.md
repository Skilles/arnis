# Arnis in the browser

This folder turns Arnis into a web app that runs entirely on the visitor's
device. The Rust generator is compiled to WebAssembly and runs in the browser
with all of the device's processor cores; the desktop GUI runs unchanged on top
of it, and the whole thing installs as a Progressive Web App on phones,
tablets and computers.

Nothing is generated on a server. The only network traffic is the same data
downloads the desktop app makes (OpenStreetMap, elevation, land cover, …),
made by the browser itself.

## How it fits together

```
index.html (the desktop GUI, unchanged)
  └─ pwa/bridge.js        window.__TAURI__ stand-in: invoke() and listen()
       └─ engine-worker.js   Web Worker hosting the WebAssembly engine
            └─ engine/arnis.wasm   the Rust generator (wasm32-unknown-emscripten)
                 ├─ every Rust thread is another Web Worker (shared memory)
                 ├─ HTTP: web/reqwest-shim → synchronous XHR in the worker
                 └─ files: WasmFS on the Origin Private File System (/data)
```

- **Commands.** The GUI calls the same `gui_*` commands it sends to Tauri on
  the desktop. `src/gui.rs` keeps every command; in the browser build the Tauri
  attributes are compiled out and `web_dispatch` (at the end of `gui.rs`) maps
  command names to the functions. `src/web.rs` receives each call from the
  page, runs it on a thread of its own and posts the answer back.
- **Events.** `src/progress.rs` emits progress through a `BrowserWindow` that
  posts to the page instead of Tauri's window.
- **Networking.** `reqwest` doesn't run in browsers, so on this target the
  crate root aliases `reqwest` to `web/reqwest-shim`, which offers the same
  blocking API and performs requests with synchronous `XMLHttpRequest` (allowed
  in workers). No call site changed.
- **Storage.** Worlds are written to `/data/worlds` (Java, Luanti) and
  `/data/exports` (Bedrock `.mcworld`), and download caches to `/data/cache`,
  all in the browser's private file system, so they survive reloads. The
  "Your worlds" panel downloads a world (Java and Luanti worlds as a `.zip`),
  shares it (on phones, e.g. straight into Minecraft), or deletes it.
- **Threads.** Shared memory requires a cross-origin isolated page. GitHub
  Pages can't send the needed headers, so `sw.js` (the PWA's service worker)
  adds them; the first visit reloads once to pick them up.

Changes outside this folder are small and keep the desktop build as it was:
`Cargo.toml` (target-specific dependencies), `src/main.rs`, `src/build.rs`,
`src/progress.rs`, `src/gui.rs`, `src/world_utils.rs`, and `.cargo/config.toml`
(settings for the WebAssembly target only). Two dependencies are patched under
`web/patches/`: `fs2` gains an Emscripten branch, and `jsonwebtoken` 9 is
replaced by a stub, because bedrock-rs only names its error type and the real
crate pulls in `js-sys`, which doesn't build for this target.

## Building

Requirements: nightly Rust with `rust-src` and the
`wasm32-unknown-emscripten` target, the Emscripten SDK, and Node.js.

```sh
rustup toolchain install nightly --component rust-src --target wasm32-unknown-emscripten
git clone https://github.com/emscripten-core/emsdk ~/emsdk
~/emsdk/emsdk install 6.0.12 && ~/emsdk/emsdk activate 6.0.12
source ~/emsdk/emsdk_env.sh

web/build.sh              # builds web/app/engine/arnis.{js,wasm}
node web/assemble.mjs     # builds the site into web/dist
node web/serve.mjs        # serves web/dist at http://localhost:8080
```

`web/build.sh --dev` makes a faster, unoptimized build.

## Deploying

`.github/workflows/web-pages.yml` builds and publishes the site to GitHub
Pages on every push to `main` that touches the generator or this folder. In
the repository settings, set **Pages → Build and deployment → Source** to
**GitHub Actions** once.

Any static host works: upload `web/dist`. On a host that can set headers,
serving `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: credentialless` avoids the first-visit reload.

## Data sources and the optional relay

Elevation, place names and Overture allow browsers to read them. The rest
don't send CORS headers, including both OpenStreetMap sources (Arnis's tile
archive and Overpass server), so **the relay is required for buildings and
roads**. `web/relay/` is a small, host-allowlisted relay; deploy it
(Cloudflare Workers or Vercel, both free) and set `corsRelay` in
`web/app/config.js`. See `web/relay/README.md`. This fork's site uses the one
at `arnis-relay.vercel.app`.

The tile archive sits behind Cloudflare bot protection that blocks the relay
too, so the web build gets OpenStreetMap data from Arnis's Overpass server.
Both are run by the Arnis project; asking upstream to send
`Access-Control-Allow-Origin` on them would remove the need for the relay.

Open `diagnostics.html` on the deployed site to see which sources a given
browser can reach.

## Limits

- **Memory.** WebAssembly memory is capped at 4 GB, and phones allow less
  (often 1–2 GB on iOS). Large areas that need more stop with "out of memory";
  pick a smaller area on phones.
- **Browsers.** Needs WebAssembly threads, SIMD and exception handling, and a
  cross-origin isolated page: current Chrome, Edge, Firefox and Safari 16.4+.
  Private browsing modes may block the service worker or storage.
- **Keep the tab open.** Browsers pause background tabs. The app keeps the
  screen awake while generating where the browser allows it.
- **Telemetry** is sent to the Arnis endpoint as on desktop, if the visitor
  allows it and the endpoint accepts browser requests.
