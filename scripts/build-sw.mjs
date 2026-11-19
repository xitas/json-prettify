// Writes the list of files the service worker keeps (sw.js), with a hash of each file's
// contents, and a cache version made from those hashes. Run it after changing any of the
// app's files:
//
//   node scripts/build-sw.mjs      (or: npm run build-sw)
//
// tests/sw.test.js fails when the list in sw.js is out of date, so a change can't be
// published without a new version (which would leave visitors on old files).

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const START = '// <files> written by scripts/build-sw.mjs; do not edit by hand';
const END = '// </files>';

// The app's own files: the page, the manifest, the styles, every script and every icon.
export function appFiles(root = ROOT) {
  const list = (dir, ext) => readdirSync(join(root, dir)).filter(f => f.endsWith(ext)).sort().map(f => dir + '/' + f);
  return ['index.html', 'manifest.webmanifest', 'assets/css/style.css', ...list('assets/js', '.js'), ...list('assets/icons', '.png')];
}

// Hash of a file's contents. Text files are hashed with \n line endings, so a checkout
// with Windows line endings gives the same hashes as the files on the server.
export function fileHash(root, file) {
  let data = readFileSync(join(root, file));
  if (!/\.png$/.test(file)) data = Buffer.from(data.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  return createHash('sha256').update(data).digest('hex').slice(0, 16);
}

export function filesBlock(root = ROOT) {
  const files = appFiles(root), hashes = {};
  for (const f of files) hashes[f] = fileHash(root, f);
  const version = createHash('sha256').update(files.map(f => f + ':' + hashes[f]).join('\n')).digest('hex').slice(0, 12);
  const lines = files.map((f, i) => `  ${JSON.stringify(f)}: ${JSON.stringify(hashes[f])}${i < files.length - 1 ? ',' : ''}`);
  return `${START}\nvar VERSION = ${JSON.stringify(version)};\nvar FILES = {\n${lines.join('\n')}\n};\n${END}`;
}

// The block as it is in sw.js now.
export function currentBlock(root = ROOT) {
  const sw = readFileSync(join(root, 'sw.js'), 'utf8').replace(/\r\n/g, '\n');
  const a = sw.indexOf(START), b = sw.indexOf(END);
  if (a < 0 || b < a) throw new Error('sw.js has no <files> block');
  return sw.slice(a, b + END.length);
}

export function writeBlock(root = ROOT) {
  const path = join(root, 'sw.js');
  const sw = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const next = sw.replace(currentBlock(root), filesBlock(root));
  writeFileSync(path, next);
  return next !== sw;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2] || ROOT;
  console.log(writeBlock(root) ? 'sw.js: new file list and version written' : 'sw.js: already up to date');
}
