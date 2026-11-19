// Makes the app icons (PNG) from the logo (the same SVG artwork as the page header), with
// headless Chrome or Edge. Dev only; the PNG files are committed.
//
//   node scripts/make-icons.mjs        (or: npm run icons)
//
// Set CHROME_PATH if Chrome or Edge is not in a usual place. Writes assets/icons/:
//   icon-192.png, icon-512.png   the logo: a rounded dark square with the braces cut out
//   icon-maskable-512.png        full-bleed square with the braces in the middle (Android
//                                masks it to a circle or squircle; the braces stay inside the
//                                safe zone, the middle 80%)
//   apple-touch-icon.png         180 px, full-bleed (iOS rounds the corners itself)

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'assets', 'icons');

// The logo (see the header in index.html): braces and a dot on a rounded square, 32 x 32.
const BRACES = 'M13 9h-.5A2.5 2.5 0 0 0 10 11.5v2A2.5 2.5 0 0 1 7.5 16 2.5 2.5 0 0 1 10 18.5v2a2.5 2.5 0 0 0 2.5 2.5h.5M19 9h.5a2.5 2.5 0 0 1 2.5 2.5v2a2.5 2.5 0 0 0 2.5 2.5 2.5 2.5 0 0 0-2.5 2.5v2a2.5 2.5 0 0 1-2.5 2.5H19';
const INK = '#1f1f1f', PAPER = '#ffffff';
function svg(size, fullBleed) {
  const square = fullBleed ? `<rect width="32" height="32" fill="${INK}"/>` : `<rect x="1" y="1" width="30" height="30" rx="8" fill="${INK}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" style="display:block" width="${size}" height="${size}" viewBox="0 0 32 32">${square}` +
    `<path d="${BRACES}" fill="none" stroke="${PAPER}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<circle cx="16" cy="16" r="1.75" fill="${PAPER}"/></svg>`;
}
const ICONS = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
  ['apple-touch-icon.png', 180, true]
];

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
].filter(Boolean);
const browser = CANDIDATES.find(p => existsSync(p));
if (!browser) { console.error('Chrome or Edge not found: set CHROME_PATH'); process.exit(1); }

const wait = ms => new Promise(r => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'json-prettify-icons-'));
const port = 9300 + Math.floor(Math.random() * 500);
const proc = spawn(browser, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
try {
  let targets;
  for (let i = 0; i < 100 && !targets; i++) {
    try { targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(t => t.type === 'page'); if (!targets.length) targets = null; } catch {}
    if (!targets) await wait(200);
  }
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable');
  await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  mkdirSync(outDir, { recursive: true });
  for (const [name, size, fullBleed] of ICONS) {
    await send('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: 1, mobile: false });
    const html = `<!doctype html><html><body style="margin:0;overflow:hidden;background:transparent">${svg(size, fullBleed)}</body></html>`;
    await send('Page.navigate', { url: 'data:text/html;base64,' + Buffer.from(html).toString('base64') });
    await wait(300);
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size, height: size, scale: 1 } });
    writeFileSync(join(outDir, name), Buffer.from(shot.result.data, 'base64'));
    console.log('assets/icons/' + name);
  }
  ws.close();
} finally {
  proc.kill();
  await wait(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
