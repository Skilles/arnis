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

  $arnisWriteResponse__deps: ['malloc'],
  $arnisWriteResponse: (outcome, status, head, body) => {
    const headBytes = new TextEncoder().encode(JSON.stringify(head));
    const bodyBytes = body ? new Uint8Array(body) : new Uint8Array(0);
    const total = 16 + headBytes.length + bodyBytes.length;
    const ptr = _malloc(total);
    if (!ptr) {
      return 0;
    }
    const view = new DataView(HEAPU8.buffer, ptr, 16);
    view.setUint32(0, outcome, true);
    view.setUint32(4, status, true);
    view.setUint32(8, headBytes.length, true);
    view.setUint32(12, bodyBytes.length, true);
    HEAPU8.set(headBytes, ptr + 16);
    HEAPU8.set(bodyBytes, ptr + 16 + headBytes.length);
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
        head: { error: `${name || 'Error'}: ${e && e.message ? e.message : e}` },
        body: null,
      };
    }
    if (xhr.status === 0) {
      // Blocked by CORS, offline, or refused: the browser does not say which.
      return {
        outcome: 2,
        status: 0,
        head: { error: 'network error (offline, or the server does not allow cross-origin requests)' },
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
    if (relay && host && viaRelay.has(host)) {
      result = arnisXhr(req, relay + encodeURIComponent(req.url), body);
      if (result.outcome === 0) {
        result.head.url = req.url;
      }
    } else {
      result = arnisXhr(req, req.url, body);
      if (result.outcome === 2 && relay && host) {
        const relayed = arnisXhr(req, relay + encodeURIComponent(req.url), body);
        if (relayed.outcome === 0) {
          relayed.head.url = req.url;
          viaRelay.add(host);
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

  arnis_opfs_available__sig: 'i',
  arnis_opfs_available: () => {
    try {
      return typeof navigator !== 'undefined' &&
        navigator.storage &&
        typeof navigator.storage.getDirectory === 'function' &&
        typeof FileSystemSyncAccessHandle !== 'undefined'
        ? 1
        : 0;
    } catch (e) {
      return 0;
    }
  },
});
