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

const config = self.ARNIS_ENGINE_CONFIG || {};
const base = new URL('./', self.location.href);
const engineUrl = new URL('engine/arnis.js', base).href;

let engine = null;
const queued = [];

function log(level, text) {
  postMessage({ type: 'log', level, text: String(text) });
}

function crash(reason) {
  postMessage({ type: 'crash', reason: String(reason) });
}

self.addEventListener('error', (e) => crash(e.message || e));
self.addEventListener('unhandledrejection', (e) => crash(e.reason || 'unhandled rejection'));

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

self.onmessage = (e) => {
  const msg = e.data;
  if (!msg || msg.type !== 'invoke') {
    return;
  }
  if (engine) {
    invoke(msg);
  } else {
    queued.push(msg);
  }
};

async function start() {
  if (typeof SharedArrayBuffer === 'undefined' || !self.crossOriginIsolated) {
    crash('This browser did not enable the isolation Arnis needs to run multithreaded (SharedArrayBuffer is unavailable).');
    return;
  }

  importScripts(engineUrl);

  engine = await createArnisEngine({
    // Emscripten starts its thread workers from this script's URL; inside a
    // worker it cannot work that out by itself.
    mainScriptUrlOrBlob: engineUrl,
    locateFile: (path) => new URL(`engine/${path}`, base).href,
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
      },
    ],
  });

  const memoryOnly = engine._arnis_web_init();
  postMessage({
    type: 'ready',
    storage: memoryOnly ? 'memory' : 'opfs',
    threads: navigator.hardwareConcurrency || 0,
  });

  for (const msg of queued.splice(0)) {
    invoke(msg);
  }
}

start().catch((e) => crash(e && e.message ? e.message : e));
