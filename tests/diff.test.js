// Unit tests for comparing documents (diffJson and friends in assets/js/json-tools.js).
// Run with: node --test

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../assets/js/json-tools.js');

// ---------- a small JSON Patch (RFC 6902) applier, to check the generated patches ----------

function parsePointer(p) {
  if (p === '') return [];
  assert.equal(p.charAt(0), '/', 'pointer starts with /: ' + p);
  return p.slice(1).split('/').map(t => t.replace(/~1/g, '/').replace(/~0/g, '~'));
}
function setOwn(obj, k, v) { Object.defineProperty(obj, k, { value: v, writable: true, enumerable: true, configurable: true }); }
function container(doc, tokens) {
  let v = doc;
  for (const t of tokens) {
    if (Array.isArray(v)) { assert.match(t, /^(0|[1-9]\d*)$/, 'array index ' + t); v = v[+t]; }
    else { assert.ok(v !== null && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, t), 'path exists: ' + t); v = v[t]; }
  }
  return v;
}
function applyPatch(original, ops) {
  const box = { root: JSON.parse(JSON.stringify(original)) };
  const add = (path, value) => {
    const tokens = parsePointer(path);
    if (!tokens.length) { box.root = value; return; }
    const last = tokens.pop(), parent = container(box.root, tokens);
    if (Array.isArray(parent)) {
      const i = last === '-' ? parent.length : +last;
      assert.ok(i >= 0 && i <= parent.length, `add index ${i} in 0..${parent.length}`);
      parent.splice(i, 0, value);
    } else setOwn(parent, last, value);
  };
  const remove = path => {
    const tokens = parsePointer(path);
    assert.ok(tokens.length, 'cannot remove the root');
    const last = tokens.pop(), parent = container(box.root, tokens);
    let v;
    if (Array.isArray(parent)) { assert.ok(+last < parent.length, 'remove index in range'); v = parent.splice(+last, 1)[0]; }
    else { assert.ok(Object.prototype.hasOwnProperty.call(parent, last), 'remove key exists: ' + last); v = parent[last]; delete parent[last]; }
    return v;
  };
  for (const op of ops) {
    const value = op.value === undefined ? undefined : JSON.parse(JSON.stringify(op.value));
    if (op.op === 'add') add(op.path, value);
    else if (op.op === 'remove') remove(op.path);
    else if (op.op === 'replace') {
      const tokens = parsePointer(op.path);
      if (!tokens.length) box.root = value;
      else { container(box.root, tokens); remove(op.path); add(op.path, value); }
    } else if (op.op === 'move') add(op.path, remove(op.from));
    else assert.fail('unexpected op ' + op.op);
  }
  return box.root;
}
const same = (a, b) => T.canonicalJson(a) === T.canonicalJson(b);

// ---------- random documents ----------

function random(seed) {
  let s = seed >>> 0 || 1;
  const next = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296;
  return { next, int: n => Math.floor(next() * n), pick: l => l[Math.floor(next() * l.length)], chance: p => next() < p };
}
const KEYS = ['id', 'name', 'a b', '', 'kéy', 'q"k', '__proto__', 'constructor', '10', 'x/y', 'tilde~0', 'list', 'nested'];
const SCALARS = [0, 1, -1, 1.5, 1e21, '', 'text', '日本 😀', '5', 'true', true, false, null];
function value(r, depth) {
  const x = r.next();
  if (depth > 3 || x < 0.4) return r.pick(SCALARS);
  if (x < 0.55) return Array.from({ length: r.int(5) }, () => value(r, depth + 1));
  if (x < 0.7) return Array.from({ length: r.int(6) }, (_, k) => ({ id: r.int(8), v: value(r, depth + 2) }));
  const o = {};
  for (let i = r.int(5); i > 0; i--) setOwn(o, r.pick(KEYS), value(r, depth + 1));
  return o;
}
// A changed copy: values replaced, keys added and removed, array items inserted, removed,
// changed and moved.
function mutate(r, v, depth) {
  if (r.chance(0.08)) return value(r, depth);
  if (Array.isArray(v)) {
    let out = v.map(x => (r.chance(0.3) ? mutate(r, x, depth + 1) : x));
    if (r.chance(0.3) && out.length) out.splice(r.int(out.length), 1);
    if (r.chance(0.3)) out.splice(r.int(out.length + 1), 0, value(r, depth + 1));
    if (r.chance(0.2) && out.length > 1) { const [m] = out.splice(r.int(out.length), 1); out.splice(r.int(out.length + 1), 0, m); }
    return out;
  }
  if (v !== null && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) if (!r.chance(0.15)) setOwn(out, k, r.chance(0.3) ? mutate(r, v[k], depth + 1) : v[k]);
    if (r.chance(0.3)) setOwn(out, r.pick(KEYS), value(r, depth + 1));
    return out;
  }
  return r.chance(0.5) ? r.pick(SCALARS) : v;
}

