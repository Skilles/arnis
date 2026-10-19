/*
 * Hosts the Arnis WebAssembly engine.
 *
 * The page never runs generator code itself: it starts this worker, which
 * loads the Emscripten module, and talks to it with messages. Emscripten runs
 * every Rust thread as a further worker started from here, so this worker
 * stays idle except to relay messages, which it must: it is the thread that
 * starts new threads and forwards their events to the page.
 *
 * Page -> worker   {type: 'invoke', id, cmd, args}
 * Worker -> page   {type: 'ready', storage, threads}
 *                  {type: 'reply', id, ok, binary, data}   (from arnis-lib.js)
 *                  {type: 'event', name, payload}          (from arnis-lib.js)
 *                  {type: 'log', level, text}
 *                  {type: 'crash', reason}
 */
'use strict';

const base = new URL('./', self.location.href);
try {
  importScripts(new URL('config.js', base).href);
} catch (e) {
  // Optional: without it every host is called directly.
}
const config = self.ARNIS_CONFIG || {};
// Replaced with the build id by web/assemble.mjs. The engine files are
// requested under it, so the browser's HTTP cache (ten minutes on GitHub
// Pages) can never pair this script with an engine from another build.
const BUILD = '__ARNIS_BUILD__';
const engineFile = (name) => new URL(`engine/${name}?v=${encodeURIComponent(BUILD)}`, base).href;
const engineUrl = engineFile('arnis.js');

// Emscripten starts every engine thread from the script that loaded the
// engine, so this file also runs as each thread's worker. There it must hand
// over to the engine at once: the engine's 'load' message can arrive as soon
// as the worker exists, and if this script were still busy (checking storage,
// downloading) the message would land in its own handler and be lost, leaving
// the generator waiting for that thread forever.
const IS_ENGINE_THREAD = self.name === 'em-pthread';
if (IS_ENGINE_THREAD) {
  importScripts(engineUrl);
}

let engine = null;
let ready = false;
const queued = [];

function log(level, text) {
  postMessage({ type: 'log', level, text: String(text) });
}

// Where start-up has got to, shown on the page while it waits.
function stage(text) {
  postMessage({ type: 'stage', text });
}

function crash(reason) {
  postMessage({ type: 'crash', reason: String(reason) });
}

if (!IS_ENGINE_THREAD) {
  self.addEventListener('error', (e) => crash(e.message || e));
  self.addEventListener('unhandledrejection', (e) => crash(e.reason || 'unhandled rejection'));
}

// Copies a byte array into the engine's heap; the caller frees it.
function toHeap(bytes) {
  const ptr = engine._malloc(Math.max(bytes.length, 1));
  engine.HEAPU8.set(bytes, ptr);
  return ptr;
}

function invoke({ id, cmd, args }) {
  const enc = new TextEncoder();
  const cmdBytes = enc.encode(cmd);
  const argBytes = enc.encode(JSON.stringify(args || {}));
  const cmdPtr = toHeap(cmdBytes);
  const argPtr = toHeap(argBytes);
  try {
    // Copies both buffers and returns at once; the answer comes back as a
    // 'reply' message posted by arnis-lib.js.
    engine._arnis_web_invoke(id, cmdPtr, cmdBytes.length, argPtr, argBytes.length);
  } catch (e) {
    postMessage({ type: 'reply', id, ok: false, binary: false, data: `engine error: ${e}` });
  } finally {
    engine._free(cmdPtr);
    engine._free(argPtr);
  }
}

if (!IS_ENGINE_THREAD) {
  self.onmessage = (e) => {
    const msg = e.data;
    if (!msg || msg.type !== 'invoke') {
      return;
    }
    if (ready) {
      invoke(msg);
    } else {
      queued.push(msg);
    }
  };
}

// Cores used at most; must match WEB_MAX_CORES in src/web.rs.
const MAX_CORES = 12;
const cores = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, MAX_CORES));
const phone = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.userAgentData && navigator.userAgentData.mobile === true);

// Threads per download pool (terrain tiles, buildings, photos); read by the
// engine as ARNIS_WEB_DOWNLOAD_THREADS. Each is a worker held for the whole
// session, which a phone can spare fewer of.
function downloadThreads() {
  return phone ? 3 : 8;
}

// Workers for every thread a generation runs at its busiest: a pool per core
// (generation, tile placement), a few download pools side by side and the
// coordinating threads. A worker started later never runs its thread, so this
// must not be short; an idle one costs a few MB.
function poolSize() {
  return 2 * cores + 20 + 3 * (downloadThreads() - 3);
}

