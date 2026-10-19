/*
 * CORS relay for the Arnis web app.
 *
 * A few of the data sources Arnis reads do not send CORS headers, so a page
 * cannot read them directly: the ESA WorldCover land cover and the Meta
 * canopy height buckets on S3, the 3D model hosts, and possibly the Arnis tile
 * archive. This relay fetches from those hosts, and only those, and returns
 * the response with CORS headers added. The generator itself still runs in
 * the visitor's browser; the relay only passes bytes through.
 *
 * Deploy it as a Cloudflare Worker (see README.md here) or as a Vercel Edge
 * Function (api/relay.js), then put its URL in config.js:
 *
 *   corsRelay: 'https://<your-relay>/?url='
 */

// Hosts the relay will fetch from. Requests for anything else are refused,
// so the relay cannot be used as an open proxy.
const ALLOWED_HOSTS = new Set([
  'tiles.arnisproject.com',
  'api.arnismc.com',
  'esa-worldcover.s3.eu-central-1.amazonaws.com',
  'dataforgood-fb-data.s3.amazonaws.com',
  'pds-geosciences.wustl.edu',
  '3dmr.eu',
  'commons.wikimedia.org',
  'upload.wikimedia.org',
]);

// Request headers worth passing on.
const FORWARDED_REQUEST_HEADERS = ['range', 'content-type', 'accept', 'if-none-match', 'if-modified-since'];

const EXPOSED_RESPONSE_HEADERS = [
  'content-length',
  'content-range',
  'content-type',
  'accept-ranges',
  'etag',
  'last-modified',
  'retry-after',
].join(', ');

// Hosts whose answers can take a long time to start: an Overpass query for a
// large area may compute for a minute before its first byte. Some browsers
// and networks drop a request that has received nothing for 30-60 s, so for
// these the relay answers at once and keeps the line busy while it waits (see
// deferredResponse). Only when the caller asks with &deferred=1, since the
// body then has to be unwrapped.
const DEFERRED_HOSTS = new Set(['api.arnismc.com']);

// How often a waiting deferred response sends a byte.
const KEEPALIVE_MS = 5000;

const MAX_REDIRECTS = 5;

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type, Accept, If-None-Match, If-Modified-Since',
    'Access-Control-Expose-Headers': `${EXPOSED_RESPONSE_HEADERS}, x-relay-deferred`,
    'Access-Control-Max-Age': '86400',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    Vary: 'Origin',
  };
}

function refuse(status, message, origin) {
  return new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders(origin) },
  });
}

function allowedOrigin(origin, allowedOrigins) {
  if (!allowedOrigins || allowedOrigins.length === 0) {
    return '*';
  }
  return allowedOrigins.includes(origin) ? origin : null;
}

/**
 * Handles one request. `allowedOrigins` optionally limits which sites may use
 * the relay (for example ['https://you.github.io']); empty allows any.
 */
export async function handleRelay(request, allowedOrigins = []) {
  const requestOrigin = request.headers.get('Origin') || '';
  const origin = allowedOrigin(requestOrigin, allowedOrigins);
  if (origin === null) {
    return new Response('This relay serves a specific site only.', { status: 403 });
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (!['GET', 'HEAD', 'POST'].includes(request.method)) {
    return refuse(405, 'Method not allowed.', origin);
  }

  const target = new URL(request.url).searchParams.get('url');
  if (!target) {
    return refuse(400, 'Usage: ?url=<encoded https URL>', origin);
  }

  let url;
  try {
    url = new URL(target);
  } catch {
    return refuse(400, 'Not a valid URL.', origin);
  }

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }
  headers.set('User-Agent', 'Arnis-Web-Relay/1.0 (+https://github.com/Skilles/arnis)');

  const body = request.method === 'POST' ? await request.arrayBuffer() : undefined;

  const wantsDeferred = new URL(request.url).searchParams.get('deferred') === '1';
  if (wantsDeferred && request.method !== 'HEAD' && !request.headers.has('Range') &&
    url.protocol === 'https:' && DEFERRED_HOSTS.has(url.hostname)) {
    return deferredResponse(request, url, headers, body, origin);
  }

  // Redirects are followed by hand so that every hop is checked against the
  // allowlist (Wikimedia Commons redirects to upload.wikimedia.org).
  let response;
  for (let hop = 0; ; hop++) {
    if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
      return refuse(403, `Host not allowed: ${url.hostname}`, origin);
    }
    try {
      response = await fetch(url.toString(), {
        method: request.method,
        headers,
        body,
        redirect: 'manual',
      });
    } catch (e) {
      // Answer with CORS headers either way: a crash would surface as the
      // platform's own error page, which the browser reports as "offline".
      return refuse(502, `Could not reach ${url.hostname}: ${e && e.message ? e.message : e}`, origin);
    }
    const location = response.headers.get('Location');
    if (response.status >= 300 && response.status < 400 && location) {
      if (hop >= MAX_REDIRECTS) {
        return refuse(508, 'Too many redirects.', origin);
      }
      url = new URL(location, url);
      continue;
    }
    break;
  }

  const out = new Headers();
  for (const name of EXPOSED_RESPONSE_HEADERS.split(', ')) {
    const value = response.headers.get(name);
    if (value) {
      out.set(name, value);
    }
  }
  for (const [name, value] of Object.entries(corsHeaders(origin))) {
    out.set(name, value);
  }
  // A shared cache (Vercel's CDN, Cloudflare's) keys on the URL alone, and
  // every range of one file has the same URL here, so a cached 206 would be
  // served for every other range. Ranged answers are therefore kept out of
  // shared caches; whole files from these hosts change rarely and may stay.
  const ranged = response.status === 206 || request.headers.has('Range');
  if (ranged) {
    out.set('Cache-Control', 'private, no-store');
    out.set('CDN-Cache-Control', 'no-store');
    out.set('Vercel-CDN-Cache-Control', 'no-store');
  } else if (response.status === 200) {
    out.set('Cache-Control', 'public, max-age=86400');
  } else {
    out.set('Cache-Control', 'no-store');
  }

  return new Response(response.body, { status: response.status, headers: out });
}

