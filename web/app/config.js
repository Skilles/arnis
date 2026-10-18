/*
 * Site settings for the Arnis web build, read by the page and the engine.
 *
 * corsRelay: a URL prefix the engine may use for data hosts that do not allow
 * cross-origin requests from browsers (for example the ESA WorldCover land
 * cover and Meta canopy height buckets). The target URL is appended
 * URL-encoded, e.g. "https://relay.example.workers.dev/?url=". Leave it empty
 * to call every host directly; generation still works, but layers from hosts
 * that refuse browsers are skipped. See web/relay/ for a ready-made relay.
 */
self.ARNIS_CONFIG = {
  corsRelay: 'https://arnis-relay.vercel.app/api/relay?url=',
};
