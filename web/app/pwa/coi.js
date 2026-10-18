/*
 * Runs first on every page load. Registers the service worker that supplies
 * the cross-origin isolation headers (see sw.js) and, the first time, reloads
 * the page once it is in control, since isolation only applies to pages the
 * worker served.
 */
(function () {
  'use strict';

  const RELOAD_KEY = 'arnis-coi-reload';

  if (!('serviceWorker' in navigator)) {
    return;
  }

  const scriptUrl = new URL('../sw.js', document.currentScript ? document.currentScript.src : location.href);

  navigator.serviceWorker
    .register(scriptUrl.href, { scope: new URL('./', scriptUrl).href })
    .then((registration) => {
      if (self.crossOriginIsolated) {
        sessionStorage.removeItem(RELOAD_KEY);
        return;
      }
      // Reload at most twice per tab session, so a browser that refuses
      // isolation (some private modes) cannot loop forever.
      const tries = Number(sessionStorage.getItem(RELOAD_KEY) || '0');
      if (tries >= 2) {
        return;
      }
      let reloading = false;
      const reload = () => {
        if (reloading) {
          return;
        }
        reloading = true;
        sessionStorage.setItem(RELOAD_KEY, String(tries + 1));
        location.reload();
      };
      if (navigator.serviceWorker.controller) {
        reload();
        return;
      }
      const worker = registration.installing || registration.waiting || registration.active;
      if (worker && worker.state === 'activated') {
        reload();
      } else if (worker) {
        worker.addEventListener('statechange', () => {
          if (worker.state === 'activated') {
            reload();
          }
        });
      }
      navigator.serviceWorker.addEventListener('controllerchange', reload, { once: true });
    })
    .catch((e) => console.warn('Service worker registration failed:', e));
})();