/*
 * A response that starts at once, for a slow upstream.
 *
 * The body is: a space every few seconds while the upstream works, then one
 * line of JSON {"status": <upstream status>, "headers": [[name, value], ...]}
 * (or {"status": 502, "error": "..."}), a newline, and the upstream body as
 * is. The page's HTTP bridge unwraps it (web/engine/arnis-lib.js).
 *
 * It is gzipped here, flushed after every write: a platform that compressed
 * it would hold the spaces back until it had enough to compress, which would
 * defeat them, and the bodies these hosts send (Overpass JSON) shrink about
 * tenfold.
 */
async function deferredResponse(request, url, headers, body, origin) {
  let zlib = null;
  if (/\bgzip\b/.test(request.headers.get('Accept-Encoding') || '')) {
    try {
      zlib = await import('node:zlib');
    } catch {
      zlib = null;
    }
  }
  const encoder = new TextEncoder();
  let controller;
  let pullWaiter = null;
  const stream = new ReadableStream(
    {
      start(c) {
        controller = c;
      },
      pull() {
        if (pullWaiter) {
          pullWaiter();
          pullWaiter = null;
        }
      },
      cancel() {
        aborted = true;
        clearInterval(timer);
        upstreamAbort.abort();
        if (pullWaiter) {
          pullWaiter();
          pullWaiter = null;
        }
      },
    },
    { highWaterMark: 4 },
  );
  let aborted = false;
  const upstreamAbort = new AbortController();
  const roomToWrite = () => {
    if (aborted || controller.desiredSize > 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      pullWaiter = resolve;
    });
  };

  // write(bytes) sends bytes on, compressed and flushed when possible.
  let write;
  let finish;
  if (zlib) {
    const gz = zlib.createGzip({ level: 4 });
    gz.on('data', (chunk) => {
      if (!aborted) {
        controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      }
    });
    const ended = new Promise((resolve) => gz.on('end', resolve));
    write = async (bytes, flush) => {
      await roomToWrite();
      if (!gz.write(bytes)) {
        await new Promise((resolve) => gz.once('drain', resolve));
      }
      if (flush) {
        await new Promise((resolve) => gz.flush(zlib.constants.Z_SYNC_FLUSH, resolve));
      }
    };
    finish = async () => {
      gz.end();
      await ended;
    };
  } else {
    write = async (bytes) => {
      await roomToWrite();
      if (!aborted) {
        controller.enqueue(bytes);
      }
    };
    finish = async () => {};
  }

  // Writes are chained so a keep-alive never lands inside the body.
  let chain = Promise.resolve();
  const queue = (bytes, flush) => {
    chain = chain.then(() => (aborted ? undefined : write(bytes, flush)));
    return chain;
  };
  const space = encoder.encode(' ');
  let waiting = true;
  const timer = setInterval(() => {
    if (waiting) {
      queue(space, true);
    }
  }, KEEPALIVE_MS);
  queue(space, true);

  (async () => {
    let response = null;
    let error = '';
    try {
      for (let hop = 0; ; hop++) {
        if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
          error = `Host not allowed: ${url.hostname}`;
          break;
        }
        response = await fetch(url.toString(), {
          method: request.method,
          headers,
          body,
          redirect: 'manual',
          signal: upstreamAbort.signal,
        });
        const location = response.headers.get('Location');
        if (response.status >= 300 && response.status < 400 && location) {
          if (hop >= MAX_REDIRECTS) {
            error = 'Too many redirects.';
            response = null;
            break;
          }
          url = new URL(location, url);
          continue;
        }
        break;
      }
    } catch (e) {
      response = null;
      error = `Could not reach ${url.hostname}: ${e && e.message ? e.message : e}`;
    }
    waiting = false;
    clearInterval(timer);

    try {
      if (!response) {
        await queue(encoder.encode(`${JSON.stringify({ status: 502, error })}\n`), false);
      } else {
        const head = [];
        for (const name of EXPOSED_RESPONSE_HEADERS.split(', ')) {
          const value = response.headers.get(name);
          if (value && name !== 'content-length') {
            head.push([name, value]);
          }
        }
        await queue(encoder.encode(`${JSON.stringify({ status: response.status, headers: head })}\n`), false);
        if (response.body) {
          const reader = response.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done || aborted) {
              break;
            }
            await queue(value, false);
          }
        }
      }
      await chain;
      await finish();
    } catch (e) {
      // The client has the status already; a cut-short body is what it sees.
    }
    if (!aborted) {
      controller.close();
    }
  })();

  const out = new Headers(corsHeaders(origin));
  out.set('Content-Type', 'text/plain; charset=x-user-defined');
  out.set('X-Relay-Deferred', '1');
  out.set('Cache-Control', 'no-store');
  out.set('CDN-Cache-Control', 'no-store');
  out.set('Vercel-CDN-Cache-Control', 'no-store');
  if (zlib) {
    out.set('Content-Encoding', 'gzip');
  }
  return new Response(stream, { status: 200, headers: out });
}

// Cloudflare Workers entry point. Set the ALLOWED_ORIGINS variable (comma
// separated) to restrict which sites may use the relay.
export default {
  async fetch(request, env) {
    const origins = ((env && env.ALLOWED_ORIGINS) || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return handleRelay(request, origins);
  },
};
