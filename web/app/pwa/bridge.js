/*
 * The Arnis web app's stand-in for Tauri.
 *
 * The desktop GUI (src/gui) talks to its Rust backend through
 * `window.__TAURI__.core.invoke` and `window.__TAURI__.event.listen`. This
 * script provides both, backed by the WebAssembly engine running in a Web
 * Worker (engine-worker.js), so the GUI runs in the browser unchanged.
 *
 * On top of that it adds what a browser needs and a desktop app does not:
 * the "Your worlds" panel to download, share or delete generated worlds from
 * browser storage, a wake lock while generating, recovery from an engine
 * crash, and notices when the browser is missing something.
 *
 * Loaded before every other script of index.html (see web/assemble.mjs).
 */
(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Engine
  // -------------------------------------------------------------------------

  const base = new URL('../', document.currentScript ? document.currentScript.src : location.href);

  let worker = null;
  let engineReady = false;
  let engineInfo = null;
  let nextId = 1;
  const pending = new Map();
  const queued = [];
  const listeners = new Map();
  let readyWaiters = [];

  function emit(name, payload) {
    for (const callback of listeners.get(name) || []) {
      try {
        callback({ event: name, id: 0, payload });
      } catch (e) {
        console.error(`Listener for ${name} failed:`, e);
      }
    }
  }

  function startEngine() {
    worker = new Worker(new URL('engine-worker.js', base), { name: 'arnis-engine' });
    worker.onmessage = (e) => onEngineMessage(e.data);
    worker.onerror = (e) => onCrash(e.message || 'the generator failed to start');
  }

  function onEngineMessage(msg) {
    switch (msg && msg.type) {
      case 'ready':
        engineReady = true;
        engineInfo = msg;
        setStatus(null);
        if (msg.storage === 'memory') {
          toast('This browser cannot keep files, so download each world before closing the tab.', 'warn', 9000);
        }
        for (const send of queued.splice(0)) {
          send();
        }
        for (const resolve of readyWaiters.splice(0)) {
          resolve();
        }
        break;
      case 'reply': {
        const p = pending.get(msg.id);
        if (!p) {
          return;
        }
        pending.delete(msg.id);
        if (msg.ok) {
          p.resolve(msg.data);
        } else {
          p.reject(msg.data);
        }
        break;
      }
      case 'event':
        onEngineEvent(msg.name, msg.payload);
        break;
      case 'log':
        if (msg.level === 'error') {
          console.warn('[engine]', msg.text);
        } else {
          console.log('[engine]', msg.text);
        }
        break;
      case 'crash':
        onCrash(msg.reason);
        break;
      default:
        break;
    }
  }

  function onCrash(reason) {
    console.error('Arnis engine crashed:', reason);
    const wasGenerating = generating;
    if (worker) {
      worker.terminate();
      worker = null;
    }
    engineReady = false;
    for (const [, p] of pending) {
      p.reject(String(reason));
    }
    pending.clear();

    if (!self.crossOriginIsolated) {
      showIsolationNotice();
      return;
    }
    if (wasGenerating) {
      endGeneration();
      emit('progress-update', {
        progress: 0,
        message: /memory|allocat|OOM/i.test(String(reason))
          ? 'Error! Out of memory. Try a smaller area.'
          : 'Error! The generator stopped unexpectedly.',
      });
    }
    // A crash during a generation (usually memory) is worth one fresh start;
    // an engine that cannot even start would otherwise restart forever.
    const now = Date.now();
    restarts = restarts.filter((t) => now - t < 60000);
    if (restarts.length >= 3) {
      setStatus(null);
      showEngineFailedNotice(reason);
      return;
    }
    restarts.push(now);
    setStatus('Restarting the generator…');
    setTimeout(startEngine, 1000);
  }

  let restarts = [];

  function showEngineFailedNotice(reason) {
    const notice = el(
      'div',
      { class: 'web-blocker', role: 'alert' },
      el('h2', {}, 'The generator could not start'),
      el('p', {}, `It stopped repeatedly in this browser (${String(reason).slice(0, 160)}).`),
      el('p', {}, 'Reload the page to try again, or check this browser for missing features.'),
      el('button', { type: 'button', class: 'web-button', onclick: () => location.reload() }, 'Reload'),
      el('a', { href: new URL('diagnostics.html', base).href }, 'Check this browser'),
    );
    document.body.append(notice);
  }

  function post(cmd, args) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      const send = () => worker.postMessage({ type: 'invoke', id, cmd, args: args || {} });
      if (engineReady) {
        send();
      } else {
        queued.push(send);
      }
    });
  }

  function whenReady() {
    return engineReady ? Promise.resolve() : new Promise((resolve) => readyWaiters.push(resolve));
  }

  // -------------------------------------------------------------------------
  // The Tauri API surface the GUI uses
  // -------------------------------------------------------------------------

  async function invoke(cmd, args) {
    switch (cmd) {
      // The site updates itself; there is nothing to download.
      case 'gui_get_update_info':
        return null;
      case 'gui_log': {
        const level = args && args.level;
        const message = args && args.message;
        (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)('[gui]', message);
        return null;
      }
      // "Show in folder" becomes "show it in the worlds panel".
      case 'gui_show_in_folder':
        openWorlds(args && args.path);
        return null;
      case 'gui_pick_save_directory':
        return (args && args.startPath) || '';
      // Answered here rather than by the engine, so the GUI can finish
      // setting up while the engine is still downloading on a first visit.
      case 'gui_get_default_save_path':
      case 'gui_get_default_luanti_save_path':
        return '/data/worlds';
      case 'gui_get_default_bedrock_save_path':
        return '/data/exports';
      case 'gui_set_save_path': {
        const path = (args && args.path) || '';
        if (path === '/data/worlds' || path === '/data/exports') {
          return path;
        }
        throw 'Worlds are kept in the browser’s own storage.';
      }
      case 'gui_get_version':
        return (self.ARNIS_BUILD && self.ARNIS_BUILD.version) || post(cmd, args);
      case 'gui_get_platform':
        return 'web';
      case 'gui_start_generation':
        return startGeneration(args);
      default:
        return post(cmd, args);
    }
  }

  function listen(name, callback) {
    if (!listeners.has(name)) {
      listeners.set(name, new Set());
    }
    listeners.get(name).add(callback);
    return Promise.resolve(() => listeners.get(name).delete(callback));
  }

  function openExternal(url) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return Promise.resolve();
  }

  window.__TAURI__ = {
    core: { invoke },
    event: { listen },
    shell: { open: openExternal },
  };
  // Lets the map and other pages reach the same bridge if they ever need it.
  window.arnisWeb = { invoke, listen, openWorlds, engineInfo: () => engineInfo };

  // -------------------------------------------------------------------------
  // Generation lifecycle
  // -------------------------------------------------------------------------

  let generating = false;
  let wakeLock = null;

  async function requestWakeLock() {
    if (wakeLock) {
      return;
    }
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
          wakeLock = null;
        });
      }
    } catch (e) {
      // Not available or refused (low battery); generation still runs.
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (generating && document.visibilityState === 'visible' && !wakeLock) {
      requestWakeLock();
    }
  });

  // Safari only grants the lock during a tap, and the GUI asks the engine for
  // a world before it starts, which takes longer than a tap lasts. So the lock
  // is taken here, on the tap that starts the generation, and released again
  // if no run follows.
  document.addEventListener(
    'click',
    (e) => {
      const target = e.target && e.target.closest ? e.target.closest('#start-button, .world-name-row') : null;
      if (!target || generating || e.target.closest('input, .world-name-edit-button')) {
        return;
      }
      requestWakeLock().then(() => {
        setTimeout(() => {
          if (!generating && wakeLock) {
            wakeLock.release().catch(() => {});
            wakeLock = null;
          }
        }, 15000);
      });
    },
    true,
  );

  window.addEventListener('beforeunload', (e) => {
    if (generating) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  function areaKm2(bboxText) {
    const v = String(bboxText || '')
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    if (v.length !== 4 || v.some((n) => !Number.isFinite(n))) {
      return 0;
    }
    const [minLat, minLng, maxLat, maxLng] = v;
    const midLat = ((minLat + maxLat) / 2) * (Math.PI / 180);
    return Math.abs(maxLat - minLat) * 111.32 * Math.abs(maxLng - minLng) * 111.32 * Math.cos(midLat);
  }

  function isPhone() {
    if (navigator.userAgentData && typeof navigator.userAgentData.mobile === 'boolean') {
      return navigator.userAgentData.mobile;
    }
    return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  }

  // Generation memory grows with the area and the scale. Phones give a page
  // far less memory than a computer, so a large area there gets a warning
  // instead of a crash halfway through.
  function confirmLargeArea(args) {
    const scale = Number(args && args.worldScale) || 1;
    const effective = areaKm2(args && args.bboxText) * scale * scale;
    const limit = isPhone() ? 2 : 40;
    if (effective <= limit) {
      return true;
    }
    return confirm(
      `This area is about ${effective.toFixed(1)} km² at the chosen scale, which may need more memory than ` +
        `this ${isPhone() ? 'phone' : 'browser'} allows. A smaller area is safer. Generate anyway?`,
    );
  }

  async function startGeneration(args) {
    if (!confirmLargeArea(args)) {
      // The GUI already made an empty world for this run; take it away again.
      if (args && args.isNewWorld && !args.oneWorld && args.worldFormat === 'java' && args.selectedWorld) {
        post('web_remove_path', { path: args.selectedWorld }).catch(() => {});
      }
      emit('progress-update', { progress: 0, message: 'Error! Cancelled: choose a smaller area.' });
      throw 'cancelled';
    }
    await whenReady();
    const result = await post('gui_start_generation', args);
    generating = true;
    document.documentElement.classList.add('web-generating');
    requestWakeLock();
    writeJournal({
      startedAt: Date.now(),
      bbox: args && args.bboxText,
      format: args && args.worldFormat,
      // A Java world is created before the run and is incomplete if it stops.
      partialWorld: args && args.worldFormat === 'java' && !args.oneWorld ? args.selectedWorld : '',
      hidden: false,
    });
    return result;
  }

  // --- Interrupted runs ---------------------------------------------------
  //
  // iOS closes a tab that uses too much memory and reloads it when it is
  // shown again, and every browser may discard a background tab. The page
  // then starts from scratch, so a note of the run in progress is kept to
  // explain what happened and tidy up after it.

  const JOURNAL_KEY = 'arnis-web-running';
  const BBOX_KEY = 'arnis-web-last-bbox';

  function writeJournal(entry) {
    try {
      localStorage.setItem(JOURNAL_KEY, JSON.stringify(entry));
    } catch (e) {
      // Storage refused: nothing to recover from later.
    }
  }

  function readJournal() {
    try {
      return JSON.parse(localStorage.getItem(JOURNAL_KEY) || 'null');
    } catch (e) {
      return null;
    }
  }

  function clearJournal() {
    try {
      localStorage.removeItem(JOURNAL_KEY);
    } catch (e) {
      // Nothing to clear.
    }
  }

  function noteInJournal(field, value) {
    if (!generating) {
      return;
    }
    const entry = readJournal();
    if (entry) {
      entry[field] = value;
      writeJournal(entry);
    }
  }

  // Hidden and shown again, the run carries on; hidden for good, the browser
  // froze or discarded the page in the background.
  document.addEventListener('visibilitychange', () => {
    noteInJournal('hidden', document.visibilityState === 'hidden');
  });

  // Reloading or leaving the page also hides it first, so this is what tells
  // a reload apart from the background. An out-of-memory kill fires neither.
  window.addEventListener('pagehide', () => noteInJournal('unloading', true));

  async function recoverInterruptedRun() {
    const entry = readJournal();
    if (!entry) {
      return;
    }
    clearJournal();
    if (entry.partialWorld) {
      post('web_remove_path', { path: entry.partialWorld }).catch(() => {});
    }
    // Older than a day: not worth mentioning.
    if (Date.now() - (entry.startedAt || 0) > 86400000) {
      return;
    }
    const message = entry.unloading
      ? 'Your last generation stopped because the page was reloaded or closed. Your area is still selected; press Start Generation to run it again.'
      : entry.hidden
        ? 'Your last generation stopped because the browser paused Arnis in the background. Keep Arnis open on screen until the world is finished.'
        : 'Your last generation stopped because the browser closed the page, most likely because it ran out of memory. Your area is still selected; try a smaller one.';
    toast(message, 'warn', 0);
  }

  // The selected area survives a reload: the GUI keeps it only in memory.
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (data && typeof data.bboxText === 'string' && !data.type && data.bboxText.trim()) {
      try {
        localStorage.setItem(BBOX_KEY, data.bboxText.trim());
      } catch (e) {
        // Not remembered; harmless.
      }
    }
  });

  function restoreSelection() {
    let saved = null;
    try {
      saved = localStorage.getItem(BBOX_KEY);
    } catch (e) {
      return;
    }
    const bounds = String(saved || '')
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    if (bounds.length !== 4 || bounds.some((n) => !Number.isFinite(n))) {
      return;
    }
    const frame = document.querySelector('.map-container');
    if (!frame) {
      return;
    }
    // The map announces nothing when it is ready, so wait for the frame to
    // load and Leaflet to set up, then hand it the area like the coordinate
    // field in Settings does.
    const send = () => {
      setTimeout(() => {
        if (frame.contentWindow) {
          frame.contentWindow.postMessage({ type: 'setBbox', bounds }, '*');
        }
      }, 1200);
    };
    let ready = false;
    try {
      ready = frame.contentDocument && frame.contentDocument.readyState === 'complete';
    } catch (e) {
      ready = false;
    }
    if (ready) {
      send();
    } else {
      frame.addEventListener('load', send, { once: true });
    }
  }

  function endGeneration() {
    clearJournal();
    generating = false;
    document.documentElement.classList.remove('web-generating');
    if (wakeLock) {
      wakeLock.release().catch(() => {});
      wakeLock = null;
    }
  }

  function onEngineEvent(name, payload) {
    if (name === 'progress-update' && payload && typeof payload.message === 'string') {
      if (payload.message.startsWith('Done!')) {
        endGeneration();
        onWorldFinished();
      } else if (payload.message.startsWith('Error!')) {
        endGeneration();
      }
    }
    if (name === 'show-in-folder') {
      // Bedrock reports its .mcworld here; the panel opens on Done anyway.
      return;
    }
    emit(name, payload);
  }

  async function onWorldFinished() {
    // Keep the browser from clearing worlds when space runs low.
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }
    const outputs = await refreshWorlds();
    const newest = outputs && outputs[0];
    if (newest) {
      toast(`“${newest.name}” is ready.`, 'ok', 12000, {
        label: 'Download',
        action: () => openWorlds(newest.path, true),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Small UI helpers
  // -------------------------------------------------------------------------

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (key === 'class') {
        node.className = value;
      } else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2), value);
      } else if (value !== false && value != null) {
        node.setAttribute(key, value === true ? '' : value);
      }
    }
    for (const child of children.flat()) {
      if (child != null && child !== false) {
        node.append(child.nodeType ? child : document.createTextNode(String(child)));
      }
    }
    return node;
  }

  function icon(id) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#${id}`);
    svg.append(use);
    return svg;
  }

  function formatBytes(bytes) {
    if (!bytes) {
      return '0 B';
    }
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const value = bytes / 1024 ** i;
    return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
  }

  function formatDate(seconds) {
    if (!seconds) {
      return '';
    }
    return new Date(seconds * 1000).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  }

  let statusNode = null;

  function setStatus(text) {
    if (!statusNode) {
      statusNode = el('div', { class: 'web-status', role: 'status', 'aria-live': 'polite' });
      document.body.append(statusNode);
    }
    statusNode.textContent = text || '';
    statusNode.hidden = !text;
  }

  let toastHost = null;

  function toast(text, kind, ms, button) {
    if (!toastHost) {
      toastHost = el('div', { class: 'web-toasts', 'aria-live': 'polite' });
      document.body.append(toastHost);
    }
    const node = el('div', { class: `web-toast web-toast-${kind || 'info'}` }, el('span', {}, text));
    const close = () => node.remove();
    if (button) {
      node.append(
        el(
          'button',
          {
            type: 'button',
            class: 'web-toast-action',
            onclick: () => {
              close();
              button.action();
            },
          },
          button.label,
        ),
      );
    }
    node.append(el('button', { type: 'button', class: 'web-toast-close', 'aria-label': 'Dismiss', onclick: close }, '×'));
    toastHost.append(node);
    if (ms) {
      setTimeout(close, ms);
    }
  }

  function showIsolationNotice() {
    setStatus(null);
    const notice = el(
      'div',
      { class: 'web-blocker', role: 'alert' },
      el('h2', {}, 'This browser can’t run the generator'),
      el(
        'p',
        {},
        'Arnis runs entirely on your device and needs a browser feature (SharedArrayBuffer) that is turned off here. ',
        'Use a current version of Chrome, Edge, Firefox or Safari, outside private browsing, and reload the page.',
      ),
      el('button', { type: 'button', class: 'web-button', onclick: () => location.reload() }, 'Reload'),
      el('a', { href: new URL('diagnostics.html', base).href }, 'Check this browser'),
    );
    document.body.append(notice);
  }

  // -------------------------------------------------------------------------
  // "Your worlds": download, share and delete
  // -------------------------------------------------------------------------

  let sheet = null;
  let listNode = null;
  let usageNode = null;
  let outputs = [];
  const busy = new Set();

  function buildSheet() {
    listNode = el('ul', { class: 'web-worlds-list' });
    usageNode = el('p', { class: 'web-worlds-usage' });
    sheet = el(
      'div',
      { class: 'web-sheet', id: 'web-worlds', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'web-worlds-title', hidden: true },
      el('div', { class: 'web-sheet-backdrop', onclick: closeWorlds }),
      el(
        'div',
        { class: 'web-sheet-panel' },
        el(
          'header',
          { class: 'web-sheet-header' },
          el('h2', { id: 'web-worlds-title' }, 'Your worlds'),
          el('button', { type: 'button', class: 'web-icon-button', 'aria-label': 'Close', onclick: closeWorlds }, icon('i-x')),
        ),
        el(
          'p',
          { class: 'web-worlds-intro' },
          'Worlds are kept in this browser until you delete them. Java worlds download as a .zip: unzip it into your Minecraft saves folder. Bedrock worlds are .mcworld files: open or share them to Minecraft.',
        ),
        listNode,
        usageNode,
        el(
          'p',
          { class: 'web-worlds-usage' },
          'Something not working? ',
          el('a', { href: new URL('diagnostics.html', base).href, target: '_blank', rel: 'noopener' }, 'Check this browser'),
          '.',
        ),
      ),
    );
    document.body.append(sheet);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && sheet && !sheet.hidden) {
        closeWorlds();
      }
    });
  }

  async function refreshWorlds(highlightPath) {
    try {
      await whenReady();
      outputs = await post('web_list_outputs', {});
    } catch (e) {
      console.error('Could not list worlds:', e);
      outputs = [];
    }
    renderWorlds(highlightPath);
    updateWorldsBadge();
    return outputs;
  }

  async function renderUsage() {
    if (!usageNode) {
      return;
    }
    try {
      const { usage, quota } = await navigator.storage.estimate();
      usageNode.textContent = `Storage used: ${formatBytes(usage)} of about ${formatBytes(quota)} available to this site.`;
    } catch (e) {
      usageNode.textContent = '';
    }
  }

  function renderWorlds(highlightPath) {
    if (!listNode) {
      return;
    }
    listNode.replaceChildren();
    if (!outputs.length) {
      listNode.append(el('li', { class: 'web-worlds-empty' }, 'No worlds yet. Select an area on the map and press Start Generation.'));
    }
    for (const entry of outputs) {
      const kindLabel = { java: 'Java', bedrock: 'Bedrock', luanti: 'Luanti' }[entry.kind] || entry.kind;
      const progress = el('div', { class: 'web-progress', hidden: true }, el('div', { class: 'web-progress-bar' }));
      const actions = el('div', { class: 'web-worlds-actions' });
      const item = el(
        'li',
        { class: `web-worlds-item${entry.path === highlightPath ? ' is-new' : ''}` },
        el(
          'div',
          { class: 'web-worlds-meta' },
          el('span', { class: 'web-worlds-name' }, entry.name),
          el(
            'span',
            { class: 'web-worlds-detail' },
            el('span', { class: `web-badge web-badge-${entry.kind}` }, kindLabel),
            ` ${formatBytes(entry.bytes)} · ${formatDate(entry.modified)}`,
          ),
        ),
        actions,
        progress,
      );
      const disabled = busy.has(entry.path) || (generating && entry === outputs[0]);
      actions.append(
        el(
          'button',
          { type: 'button', class: 'web-button web-button-primary', disabled, onclick: () => saveOutput(entry, item, 'download') },
          icon('i-download'),
          ' Download',
        ),
      );
      if (canShareFiles()) {
        actions.append(
          el('button', { type: 'button', class: 'web-button', disabled, onclick: () => saveOutput(entry, item, 'share') }, 'Share'),
        );
      }
      actions.append(
        el('button', { type: 'button', class: 'web-button web-button-danger', disabled, onclick: () => deleteOutput(entry) }, 'Delete'),
      );
      listNode.append(item);
    }
    renderUsage();
  }

  function canShareFiles() {
    try {
      return (
        typeof navigator.canShare === 'function' &&
        navigator.canShare({ files: [new File([''], 'probe.zip', { type: 'application/zip' })] })
      );
    } catch (e) {
      return false;
    }
  }

  const CHUNK = 8 * 1024 * 1024;

  async function* fileChunks(path, size, onBytes) {
    for (let offset = 0; offset < size; offset += CHUNK) {
      const buffer = await post('web_read_chunk', { path, offset, length: Math.min(CHUNK, size - offset) });
      const bytes = new Uint8Array(buffer);
      onBytes(bytes.length);
      yield bytes;
      if (!bytes.length) {
        break;
      }
    }
  }

  async function buildFile(entry, onProgress) {
    let done = 0;
    const total = Math.max(entry.bytes, 1);
    const tick = (n) => {
      done += n;
      onProgress(Math.min(1, done / total));
    };

    if (!entry.is_dir) {
      const parts = [];
      for await (const bytes of fileChunks(entry.path, entry.bytes, tick)) {
        parts.push(bytes);
      }
      return new File(parts, entry.name, { type: 'application/octet-stream' });
    }

    const files = await post('web_list_tree', { path: entry.path });
    const zip = new self.ArnisZip.ZipWriter();
    for (const file of files) {
      await zip.addFile(`${entry.name}/${file.path}`, fileChunks(`${entry.path}/${file.path}`, file.bytes, tick));
    }
    return new File([zip.finish()], `${entry.name}.zip`, { type: 'application/zip' });
  }

  async function saveOutput(entry, item, how) {
    if (busy.has(entry.path)) {
      return;
    }
    busy.add(entry.path);
    const progress = item.querySelector('.web-progress');
    const bar = item.querySelector('.web-progress-bar');
    item.querySelectorAll('button').forEach((b) => {
      b.disabled = true;
    });
    progress.hidden = false;
    bar.style.width = '0%';
    try {
      const file = await buildFile(entry, (f) => {
        bar.style.width = `${Math.round(f * 100)}%`;
      });
      if (how === 'share') {
        try {
          await navigator.share({ files: [file], title: entry.name });
        } catch (e) {
          if (e && e.name === 'AbortError') {
            return;
          }
          // Some platforms refuse large files; fall back to a download.
          download(file);
        }
      } else {
        download(file);
      }
    } catch (e) {
      console.error('Download failed:', e);
      toast(`Could not prepare “${entry.name}”: ${e && e.message ? e.message : e}`, 'error', 10000);
    } finally {
      busy.delete(entry.path);
      progress.hidden = true;
      renderWorlds();
    }
  }

  function download(file) {
    const url = URL.createObjectURL(file);
    const a = el('a', { href: url, download: file.name, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    // Long enough for the browser to start reading a large file.
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  }

  async function deleteOutput(entry) {
    if (!confirm(`Delete “${entry.name}” from this browser? Download it first if you want to keep it.`)) {
      return;
    }
    try {
      await post('web_remove_path', { path: entry.path });
    } catch (e) {
      toast(`Could not delete “${entry.name}”: ${e}`, 'error', 8000);
    }
    refreshWorlds();
  }

  function openWorlds(highlightPath, scrollToIt) {
    if (!sheet) {
      buildSheet();
    }
    sheet.hidden = false;
    document.documentElement.classList.add('web-sheet-open');
    refreshWorlds(highlightPath).then(() => {
      if (scrollToIt) {
        const item = listNode.querySelector('.is-new');
        if (item) {
          item.scrollIntoView({ block: 'nearest' });
        }
      }
    });
    const close = sheet.querySelector('.web-sheet-header button');
    if (close) {
      close.focus();
    }
  }

  function closeWorlds() {
    if (sheet) {
      sheet.hidden = true;
    }
    document.documentElement.classList.remove('web-sheet-open');
  }

  let worldsButton = null;

  function updateWorldsBadge() {
    if (worldsButton) {
      worldsButton.dataset.count = outputs.length ? String(outputs.length) : '';
    }
  }

  function addWorldsButton() {
    const settings = document.querySelector('.button-block-row .settings-button');
    if (!settings) {
      return;
    }
    worldsButton = el(
      'button',
      { type: 'button', class: 'settings-button web-worlds-button', 'aria-label': 'Your worlds', title: 'Your worlds', onclick: () => openWorlds() },
      icon('i-folder-open'),
    );
    settings.before(worldsButton);
  }

  // -------------------------------------------------------------------------
  // Start-up
  // -------------------------------------------------------------------------

  document.documentElement.classList.add('arnis-web');

  function boot() {
    addWorldsButton();
    if (!self.crossOriginIsolated) {
      // coi.js is reloading the page into isolation, or the browser refused.
      const reloadingSoon = 'serviceWorker' in navigator && Number(sessionStorage.getItem('arnis-coi-reload') || '0') < 2;
      setTimeout(() => {
        if (!self.crossOriginIsolated) {
          showIsolationNotice();
        }
      }, reloadingSoon ? 6000 : 0);
      return;
    }
    setStatus('Loading the generator…');
    startEngine();
    restoreSelection();
    whenReady()
      .then(() => recoverInterruptedRun())
      .then(() => refreshWorlds());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
