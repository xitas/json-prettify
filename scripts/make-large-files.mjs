// Writes large JSON files for trying the page with big inputs. They are made on demand and
// never committed (the folder is in .gitignore).
//
//   node scripts/make-large-files.mjs             1, 5, 20 and 50 MB
//   node scripts/make-large-files.mjs 2 100       other sizes, in MB
//
// Files go to test-data/large/: <size>mb.json (formatted with 2 spaces, like most saved
// JSON) and <size>mb.min.json (one line). The content is the same every time: records with
// strings (some with escapes and non-ASCII text), numbers, booleans, nulls, nested objects
// and arrays.

import { createWriteStream, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'test-data', 'large');
const sizes = process.argv.slice(2).map(Number).filter(n => n > 0);
const MB = 1024 * 1024;

const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'kappa', 'lambda', 'sigma', 'omega', 'north', 'south', 'river', 'stone'];
const CITIES = ['Lahore', 'Zürich', 'São Paulo', '東京', 'Kraków', 'Montréal', 'Cairo', 'Oslo'];

// A small seeded generator, so every run writes the same files.
function random(seed) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296;
}

function record(i, rnd) {
  const pick = list => list[Math.floor(rnd() * list.length)];
  return {
    id: i,
    uuid: (i * 2654435761 >>> 0).toString(16).padStart(8, '0') + '-' + (i % 9973).toString(16).padStart(4, '0'),
    name: pick(WORDS) + ' ' + pick(WORDS) + ' ' + i,
    active: rnd() < 0.7,
    score: Math.round(rnd() * 100000) / 100,
    created: new Date(Date.UTC(2020, 0, 1) + i * 86400).toISOString(),
    owner: rnd() < 0.15 ? null : { name: pick(WORDS), city: pick(CITIES), level: Math.floor(rnd() * 5) },
    tags: Array.from({ length: Math.floor(rnd() * 4) }, () => pick(WORDS)),
    note: rnd() < 0.2 ? 'Line one\nline "two" with a \\ backslash and a tab\t.' : '',
    history: Array.from({ length: Math.floor(rnd() * 3) }, (_, k) => ({ step: k, ok: rnd() < 0.5, value: Math.floor(rnd() * 1e6) }))
  };
}

// Streams records until the file reaches the size, then closes the array and object.
function write(path, bytes, indent) {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(path);
    out.on('error', reject);
    const rnd = random(bytes);
    const nl = indent ? '\n' : '', pad = indent ? '    ' : '';
    let written = 0, i = 0;
    const head = indent ? '{\n  "generated": "make-large-files",\n  "records": [\n' : '{"generated":"make-large-files","records":[';
    const tail = indent ? '\n  ]\n}\n' : ']}';
    out.write(head);
    written += Buffer.byteLength(head);
    (function more() {
      let ok = true;
      while (ok && written < bytes - tail.length - 200) {
        let s = JSON.stringify(record(i, rnd), null, indent);
        if (indent) s = pad + s.replace(/\n/g, '\n' + pad);
        s = (i ? ',' + nl : '') + s;
        written += Buffer.byteLength(s);
        i++;
        ok = out.write(s);
      }
      if (written < bytes - tail.length - 200) { out.once('drain', more); return; }
      out.end(tail, () => resolve({ records: i }));
    })();
  });
}

mkdirSync(outDir, { recursive: true });
for (const mb of sizes.length ? sizes : [1, 5, 20, 50]) {
  for (const [suffix, indent] of [['', 2], ['.min', 0]]) {
    const path = join(outDir, `${mb}mb${suffix}.json`);
    const t0 = Date.now();
    const { records } = await write(path, mb * MB, indent);
    console.log(`${path}  ${records} records  ${Date.now() - t0} ms`);
  }
}