// Downloads the engine with progress, so a stall shows where it is. The bytes
// are handed to Emscripten as wasmBinary; it compiles them itself, because
// its worker pool only loads a module it instantiated on its own path.
async function downloadEngine() {
  const response = await fetch(engineFile('arnis.wasm'));
  if (!response.ok) {
    throw new Error(`downloading the generator failed: HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  let shown = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    received += value.length;
    if (received - shown > 2 * 1048576) {
      shown = received;
      stage(`Downloading the generator (${(received / 1048576).toFixed(0)} MB)…`);
    }
  }
  const bytes = new Uint8Array(received);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

// The memory budget the generator plans with (MB). Phones close a tab far
// below the engine's 4 GB ceiling, so they get a budget that makes it stream
// regions to storage instead of holding the whole world.
function memoryBudgetMb() {
  if (phone) {
    return 600;
  }
  const gb = navigator.deviceMemory || 8;
  return Math.max(1024, Math.min(gb * 1024 * 0.4, 3000));
}

// Tries the private file system the way WasmFS will use it. The API being
// present is not enough: private browsing modes offer it and then fail, and a
// failure inside WasmFS takes the whole engine down.
async function probeOpfs() {
  if (!(self.navigator && navigator.storage && navigator.storage.getDirectory) ||
    typeof FileSystemSyncAccessHandle === 'undefined') {
    return false;
  }
  const attempt = (async () => {
    const root = await navigator.storage.getDirectory();
    const name = '.arnis-probe';
    const file = await root.getFileHandle(name, { create: true });
    const handle = await file.createSyncAccessHandle();
    try {
      handle.write(new Uint8Array([1]), { at: 0 });
      handle.flush();
    } finally {
      handle.close();
    }
    await root.removeEntry(name).catch(() => {});
    return true;
  })();
  const timeout = new Promise((resolve) => setTimeout(() => resolve(false), 5000));
  try {
    return await Promise.race([attempt, timeout]);
  } catch (e) {
    log('info', `Private file storage unavailable (${e && e.name ? e.name : e}); worlds will last for this session only.`);
    return false;
  }
}

// Counts the engine's thread workers as they come up, so a start that stalls
// while they load says how many made it and why the rest did not.
function watchThreadWorkers() {
  const Native = self.Worker;
  if (typeof Native !== 'function') {
    return;
  }
  let created = 0;
  let loaded = 0;
  let lastError = '';
  const report = () => {
    if (!ready) {
      stage(`Starting worker threads (${loaded} of ${created} ready${lastError ? `; error: ${lastError}` : ''})…`);
    }
  };
  self.Worker = function (...args) {
    const worker = new Native(...args);
    created++;
    let counted = false;
    worker.addEventListener('message', (e) => {
      // The engine's "this worker has loaded" message.
      if (!counted && e.data && e.data.cmd === 3) {
        counted = true;
        loaded++;
        if (loaded === created || loaded % 8 === 0) {
          report();
        }
      }
    });
    worker.addEventListener('error', (e) => {
      lastError = (e && e.message) || 'failed to load';
      report();
    });
    return worker;
  };
  self.Worker.prototype = Native.prototype;
  // A start that is still waiting after 10 s reports where the count stands.
  setTimeout(report, 10000);
}

async function start() {
  if (typeof SharedArrayBuffer === 'undefined' || !self.crossOriginIsolated) {
    crash('This browser did not enable the isolation Arnis needs to run multithreaded (SharedArrayBuffer is unavailable).');
    return;
  }

  stage('Checking storage…');
  self.arnisOpfsUsable = await probeOpfs();
  self.arnisPoolSize = Number(new URLSearchParams(self.location.search).get('pool')) || poolSize();

  stage('Downloading the generator…');
  watchThreadWorkers();
  importScripts(engineUrl);
  const wasmBinary = await downloadEngine();
  stage(`Compiling the generator (${(wasmBinary.length / 1048576).toFixed(0)} MB)…`);

  engine = await createArnisEngine({
    // Emscripten starts its thread workers from this script's URL; inside a
    // worker it cannot work that out by itself.
    mainScriptUrlOrBlob: engineUrl,
    locateFile: (path) => engineFile(path),
    wasmBinary,
    print: (text) => log('info', text),
    printErr: (text) => log('error', text),
    onAbort: (reason) => crash(`The generator stopped unexpectedly: ${reason}`),
    preRun: [
      (module) => {
        // Read by the HTTP bridge: a relay for hosts without CORS headers.
        if (config.corsRelay) {
          module.ENV.ARNIS_CORS_RELAY = config.corsRelay;
        }
        module.ENV.RUST_BACKTRACE = '1';
        module.ENV.ARNIS_WEB_MEMORY_MB = String(Math.round(memoryBudgetMb()));
        module.ENV.ARNIS_WEB_DOWNLOAD_THREADS = String(downloadThreads());
      },
    ],
  });

  stage('Setting up…');

  // Set-up runs on an engine thread (it must not block this one) and calls
  // back here when it is done.
  self.arnisEngineReady = (memoryOnly) => {
    ready = true;
    postMessage({
      type: 'ready',
      storage: memoryOnly ? 'memory' : 'opfs',
      threads: navigator.hardwareConcurrency || 0,
      pool: self.arnisPoolSize,
      build: BUILD,
    });
    for (const msg of queued.splice(0)) {
      invoke(msg);
    }
  };
  engine._arnis_web_init();
}

if (!IS_ENGINE_THREAD) {
  start().catch((e) => crash(e && e.message ? e.message : e));
}
