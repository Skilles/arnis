#!/usr/bin/env node
// Runs the relay locally for development: `node web/relay/dev-server.mjs [port]`
// (default 8787). Then use corsRelay: 'http://localhost:8787/?url=' in config.js.
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { handleRelay } from './relay.js';

const port = Number(process.argv[2] || 8787);

createServer(async (req, res) => {
  try {
    const body = ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : Readable.toWeb(req);
    const request = new Request(`http://localhost:${port}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body,
      duplex: 'half',
    });
    const response = await handleRelay(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body && req.method !== 'HEAD') {
      Readable.fromWeb(response.body).pipe(res);
    } else {
      res.end();
    }
  } catch (e) {
    res.writeHead(502, { 'Access-Control-Allow-Origin': '*' }).end(String(e));
  }
}).listen(port, () => console.log(`Arnis relay on http://localhost:${port}/?url=`));