const MODES = [
  { arrays: 'position' }, { arrays: 'smart' }, { arrays: 'smart', ignoreOrder: true },
  { arrays: 'key', key: 'id' }, { arrays: 'key', key: 'id', ignoreOrder: true }
];

// ---------- the key test: the patch turns the original into the changed document ----------

describe('diffJson: the JSON Patch gives exactly the changed document', () => {
  for (const mode of MODES) {
    test(`fuzz: 1,000 random pairs, ${JSON.stringify(mode)}`, () => {
      const r = random(17 + MODES.indexOf(mode));
      for (let round = 0; round < 1000; round++) {
        const a = value(r, 0), b = round % 10 === 0 ? value(r, 0) : mutate(r, a, 0);
        const d = T.diffJson(a, b, { ...mode, view: { indent: 2 } });
        const got = applyPatch(a, d.patch);
        assert.ok(same(got, b), `round ${round}\na: ${JSON.stringify(a)}\nb: ${JSON.stringify(b)}\npatch: ${JSON.stringify(d.patch)}\ngot: ${JSON.stringify(got)}`);
        assert.equal(d.equal, d.changes.length === 0);
        if (same(a, b) && !mode.ignoreOrder) assert.equal(d.changes.length, 0, 'equal data: no changes');
        // Both sides of the view line up, and every change has a row.
        const v = T.diffViewText(d.view, null, d.changes.length);
        assert.equal(v.left.split('\n').length, v.rows);
        assert.equal(v.right.split('\n').length, v.rows);
        assert.ok(Array.from(v.changeRow).every(x => x >= 0), 'every change is shown');
      }
    });
  }
});

// ---------- each kind of change ----------

