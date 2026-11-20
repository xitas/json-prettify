// Checks that the service worker's list of files (sw.js) matches the files as they are now,
// so a change can't be published without a new cache version. Run with: node --test
// When this fails: run `npm run build-sw` and commit sw.js with the change.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const build = () => import('../scripts/build-sw.mjs');

test('sw.js lists every app file with its current hash (run `npm run build-sw` if not)', async () => {
  const { filesBlock, currentBlock } = await build();
  assert.equal(currentBlock(ROOT), filesBlock(ROOT), 'sw.js is out of date: run `npm run build-sw` and commit sw.js');
});

test('everything the page loads is in the list: scripts, styles, manifest and icons', async () => {
  const { appFiles } = await build();
  const files = new Set(appFiles(ROOT));
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"#:]+)"/g)].map(m => m[1]);
  assert.ok(refs.length >= 8, refs.join());
  for (const ref of refs) assert.ok(files.has(ref), `${ref} is loaded by index.html but not kept for offline use`);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
  for (const icon of manifest.icons) assert.ok(files.has(icon.src), icon.src);
  // Relative, case-correct paths (GitHub Pages serves the site under /json-prettify/).
  for (const ref of refs) {
    assert.ok(!ref.startsWith('/'), `${ref} should be relative`);
    assert.ok(fs.existsSync(path.join(ROOT, ref)), `${ref} does not exist (check upper and lower case)`);
  }
});

test('the social preview and the README images are not kept for offline use', async () => {
  const { appFiles } = await build();
  const files = appFiles(ROOT);
  assert.ok(!files.includes('og-image.png'));
  assert.ok(!files.some(f => f.startsWith('docs/')), files.join());
});

test('a changed file changes the hash and the cache version', async () => {
  const { filesBlock } = await build();
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'sw-test-'));
  try {
    for (const dir of ['assets/css', 'assets/js', 'assets/icons']) fs.mkdirSync(path.join(tmp, dir), { recursive: true });
    for (const f of ['index.html', 'manifest.webmanifest', 'sw.js', 'assets/css/style.css', 'assets/js/app.js', 'assets/icons/icon-192.png']) {
      fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
    }
    const before = filesBlock(tmp);
    // Windows line endings alone do not change anything.
    fs.writeFileSync(path.join(tmp, 'assets/js/app.js'), fs.readFileSync(path.join(tmp, 'assets/js/app.js'), 'utf8').replace(/\r?\n/g, '\r\n'));
    assert.equal(filesBlock(tmp), before);
    fs.appendFileSync(path.join(tmp, 'assets/js/app.js'), '\n// changed\n');
    const after = filesBlock(tmp);
    assert.notEqual(after, before);
    assert.notEqual(/VERSION = "(\w+)"/.exec(after)[1], /VERSION = "(\w+)"/.exec(before)[1]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
