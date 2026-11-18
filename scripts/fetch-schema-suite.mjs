// Downloads the official JSON Schema Test Suite (a pinned commit) into
// test-data/schema-suite/, for tests/schema-suite.test.js. Dev only: the suite is not
// committed (the folder is in .gitignore) and the page never uses it.
//
//   node scripts/fetch-schema-suite.mjs      (or: npm run schema-suite)
//
// Needs git. Does nothing when the pinned commit is already there.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'https://github.com/json-schema-org/JSON-Schema-Test-Suite';
const COMMIT = 'e2a68a15cd490750fd6b95e604e4054d7d978d1f';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'test-data', 'schema-suite');
const stamp = join(dir, '.commit');

if (existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === COMMIT) {
  console.log('JSON Schema Test Suite already at ' + COMMIT.slice(0, 10));
  process.exit(0);
}
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const git = args => execFileSync('git', args, { cwd: dir, stdio: 'inherit' });
git(['init', '-q']);
git(['fetch', '-q', '--depth', '1', REPO, COMMIT]);
git(['checkout', '-q', 'FETCH_HEAD']);
rmSync(join(dir, '.git'), { recursive: true, force: true });
execFileSync(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(stamp)}, ${JSON.stringify(COMMIT + '\n')})`]);
console.log('JSON Schema Test Suite ' + COMMIT.slice(0, 10) + ' in test-data/schema-suite/');
