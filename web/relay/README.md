# Arnis CORS relay

Some data sources Arnis reads don't send CORS headers, so a web page can't read
them directly:

| Host | Data | Without the relay |
| --- | --- | --- |
| `esa-worldcover.s3.eu-central-1.amazonaws.com` | ESA WorldCover land cover | Ground uses default blocks; water and land types come from OpenStreetMap only |
| `dataforgood-fb-data.s3.amazonaws.com` | Meta canopy heights | The "canopy height" option has no effect |
| `3dmr.eu`, `commons.wikimedia.org` | 3D landmark models | Landmarks fall back to regular buildings |
| `api.arnismc.com` | OpenStreetMap data (Arnis's Overpass server) | **No buildings or roads at all** |
| `tiles.arnisproject.com` | OpenStreetMap data (Arnis tile archive) | Behind Cloudflare bot protection, which also blocks the relay; the generator falls back to Overpass automatically |

The relay fetches from those hosts only, adds CORS headers and passes the
response through. Generation itself still runs in each visitor's browser. The
engine always tries a host directly first and uses the relay only when that
fails, so hosts that allow browsers never go through it.

This fork's relay runs at `https://arnis-relay.vercel.app/api/relay?url=`
(Vercel project `arnis-relay`), limited to requests from
`https://skilles.github.io`.

## Deploy on Cloudflare Workers (free tier is plenty)

```sh
cd web/relay
npx wrangler deploy
```

Then set `corsRelay` in `web/app/config.js` to
`https://arnis-relay.<your-subdomain>.workers.dev/?url=` and redeploy the site.

## Deploy on Vercel

Import this folder (`web/relay`) as a Vercel project, or run `npx vercel deploy`
from it. Set `corsRelay` to `https://<project>.vercel.app/api/relay?url=`.

It runs as a regular (Node.js) Vercel Function with up to five minutes per
request (`vercel.json`). An Edge function would be cut off after 25 seconds
without a first byte, which slow Overpass queries exceed.

## Limit who can use it

Set `ALLOWED_ORIGINS` (Cloudflare: in `wrangler.toml` or the dashboard;
Vercel: an environment variable) to your site, for example
`https://skilles.github.io`. Other sites are then refused.