describe('diffJson: kinds of changes', () => {
  const paths = d => d.changes.map(c => c.op + ' ' + T.formatPath(c.pathB || c.pathA, 'js'));

  test('identical documents, also with other key order and whitespace', () => {
    const d = T.runDiff('{"a": 1, "b": [1, 2]}', '{\n  "b": [1,2],\n  "a": 1\n}', {});
    assert.equal(d.status, 'ok');
    assert.equal(d.equal, true);
    assert.deepEqual(d.counts, { added: 0, removed: 0, changed: 0 });
    assert.deepEqual(d.diff.patch, []);
    assert.equal(T.diffSummary(d.counts), '0 added · 0 removed · 0 changed');
  });

  test('added, removed, changed value and changed type', () => {
    const d = T.diffJson({ keep: 1, gone: true, n: 5, s: '5' }, { keep: 1, n: 6, s: 5, extra: null });
    assert.deepEqual(paths(d), ['remove gone', 'change n', 'type s', 'add extra']);
    assert.deepEqual(d.counts, { added: 1, removed: 1, changed: 2 });
    assert.deepEqual(d.changes[2].before, '5');
    assert.deepEqual(d.changes[2].after, 5);
  });

  test('nested changes get full paths; objects and arrays are walked, not replaced', () => {
    const d = T.diffJson({ user: { name: 'A', tags: ['x', 'y'], addr: { city: 'K' } } },
      { user: { name: 'B', tags: ['x', 'z'], addr: { city: 'K', zip: '1' } } });
    assert.deepEqual(paths(d), ['change user.name', 'change user.tags[1]', 'add user.addr.zip']);
  });

  test('object versus array, and null, are type changes', () => {
    const d = T.diffJson({ a: {}, b: null, c: [1] }, { a: [], b: 0, c: { 0: 1 } });
    assert.deepEqual(d.changes.map(c => c.op), ['type', 'type', 'type']);
  });

  test('unicode and tricky keys', () => {
    const a = { 'a b': 1, '': 2, 'x/y': 3, 'tilde~': 4, 'été': '😀', __proto__: null };
    const a2 = JSON.parse('{"a b": 1, "": 2, "x/y": 3, "tilde~": 4, "été": "😀", "__proto__": {"p": 1}}');
    const b2 = JSON.parse('{"a b": 9, "": 2, "x/y": 8, "tilde~": 4, "été": "😁", "__proto__": {"p": 2}}');
    const d = T.diffJson(a2, b2);
    assert.deepEqual(d.changes.map(c => T.formatPath(c.pathA, 'pointer')), ['/a b', '/x~1y', '/été', '/__proto__/p']);
    assert.ok(same(applyPatch(a2, d.patch), b2));
    assert.ok(a);
  });

  test('the root itself can change', () => {
    const d = T.diffJson([1], 'x');
    assert.deepEqual(d.patch, [{ op: 'replace', path: '', value: 'x' }]);
    assert.equal(d.changes[0].op, 'type');
  });
});

describe('diffJson: matching array items', () => {
  const ops = d => d.changes.map(c => c.op + ' ' + (c.pathA ? T.formatPath(c.pathA, 'js') : '-') + '>' + (c.pathB ? T.formatPath(c.pathB, 'js') : '-'));

  test('by position: items are compared index by index', () => {
    const d = T.diffJson([1, 2, 3], [0, 1, 2, 3], { arrays: 'position' });
    assert.deepEqual(ops(d), ['change [0]>[0]', 'change [1]>[1]', 'change [2]>[2]', 'add ->[3]']);
  });

  test('smart: an inserted item is one addition, and a changed item stays a change', () => {
    let d = T.diffJson([1, 2, 3], [0, 1, 2, 3], { arrays: 'smart' });
    assert.deepEqual(ops(d), ['add ->[0]']);
    d = T.diffJson(['a', 'b', 'c', 'd'], ['a', 'c', 'X', 'd'], { arrays: 'smart' });
    assert.deepEqual(ops(d), ['remove [1]>-', 'add ->[2]']);
    d = T.diffJson([{ id: 1, v: 'a' }, { id: 2, v: 'b' }], [{ id: 1, v: 'a' }, { id: 2, v: 'B' }], { arrays: 'smart' });
    assert.deepEqual(ops(d), ['change [1].v>[1].v']);
  });

  test('smart: left-over items are paired with the most alike item, not just the next one', () => {
    const a = [{ sku: 'KB', qty: 1 }, { sku: 'MS', qty: 2 }], b = [{ sku: 'KB', qty: 1 }, { sku: 'HD', qty: 1 }, { sku: 'MS', qty: 3 }];
    const d = T.diffJson(a, b, { arrays: 'smart' });
    assert.deepEqual(ops(d), ['add ->[1]', 'change [1].qty>[2].qty']);
    assert.ok(same(applyPatch(a, d.patch), b));
  });

  test('smart: too many differences falls back to position, with a note', () => {
    const a = Array.from({ length: 300 }, (_, i) => i), b = Array.from({ length: 300 }, (_, i) => i + 1000);
    const d = T.diffJson(a, b, { arrays: 'smart', smartLimit: 50 });
    assert.equal(d.changes.length, 300);
    assert.ok(d.changes.every(c => c.op === 'change'));
    assert.match(d.notes[0], /too many differences.*by position/);
  });

  test('by key: items are matched by the key value wherever they are', () => {
    const a = [{ id: 1, n: 'a' }, { id: 2, n: 'b' }, { id: 3, n: 'c' }];
    const b = [{ id: 3, n: 'c' }, { id: 1, n: 'A' }, { id: 4, n: 'd' }];
    let d = T.diffJson(a, b, { arrays: 'key', key: 'id', ignoreOrder: true });
    assert.deepEqual(ops(d), ['change [0].n>[1].n', 'add ->[2]', 'remove [1]>-']);
    assert.ok(d.patch.some(p => p.op === 'move'), 'the reordering is in the patch');
    assert.ok(same(applyPatch(a, d.patch), b));
    // Keeping order: the item that moved is removed and added.
    d = T.diffJson(a, b, { arrays: 'key', key: 'id' });
    assert.ok(ops(d).includes('remove [2]>-') && ops(d).includes('add ->[0]'), ops(d).join());
    assert.ok(same(applyPatch(a, d.patch), b));
  });

  test('by key: arrays whose items lack the key are compared smartly, with a note', () => {
    const d = T.diffJson({ tags: ['a', 'b'], rows: [{ id: 1 }] }, { tags: ['b'], rows: [{ id: 1 }] }, { arrays: 'key', key: 'id' });
    assert.deepEqual(ops(d), ['remove tags[0]>-']);
    assert.match(d.notes[0], /without "id"/);
  });

  test('smart with item order ignored: moved items are not changes', () => {
    const d = T.diffJson([1, 2, 3], [3, 1, 2], { arrays: 'smart', ignoreOrder: true });
    assert.equal(d.changes.length, 0);
    assert.ok(same(applyPatch([1, 2, 3], d.patch), [3, 1, 2]));
  });
});

