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

const MAX_REDIRECTS = 5;

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type, Accept, If-None-Match, If-Modified-Since',
    'Access-Control-Expose-Headers': EXPOSED_RESPONSE_HEADERS,
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
  headers.set('User-Agent', 'Arnis-Web-Relay/1.0 (+https://github.com/louis-e/arnis)');

  const body = request.method === 'POST' ? await request.arrayBuffer() : undefined;

  // Redirects are followed by hand so that every hop is checked against the
  // allowlist (Wikimedia Commons redirects to upload.wikimedia.org).
  let response;
  for (let hop = 0; ; hop++) {
    if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
      return refuse(403, `Host not allowed: ${url.hostname}`, origin);
    }
    response = await fetch(url.toString(), {
      method: request.method,
      headers,
      body,
      redirect: 'manual',
    });
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
  // Successful whole-file responses from these hosts change rarely.
  if (response.status === 200 || response.status === 206) {
    out.set('Cache-Control', 'public, max-age=86400');
  }

  return new Response(response.body, { status: response.status, headers: out });
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
