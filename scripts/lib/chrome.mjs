// Starts headless Chrome (or Edge) and talks to it over the DevTools protocol. Used by the
// dev scripts that make images (icons, the social preview, the README screenshots). Set
// CHROME_PATH if Chrome or Edge is not in a usual place.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
].filter(Boolean);

export const wait = ms => new Promise(r => setTimeout(r, ms));

// Returns { send(method, params), evaluate(expression), navigate(url), screenshot(clip?), close() }.
export async function launchChrome() {
  const browser = CANDIDATES.find(p => existsSync(p));
  if (!browser) throw new Error('Chrome or Edge not found: set CHROME_PATH');
  const profile = mkdtempSync(join(tmpdir(), 'json-prettify-chrome-'));
  const port = 9300 + Math.floor(Math.random() * 500);
  const proc = spawn(browser, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page'); } catch {}
    if (!target) await wait(200);
  }
  if (!target) { proc.kill(); throw new Error('Chrome did not start'); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0;
  const pending = new Map(), loadWaiters = [];
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Page.loadEventFired') loadWaiters.splice(0).forEach(r => r());
    if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, m => m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve(m.result));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  await send('Page.enable');
  await send('Runtime.enable');
  return {
    send,
    async evaluate(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    async navigate(url) {
      const loaded = new Promise(r => loadWaiters.push(r));
      await send('Page.navigate', { url });
      await Promise.race([loaded, wait(10000)]);
    },
    async screenshot(clip) {
      const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { scale: 1, ...clip } } : {}) });
      return Buffer.from(r.data, 'base64');
    },
    async close() {
      ws.close();
      proc.kill();
      await wait(300);
      try { rmSync(profile, { recursive: true, force: true }); } catch {}
    }
  };
}

// Renders HTML into PNG images. pages: [{ html, width, height, transparent }]; returns Buffers.
export async function renderPngs(pages) {
  const chrome = await launchChrome();
  try {
    const out = [];
    for (const p of pages) {
      await chrome.send('Emulation.setDefaultBackgroundColorOverride', p.transparent ? { color: { r: 0, g: 0, b: 0, a: 0 } } : {});
      await chrome.send('Emulation.setDeviceMetricsOverride', { width: p.width, height: p.height, deviceScaleFactor: 1, mobile: false });
      await chrome.navigate('data:text/html;charset=utf-8;base64,' +Buffer.from(p.html).toString('base64'));
      await chrome.evaluate('document.fonts.ready.then(() => true)');
      await wait(100);
      out.push(await chrome.screenshot({ x: 0, y: 0, width: p.width, height: p.height }));
    }
    return out;
  } finally {
    await chrome.close();
  }
}
