/**
 * JavaScript half of the Arnis browser bridge, linked into the WebAssembly
 * build with `--js-library` (see .cargo/config.toml).
 *
 * Every function here is called from Rust. The engine runs inside a Web
 * Worker and every Rust thread is a further worker, so:
 *
 *  - `arnis_http_request` runs on whichever thread called it and performs a
 *    synchronous XMLHttpRequest, which browsers allow off the main thread.
 *  - `arnis_emit_event` and `arnis_invoke_reply` are proxied to the module's
 *    main thread (the engine worker), the only one that can post to the page.
 */

addToLibrary({
  $arnisBytesToString: (ptr, len) => {
    // The heap is a SharedArrayBuffer, which TextDecoder refuses, so copy first.
    return new TextDecoder().decode(HEAPU8.slice(ptr, ptr + len));
  },

  // The body gets an allocation of its own, which Rust adopts as its Vec
  // without copying: a large area's map data is hundreds of MB.
  $arnisWriteResponse__deps: ['malloc', 'free'],
  $arnisWriteResponse: (outcome, status, head, body) => {
    const bodyBytes = body ? new Uint8Array(body) : new Uint8Array(0);
    let bodyPtr = 0;
    if (bodyBytes.length > 0) {
      bodyPtr = _malloc(bodyBytes.length);
      if (!bodyPtr) {
        outcome = 3;
        status = 0;
        head = { error: `not enough memory for a ${(bodyBytes.length / 1048576).toFixed(0)} MB response` };
      } else {
        HEAPU8.set(bodyBytes, bodyPtr);
      }
    }
    const headBytes = new TextEncoder().encode(JSON.stringify(head));
    const ptr = _malloc(20 + headBytes.length);
    if (!ptr) {
      if (bodyPtr) {
        _free(bodyPtr);
      }
      return 0;
    }
    const view = new DataView(HEAPU8.buffer, ptr, 20);
    view.setUint32(0, outcome, true);
    view.setUint32(4, status, true);
    view.setUint32(8, headBytes.length, true);
    view.setUint32(12, bodyPtr ? bodyBytes.length : 0, true);
    view.setUint32(16, bodyPtr, true);
    HEAPU8.set(headBytes, ptr + 20);
    return ptr;
  },

  $arnisParseHeaders: (raw) => {
    const headers = [];
    for (const line of (raw || '').trim().split(/[\r\n]+/)) {
      const at = line.indexOf(':');
      if (at > 0) {
        headers.push([line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim()]);
      }
    }
    return headers;
  },

  // Headers a page may not set; the browser supplies its own.
  $arnisForbiddenHeaders: [
    'accept-charset', 'accept-encoding', 'connection', 'content-length', 'cookie',
    'date', 'expect', 'host', 'keep-alive', 'origin', 'referer', 'te', 'trailer',
    'transfer-encoding', 'upgrade', 'user-agent', 'via',
  ],

  // One attempt at `url`. Returns {outcome, status, head, body}.
  $arnisXhr__deps: ['$arnisParseHeaders', '$arnisForbiddenHeaders'],
  $arnisXhr: (req, url, body) => {
    const xhr = new XMLHttpRequest();
    const started = Date.now();
    const took = () => `after ${((Date.now() - started) / 1000).toFixed(1)} s`;
    try {
      xhr.open(req.method, url, false);
      xhr.responseType = 'arraybuffer';
      if (req.timeout_ms > 0) {
        xhr.timeout = req.timeout_ms;
      }
      for (const [name, value] of req.headers) {
        if (!arnisForbiddenHeaders.includes(name.toLowerCase())) {
          xhr.setRequestHeader(name, value);
        }
      }
      xhr.send(body && body.length ? body : null);
    } catch (e) {
      const name = e && e.name;
      return {
        outcome: name === 'TimeoutError' ? 1 : 2,
        status: 0,
        head: { error: `${name || 'Error'} ${took()}: ${String(e && e.message ? e.message : e).slice(0, 160)}` },
        body: null,
      };
    }
    if (xhr.status === 0) {
      // Blocked by CORS, offline, or refused: the browser does not say which.
      return {
        outcome: 2,
        status: 0,
        head: { error: `network error ${took()} (offline, or the server does not allow cross-origin requests)` },
        body: null,
      };
    }
    return {
      outcome: 0,
      status: xhr.status,
      head: { url: xhr.responseURL || url, headers: arnisParseHeaders(xhr.getAllResponseHeaders()) },
      body: xhr.response,
    };
  },

  arnis_http_request__deps: ['$arnisBytesToString', '$arnisWriteResponse', '$arnisXhr'],
  arnis_http_request__sig: 'ppppp',
  arnis_http_request: (reqPtr, reqLen, bodyPtr, bodyLen) => {
    let req;
    try {
      req = JSON.parse(arnisBytesToString(reqPtr, reqLen));
    } catch (e) {
      return arnisWriteResponse(3, 0, { error: `bad request: ${e}` }, null);
    }
    const body = bodyLen > 0 ? HEAPU8.slice(bodyPtr, bodyPtr + bodyLen) : null;

    // Hosts that do not send CORS headers can be reached through a relay the
    // site operator configures in config.js (see web/relay). A host is tried
    // directly first; once a direct attempt fails outright and the relay
    // answers instead, this thread sends that host straight to the relay.
    const relay = req.relay;
    let host = '';
    try {
      host = new URL(req.url).host;
    } catch (e) {
      // Not an absolute URL; the request will fail on its own.
    }
    const viaRelay = (globalThis.arnisRelayHosts ||= new Set());

    let result = null;
    // One more try after a short pause when the network itself failed: a
    // passing hiccup on the way to a data host should not end a generation.
    const retryOnce = (attempt) => {
      const first = attempt();
      if (first.outcome !== 2) {
        return first;
      }
      const until = Date.now() + 1500;
      while (Date.now() < until) {
        // Synchronous request on a worker thread; a short busy wait is fine.
      }
      return attempt();
    };
    if (relay && host && viaRelay.has(host)) {
      result = retryOnce(() => arnisXhr(req, relay + encodeURIComponent(req.url), body));
      if (result.outcome === 0) {
        result.head.url = req.url;
      }
    } else {
      result = arnisXhr(req, req.url, body);
      if (result.outcome === 2 && relay && host) {
        const relayed = retryOnce(() => arnisXhr(req, relay + encodeURIComponent(req.url), body));
        if (relayed.outcome === 0) {
          relayed.head.url = req.url;
          viaRelay.add(host);
          result = relayed;
        } else {
          // The direct failure was expected (no CORS headers); the relay's is
          // the one that explains what went wrong.
          relayed.head.error = `via relay: ${relayed.head.error || 'failed'}`;
          result = relayed;
        }
      }
    }

    return arnisWriteResponse(result.outcome, result.status, result.head, result.body);
  },

  arnis_emit_event__deps: ['$arnisBytesToString'],
  arnis_emit_event__proxy: 'sync',
  arnis_emit_event__sig: 'vpppp',
  arnis_emit_event: (namePtr, nameLen, jsonPtr, jsonLen) => {
    const name = arnisBytesToString(namePtr, nameLen);
    let payload = null;
    try {
      payload = JSON.parse(arnisBytesToString(jsonPtr, jsonLen));
    } catch (e) {
      payload = null;
    }
    postMessage({ type: 'event', name, payload });
  },

  arnis_invoke_reply__deps: ['$arnisBytesToString'],
  arnis_invoke_reply__proxy: 'sync',
  arnis_invoke_reply__sig: 'viiipp',
  arnis_invoke_reply: (id, ok, kind, dataPtr, dataLen) => {
    if (kind === 1) {
      // Raw bytes: copy out of the shared heap and transfer the copy.
      const bytes = HEAPU8.slice(dataPtr, dataPtr + dataLen);
      postMessage({ type: 'reply', id, ok: !!ok, binary: true, data: bytes.buffer }, [bytes.buffer]);
      return;
    }
    let data = null;
    try {
      data = JSON.parse(arnisBytesToString(dataPtr, dataLen));
    } catch (e) {
      data = null;
    }
    postMessage({ type: 'reply', id, ok: !!ok, binary: false, data });
  },

  // The generator's stdout and stderr. Emscripten's own versions print from
  // whichever thread wrote, where nothing reaches the page; running them on
  // the main thread sends them through the engine worker's print handlers.
  emscripten_out__proxy: 'sync',
  emscripten_out: (str) => out(UTF8ToString(str)),

  emscripten_err__proxy: 'sync',
  emscripten_err: (str) => err(UTF8ToString(str)),

  // Runs on the engine worker's own thread, where engine-worker.js left a
  // callback to announce readiness to the page.
  arnis_engine_ready__proxy: 'async',
  arnis_engine_ready__sig: 'vi',
  arnis_engine_ready: (memoryOnly) => {
    if (typeof self.arnisEngineReady === 'function') {
      self.arnisEngineReady(memoryOnly);
    }
  },

  // Answered on the engine worker's thread, where engine-worker.js has
  // already tried the storage for real (see probeOpfs there): Safari's
  // private browsing, for one, offers the API and then fails every write.
  arnis_opfs_available__proxy: 'sync',
  arnis_opfs_available__sig: 'i',
  arnis_opfs_available: () => (self.arnisOpfsUsable === true ? 1 : 0),
});
