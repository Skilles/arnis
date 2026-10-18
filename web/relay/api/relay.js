// Vercel Function entry point for the CORS relay (see ../README.md).
// Deployed from this folder, it answers at /api/relay?url=<encoded URL>.
//
// The Node.js runtime, not Edge: an Edge function must start answering within
// 25 seconds, and an Overpass query for a large area can take longer than
// that before its first byte. vercel.json allows up to five minutes.
import { handleRelay } from '../relay.js';

function allowedOrigins() {
  return (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function handle(request) {
  return handleRelay(request, allowedOrigins());
}

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const OPTIONS = handle;
