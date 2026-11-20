// Makes the README images in docs/ with headless Chrome or Edge (dev only; the files are
// committed, and they are not part of the app, so the service worker does not keep them):
//
//   docs/screenshot-light.png, docs/screenshot-dark.png   the page in each theme
//   docs/demo.gif   paste, Format, Tree view, copy a path, search
//
//   node scripts/make-readme-media.mjs     (or: npm run readme-media)

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchChrome, wait } from './lib/chrome.mjs';
import { encodeGif } from './lib/gif.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const docs = join(root, 'docs');
const PAGE = pathToFileURL(join(root, 'index.html')).href;
const THEME_KEY = 'json-formatter-theme';

const ORDER = '{"order":{"id":"ORD-20481","placedAt":"2026-11-04T09:42:17Z","status":"shipped","customer":{"name":"Amina Rauf",' +
  '"email":"amina@example.com","vip":true},"items":[{"sku":"KB-104","name":"Mechanical keyboard","qty":1,"price":89.5},' +
  '{"sku":"MS-220","name":"Wireless mouse","qty":2,"price":24.99}],"total":139.48,"giftNote":null}}';

const chrome = await launchChrome();
const { send, evaluate } = chrome;
mkdirSync(docs, { recursive: true });

async function open(theme, width, height, scale) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
  await chrome.navigate(PAGE);
  // A clean start: no saved settings except the theme.
  await evaluate(`localStorage.clear(), localStorage.setItem('${THEME_KEY}', '${theme}'), true`);
  await chrome.navigate(PAGE);
  await evaluate('document.fonts.ready.then(() => true)');
  await wait(600);
}

try {
  // ---- Screenshots in both themes ----
  for (const theme of ['light', 'dark']) {
    await open(theme, 1200, 760, 2);
    const png = await chrome.screenshot();
    writeFileSync(join(docs, `screenshot-${theme}.png`), png);
    console.log(`docs/screenshot-${theme}.png`);
  }

  // ---- The demo GIF ----
  const W = 1280, H = 800, frames = [];
  // Reduced motion: no transitions, so every frame shows a finished state.
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await open('light', W, H, 1);
  await send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }).catch(() => {});
  await evaluate(`document.getElementById('btnClear').click(), true`);
  // A pointer drawn on the page (screenshots don't show the real one), and a ring for clicks.
  await evaluate(`(() => {
    const c = document.createElement('div');
    c.id = 'demoCursor';
    c.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;pointer-events:none;width:22px;height:26px';
    c.innerHTML = '<svg width="22" height="26" viewBox="0 0 22 26"><path d="M3 2v18l4.6-4.3 3.2 7.1 3.1-1.4-3.1-6.9H17z" fill="#1f1f1f" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    const r = document.createElement('div');
    r.id = 'demoRing';
    r.style.cssText = 'position:fixed;left:0;top:0;z-index:99998;pointer-events:none;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;border:2px solid #1f1f1f;background:rgba(31,31,31,.12);display:none';
    document.body.append(r, c);
    return true;
  })()`);
  let pos = { x: 900, y: 420 };
  const place = (x, y, ring) => evaluate(`(() => {
    document.getElementById('demoCursor').style.transform = 'translate(${x - 3}px, ${y - 2}px)';
    const r = document.getElementById('demoRing');
    r.style.display = ${ring ? "'block'" : "'none'"};
    r.style.left = '${x}px'; r.style.top = '${y}px';
    return true;
  })()`);
  const frame = async delay => { frames.push({ png: await chrome.screenshot(), delay }); };
  const centre = async selector => JSON.parse(await evaluate(`(() => {
    const el = ${selector};
    const b = el.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(b.left + Math.min(b.width / 2, 40)), y: Math.round(b.top + b.height / 2) });
  })()`));
  async function moveTo(target) {
    const steps = 7;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;   // ease in and out
      await place(Math.round(pos.x + (target.x - pos.x) * e), Math.round(pos.y + (target.y - pos.y) * e));
      await frame(40);
    }
    pos = target;
  }
  async function click(selector, after = 350) {
    const p = await centre(selector);
    await moveTo(p);
    await place(p.x, p.y, true);
    await frame(120);
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await wait(after);
    await place(p.x, p.y, false);
  }
  const typeText = async (text, each) => {
    for (const ch of text) { await send('Input.insertText', { text: ch }); await wait(60); await frame(each); }
  };
  const byId = id => `document.getElementById('${id}')`;

  await place(pos.x, pos.y);
  await frame(900);
  // 1. Paste minified JSON into the input.
  await click(`document.querySelector('#input')`, 100);
  await send('Input.insertText', { text: ORDER });
  // Back to the start of the line (as if Home was pressed), so the start of the JSON shows.
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
  await wait(700);
  await frame(1300);
  // 2. Format.
  await click(byId('btnFormat'), 500);
  await frame(1500);
  // 3. Tree view.
  await click(byId('btnViewTree'), 500);
  await frame(900);
  await click(byId('btnTreeExpand'), 400);
  await frame(1000);
  // 4. Click a key to copy its path.
  await click(`[...document.querySelectorAll('.tree-key')].find(k => k.textContent.includes('email'))`, 500);
  await frame(1800);
  // 5. Search.
  await click(byId('btnSearch'), 300);
  await frame(300);
  await typeText('amina', 140);
  await wait(400);
  await frame(2600);

  const gif = encodeGif(W, H, frames);
  writeFileSync(join(docs, 'demo.gif'), gif);
  console.log(`docs/demo.gif (${frames.length} frames, ${(gif.length / 1048576).toFixed(2)} MB)`);
} finally {
  await chrome.close();
}
