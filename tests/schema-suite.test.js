// Runs the official JSON Schema Test Suite (json-schema-org/JSON-Schema-Test-Suite) against
// validateSchema, for draft 2020-12 and draft-07. The suite is a dev-only fixture: it is not
// committed; `npm run schema-suite` (or the GitHub Actions workflow) downloads a pinned
// commit into test-data/schema-suite/. Without it, these tests are skipped.
// Run with: node --test

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../assets/js/json-tools.js');

const SUITE = path.join(__dirname, '..', 'test-data', 'schema-suite', 'validation', 'tests');
const HAVE_SUITE = fs.existsSync(SUITE);

// Test files left out on purpose, with the reason (shown in the report).
const SKIP_FILES = {
  'vocabulary.json': 'custom meta-schemas with $vocabulary are not supported (needs the official meta-schemas, which are not bundled)'
};
// Single test cases left out on purpose.
const SKIP_CASES = {
  'format-hostname: validation of A-label (punycode) host names': 'IDNA2008 rules for punycode (A-label) host names are not checked'
};
// Files for drafts and keywords before draft-06 (id, disallow, extends...): not run.
const LEGACY = /^(disallow|extends|id-legacy|anchor-legacy|ref-legacy|recursiveRef|infinite-loop-detection-legacy|format-color|format-host-name|format-ip-address)\.json$/;
// Formats this validator checks when asked to.
const FORMATS = new Set(['date-time', 'date', 'time', 'email', 'uri', 'uuid', 'ipv4', 'ipv6', 'hostname', 'regex']);
const REFERS_TO_META = /json-schema\.org\/draft/;

// From the suite's README: does a test case apply to a release?
function isCompatible(compatibility, version) {
  if (!compatibility) return true;
  let ok = true;
  for (const c of compatibility.split(',')) {
    const m = /^(<=|=)?(\d+)$/.exec(c.trim());
    const op = m[1] || '', v = +m[2];
    ok = op === '<=' ? version <= v : op === '=' ? version === v : version >= v;
    if (version <= v) break;
  }
  return ok;
}

function runDraft(name, version, draft) {
  const report = new Map(), skipped = [], failures = [];
  for (const file of fs.readdirSync(SUITE).filter(f => f.endsWith('.json')).sort()) {
    const data = JSON.parse(fs.readFileSync(path.join(SUITE, file), 'utf8'));
    const cases = Array.isArray(data) ? data : data.tests;
    const keyword = file.replace(/\.json$/, '');
    for (const c of cases) {
      if (!isCompatible(c.compatibility, version)) continue;
      if (LEGACY.test(file)) continue;
      const row = report.get(keyword) || { pass: 0, total: 0, skipped: 0 };
      report.set(keyword, row);
      let reason = SKIP_FILES[file] || SKIP_CASES[keyword + ': ' + c.description] || null;
      const tags = c.tags || [];
      const formatOn = tags.includes('format-assertion');
      if (!reason && formatOn && typeof c.schema === 'object' && c.schema && c.schema.format && !FORMATS.has(c.schema.format)) reason = 'format "' + c.schema.format + '" is not checked';
      if (!reason && REFERS_TO_META.test(JSON.stringify(c.schema)) && /\$ref|\$schema|\$dynamicRef/.test(JSON.stringify(c.schema)) &&
        T.validateSchema(null, c.schema, { draft, schemas: c.externalSchemas }).schemaError) {
        reason = 'refers to an official meta-schema, which is not bundled (nothing is downloaded)';
      }
      if (reason) {
        row.skipped += c.tests.length;
        skipped.push(`${keyword}: ${c.description} (${c.tests.length}) - ${reason}`);
        continue;
      }
      for (const t of c.tests) {
        row.total++;
        let r;
        try { r = T.validateSchema(t.data, c.schema, { draft, formats: formatOn, schemas: c.externalSchemas }); }
        catch (e) { r = { error: e.message }; }
        if (r.valid === t.valid) row.pass++;
        else failures.push(`${keyword}: ${c.description} / ${t.description}: expected ${t.valid}, got ${r.schemaError ? 'schema error: ' + r.schemaError : r.error || r.valid}`);
      }
    }
  }
  return { report, skipped, failures };
}

describe('JSON Schema Test Suite', { skip: HAVE_SUITE ? false : 'test-data/schema-suite is missing: run `npm run schema-suite` to download it' }, () => {
  for (const [name, version, draft] of [['draft 2020-12', 2020, '2020-12'], ['draft-07', 7, '07']]) {
    test(name, t => {
      const { report, skipped, failures } = runDraft(name, version, draft);
      let pass = 0, total = 0, skip = 0;
      const lines = [];
      for (const [kw, r] of report) {
        pass += r.pass; total += r.total; skip += r.skipped;
        lines.push(`${kw.padEnd(32)} ${String(r.pass).padStart(4)}/${String(r.total).padEnd(4)} ${r.total ? (100 * r.pass / r.total).toFixed(1).padStart(5) + '%' : '    -'}${r.skipped ? '  (' + r.skipped + ' skipped)' : ''}`);
      }
      t.diagnostic(`${name}: ${pass}/${total} passed (${(100 * pass / total).toFixed(1)}%), ${skip} skipped\n` + lines.join('\n') +
        (skipped.length ? '\nSkipped on purpose:\n  ' + skipped.join('\n  ') : ''));
      if (process.env.SCHEMA_SUITE_VERBOSE) console.log(lines.join('\n') + '\n' + failures.join('\n'));
      assert.deepEqual(failures, []);
    });
  }
});
