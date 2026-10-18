// Vercel Edge Function entry point for the CORS relay (see ../README.md).
// Deployed from this folder, it answers at /api/relay?url=<encoded URL>.
import { handleRelay } from '../relay.js';

export const config = { runtime: 'edge' };

export default function handler(request) {
  const origins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return handleRelay(request, origins);
}