describe('numbers', () => {
  test('1 and 1.0 are equal by default, and different when asked', () => {
    assert.equal(T.runDiff('{"n": 1, "m": [2]}', '{"n": 1.0, "m": [2.00]}', {}).equal, true);
    const d = T.runDiff('{"n": 1, "m": [2], "k": 3}', '{"n": 1.0, "m": [2.00], "k": 3}', { numbersEqual: false });
    assert.deepEqual(d.list.map(c => c.op + ' ' + T.formatPath(c.pathB, 'js')), ['change n', 'change m[0]']);
    assert.match(d.view.left, /"n": 1,/);
    assert.match(d.view.right, /"n": 1\.0,/);
  });
});

describe('textDiff', () => {
  test('character-level changes', () => {
    assert.deepEqual(T.textDiff('kitten', 'sitting'), [
      { op: '-', text: 'k' }, { op: '+', text: 's' }, { op: '=', text: 'itt' }, { op: '-', text: 'e' }, { op: '+', text: 'i' },
      { op: '=', text: 'n' }, { op: '+', text: 'g' }]);
    assert.deepEqual(T.textDiff('', 'a'), [{ op: '+', text: 'a' }]);
    assert.deepEqual(T.textDiff('same', 'same'), [{ op: '=', text: 'same' }]);
  });
  test('never splits a surrogate pair, and joining the pieces gives both strings back', () => {
    const r = random(5), chars = ['a', 'b', '😀', '😁', 'é', ' '];
    for (let i = 0; i < 300; i++) {
      const a = Array.from({ length: r.int(12) }, () => r.pick(chars)).join(''), b = Array.from({ length: r.int(12) }, () => r.pick(chars)).join('');
      const segs = T.textDiff(a, b);
      assert.equal(segs.filter(s => s.op !== '+').map(s => s.text).join(''), a);
      assert.equal(segs.filter(s => s.op !== '-').map(s => s.text).join(''), b);
      for (const s of segs) assert.ok(!/^[\udc00-\udfff]|[\ud800-\udbff]$/.test(s.text), JSON.stringify(s.text));
    }
  });
  test('long strings come back as one removal and one insertion', () => {
    assert.deepEqual(T.textDiff('a'.repeat(30000), 'b').map(s => s.op), ['-', '+']);
  });
});

