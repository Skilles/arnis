#!/usr/bin/env node
// Serves a folder with the headers the Arnis web build needs, for local
// development: `node web/serve.mjs [dir] [port]` (defaults: web/dist, 8080).
//
// Cross-origin isolation (COOP + COEP) unlocks SharedArrayBuffer, which the
// multithreaded engine requires. GitHub Pages cannot send these headers, so
// there the service worker adds them; this server sends them directly.
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(process.argv[2] || join(here, 'dist'));
const port = Number(process.argv[3] || 8080);

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let path = normalize(join(root, decodeURIComponent(url.pathname)));
  if (!path.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if (statSync(path).isDirectory()) {
      path = join(path, 'index.html');
    }
    const size = statSync(path).size;
    res.writeHead(200, {
      'Content-Type': types[extname(path)] || 'application/octet-stream',
      'Content-Length': size,
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'no-cache',
    });
    createReadStream(path).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}).listen(port, () => {
  console.log(`Serving ${root} at http://localhost:${port}/`);
});
