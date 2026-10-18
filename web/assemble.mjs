#!/usr/bin/env node
// Assembles the Arnis web app into web/dist.
//
//   node web/assemble.mjs            after web/build.sh has built the engine
//
// The desktop GUI in src/gui is copied unchanged; the web layer from web/app
// is added on top, and index.html gets the PWA tags and the bridge scripts.
// Keeping the GUI files untouched is what lets this fork follow upstream.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('.', import.meta.url));
const repo = join(web, '..');
const gui = join(repo, 'src', 'gui');
const app = join(web, 'app');
const dist = join(web, 'dist');

function fail(message) {
  console.error(`assemble: ${message}`);
  process.exit(1);
}

for (const file of ['arnis.js', 'arnis.wasm']) {
  if (!existsSync(join(app, 'engine', file))) {
    fail(`web/app/engine/${file} is missing; run web/build.sh first.`);
  }
}

// --- Copy ------------------------------------------------------------------

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(gui, dist, {
  recursive: true,
  filter: (src) => !src.endsWith('.desktop'),
});
cpSync(app, dist, { recursive: true });
// GitHub Pages: serve files as they are, without Jekyll.
writeFileSync(join(dist, '.nojekyll'), '');

// The GUI's dark theme is the one it is designed around; its light fallback
// leaves white icons and text on white. Phones default to light mode far more
// often than desktops, so the web build always uses the dark theme.
const stylesPath = join(dist, 'css', 'styles.css');
const styles = readFileSync(stylesPath, 'utf8');
writeFileSync(stylesPath, styles.replaceAll('@media (prefers-color-scheme: dark)', '@media all'));

// --- Build information ------------------------------------------------------

const cargo = readFileSync(join(repo, 'Cargo.toml'), 'utf8');
const version = (cargo.match(/^version\s*=\s*"([^"]+)"/m) || [])[1] || '0.0.0';
let commit = 'unknown';
try {
  commit = execSync('git rev-parse --short=7 HEAD', { cwd: repo }).toString().trim();
} catch {
  // Not a git checkout.
}
const buildId = `${version}-${commit}-${Date.now().toString(36)}`;

writeFileSync(
  join(dist, 'pwa', 'build-info.js'),
  `self.ARNIS_BUILD = ${JSON.stringify({ version, commit, buildId })};\n`,
);

// --- index.html -------------------------------------------------------------

const indexPath = join(dist, 'index.html');
let index = readFileSync(indexPath, 'utf8');

function insertOnce(html, anchor, addition, where = 'before') {
  const at = html.indexOf(anchor);
  if (at < 0) {
    fail(`index.html no longer contains ${JSON.stringify(anchor)}; update web/assemble.mjs.`);
  }
  return where === 'before'
    ? html.slice(0, at) + addition + html.slice(at)
    : html.slice(0, at + anchor.length) + addition + html.slice(at + anchor.length);
}

index = index.replace(
  /<meta name="viewport"[^>]*>/,
  '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />',
);

index = insertOnce(
  index,
  '<meta charset="UTF-8" />',
  `
  <!-- Arnis web app: PWA metadata (added by web/assemble.mjs) -->
  <link rel="manifest" href="./manifest.webmanifest" />
  <meta name="theme-color" content="#333333" />
  <meta name="description" content="Generate any real-world location as a Minecraft world, right in your browser." />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="apple-mobile-web-app-title" content="Arnis" />
  <link rel="icon" type="image/png" sizes="32x32" href="./icons/favicon-32.png" />
  <link rel="apple-touch-icon" href="./icons/apple-touch-icon.png" />`,
  'after',
);

index = insertOnce(
  index,
  '<script src="./js/logging.js"></script>',
  `<!-- Arnis web app: the engine bridge must exist before the GUI's scripts. -->
  <script src="./config.js"></script>
  <script src="./pwa/build-info.js"></script>
  <script src="./pwa/coi.js"></script>
  <script src="./pwa/zip.js"></script>
  <script src="./pwa/bridge.js"></script>
  `,
);

index = insertOnce(
  index,
  '<link rel="stylesheet" href="./css/preview3d.css" />',
  '\n  <link rel="stylesheet" href="./pwa/web.css" />',
  'after',
);

writeFileSync(indexPath, index);

// --- Service worker ------------------------------------------------------------

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...walk(path));
    } else {
      out.push(path);
    }
  }
  return out;
}

// The shell is cached when the worker installs; the engine (tens of MB) is
// cached on first use instead, so installing the worker stays quick.
const shell = walk(dist)
  .map((path) => relative(dist, path).split(sep).join('/'))
  .filter((path) => !path.startsWith('engine/') && path !== 'sw.js' && !path.startsWith('.'))
  .map((path) => `./${path}`);
shell.unshift('./');

const workerPath = join(dist, 'engine-worker.js');
writeFileSync(workerPath, readFileSync(workerPath, 'utf8').replace('__ARNIS_BUILD__', buildId));

const swPath = join(dist, 'sw.js');
let sw = readFileSync(swPath, 'utf8');
sw = sw.replace('__ARNIS_VERSION__', buildId);
sw = `self.__ARNIS_PRECACHE = ${JSON.stringify(shell)};\n${sw}`;
writeFileSync(swPath, sw);

const total = walk(dist).reduce((sum, path) => sum + statSync(path).size, 0);
console.log(`Assembled web/dist (${(total / 1048576).toFixed(1)} MB, build ${buildId}).`);