describe('lcsPairs', () => {
  test('matches a longest common subsequence', () => {
    const r = random(9);
    for (let i = 0; i < 300; i++) {
      const A = Array.from({ length: r.int(15) }, () => r.int(4)), B = Array.from({ length: r.int(15) }, () => r.int(4));
      const pairs = T.lcsPairs(A, B, 1000);
      // Brute-force LCS length
      const dp = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0));
      for (let x = A.length - 1; x >= 0; x--) for (let y = B.length - 1; y >= 0; y--) dp[x][y] = A[x] === B[y] ? dp[x + 1][y + 1] + 1 : Math.max(dp[x + 1][y], dp[x][y + 1]);
      assert.equal(pairs.length, dp[0][0], JSON.stringify([A, B]));
      for (let k = 0; k < pairs.length; k++) {
        assert.equal(A[pairs[k][0]], B[pairs[k][1]]);
        if (k) assert.ok(pairs[k][0] > pairs[k - 1][0] && pairs[k][1] > pairs[k - 1][1]);
      }
    }
  });
  test('gives up (null) when there are too many differences', () => {
    assert.equal(T.lcsPairs([1, 2, 3, 4], [5, 6, 7, 8], 3), null);
  });
});

describe('the side-by-side view', () => {
  test('lines up both sides, with signs of each kind and filler rows', () => {
    const d = T.runDiff('{"a": 1, "b": "kitten", "c": [1, 2]}', '{"a": 1, "b": "sitting", "c": [1, 2, 3], "d": true}', {});
    const v = d.view, left = v.left.split('\n'), right = v.right.split('\n');
    const kinds = Array.from(v.kind);
    assert.deepEqual(left, ['{', '  "a": 1,', '  "b": "kitten",', '  "c": [', '    1,', '    2', '', '  ]', '', '}']);
    assert.deepEqual(right, ['{', '  "a": 1,', '  "b": "sitting",', '  "c": [', '    1,', '    2,', '    3', '  ],', '  "d": true', '}']);
    assert.deepEqual(kinds, [0, 0, 3, 0, 0, 0, 1, 0, 1, 0]);
    assert.deepEqual(Array.from(v.ln), [1, 2, 3, 4, 5, 6, 0, 7, 0, 8]);
    assert.deepEqual(Array.from(v.rn), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // Character marks inside the changed string.
    const at = v.left.indexOf('kitten');
    assert.deepEqual(v.marks.left.map(m => v.left.slice(m.start, m.end)), ['k', 'e']);
    assert.deepEqual(v.marks.right.map(m => v.right.slice(m.start, m.end)), ['s', 'i', 'g']);
    assert.ok(at > 0);
  });

  test('only changes with context: unchanged parts become gap rows', () => {
    const a = Array.from({ length: 50 }, (_, i) => i), b = a.slice();
    b[25] = 'x';
    const d = T.runDiff(JSON.stringify(a), JSON.stringify(b), { context: 2 });
    const v = d.view;
    assert.deepEqual(Array.from(v.kind), [4, 0, 0, 3, 0, 0, 4]);
    assert.match(v.left.split('\n')[0], /24 unchanged lines/);
    assert.deepEqual(Array.from(v.ln).slice(1, 6), [25, 26, 27, 28, 29]);
    assert.equal(v.changeRow[0], 3);
  });
});

describe('exports', () => {
  test('the diff as text, with paths in the chosen format', () => {
    const d = T.runDiff('{"a": {"b": 1}, "c": "5", "x": [1]}', '{"a": {"b": 2}, "c": 5, "y": null, "x": []}', { arrays: 'position' });
    assert.equal(T.diffAsText(d.diff, 'js'), '1 added · 1 removed · 2 changed\n~ a.b: 1 → 2\n~ c: "5" → 5 (string → number)\n- x[0]: 1\n+ y: null\n');
    assert.match(T.diffAsText(d.diff, 'pointer'), /~ \/a\/b: 1/);
  });
  test('the list for the page has short previews', () => {
    const d = T.runDiff('{"s": "' + 'x'.repeat(200) + '"}', '{"s": "y"}', {});
    assert.ok(d.list[0].before.length <= 80 && d.list[0].before.endsWith('…'));
    assert.equal(d.list[0].after, '"y"');
  });
});

describe('runDiff: input problems', () => {
  test('errors are reported for each side', () => {
    const d = T.runDiff('{"a": 1,}', '[1, 2', {});
    assert.equal(d.status, 'invalid');
    assert.equal(d.errors.a.line, 1);
    assert.ok(d.errors.b);
    assert.equal(T.runDiff('', '[]', {}).status, 'empty');
    assert.equal(T.runDiff('[]', '{"x":', {}).errors.a, null);
  });
});

// ---------- the worker's compare messages ----------

describe('createWorkerHandler: compare', () => {
  const A = JSON.stringify({ rows: [{ id: 1, v: 'a' }, { id: 2, v: 'b' }], n: 1 });
  const B = '{"rows":[{"id":2,"v":"B"},{"id":1,"v":"a"}],"n":1.0,"extra":true}';
  function harness() {
    const sent = [];
    const handle = T.createWorkerHandler((msg, transfer) => sent.push({ msg, transfer }));
    return { sent, handle, last: type => [...sent].reverse().find(s => s.msg.type === type) };
  }
  test('a diff gives the same result as runDiff, and keeps both sides for option changes', () => {
    const h = harness(), opts = { arrays: 'key', key: 'id', ignoreOrder: true, indent: 2 };
    h.handle({ type: 'diff', id: 'q1', va: 1, vb: 1, a: A, b: B, opts });
    const got = h.last('diff').msg, want = T.runDiff(A, B, opts);
    assert.deepEqual(got.list, want.list);
    assert.deepEqual(got.counts, want.counts);
    assert.equal(got.view.left, want.view.left);
    assert.deepEqual(Array.from(got.view.kind), Array.from(want.view.kind));
    assert.ok(h.last('diff').transfer.length > 0);
    // No texts this time: the worker still has version 1 of both.
    h.handle({ type: 'diff', id: 'q2', va: 1, vb: 1, opts: { ...opts, numbersEqual: false } });
    assert.equal(h.last('diff').msg.id, 'q2');
    assert.equal(h.last('diff').msg.counts.changed, want.counts.changed + 1);   // 1 vs 1.0
    h.handle({ type: 'diff', id: 'q3', va: 2, vb: 1, opts });
    assert.deepEqual(h.last('need-text').msg, { type: 'need-text', id: 'q3' });
  });
  test('the view with only changes, and both exports', () => {
    const h = harness();
    h.handle({ type: 'diff', id: 'q1', va: 1, vb: 1, a: A, b: B, opts: { arrays: 'position' } });
    h.handle({ type: 'diffView', id: 'q2', context: 0 });
    assert.ok(Array.from(h.last('diffView').msg.view.kind).every(k => k !== 0));
    h.handle({ type: 'diffExport', id: 'q3', kind: 'patch' });
    const patch = JSON.parse(h.last('diffExport').msg.text);
    assert.ok(same(applyPatch(JSON.parse(A), patch), JSON.parse(B)));
    h.handle({ type: 'diffExport', id: 'q4', kind: 'text', pathFormat: 'jsonpath' });
    assert.match(h.last('diffExport').msg.text, /^\d+ added .*\n~ \$\.rows\[0\]\.id: 1 → 2\n/);
  });
  test('invalid sides are reported, and failures do not stop the worker', () => {
    const h = harness();
    h.handle({ type: 'diff', id: 'q1', va: 1, vb: 1, a: '{"a":', b: '[]', opts: {} });
    assert.equal(h.last('diff').msg.status, 'invalid');
    assert.ok(h.last('diff').msg.errors.a);
    h.handle({ type: 'diffExport', id: 'q2', kind: 'patch' });
    assert.equal(h.last('error').msg.id, 'q2');
  });
});
