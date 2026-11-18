// Unit tests for the large-file helpers in assets/js/json-tools.js: rows, virtual
// scrolling, highlighting part of a text, the sliced parser, jobs and the worker messages.
// Run with: node --test

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const T = require('../assets/js/json-tools.js');

// ---------- helpers ----------

// A small seeded random generator, so failures can be reproduced.
function random(seed) {
  let s = seed >>> 0 || 1;
  const next = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296;
  return { next, int: n => Math.floor(next() * n), pick: list => list[Math.floor(next() * list.length)], chance: p => next() < p };
}

const KEYS = ['id', 'name', 'a b', '', 'kéy', 'quote"key', '__proto__', 'constructor', '10', '2', 'list', 'nested', 'tab\tkey', 'x'.repeat(30)];
const STRINGS = ['', 'plain', 'with "quotes"', 'back\\slash', 'line\nbreak', 'tab\there', 'yes', '0123', 'été 日本', '😀 emoji',
  'a: b', '#hash', '=SUM(A1)', ' padded ', 'x'.repeat(70), ' sep', 'null', 'true'];
function randomValue(rnd, depth) {
  const r = rnd.next();
  if (depth > 4 || r < 0.4) {
    return rnd.pick([0, 1, -1, 1.5, -0, 1e21, 2e-7, 123456789, true, false, null, ...STRINGS]);
  }
  if (r < 0.7) return Array.from({ length: rnd.int(6) }, () => randomValue(rnd, depth + 1));
  const o = {};
  for (let i = rnd.int(6); i > 0; i--) {
    const k = rnd.pick(KEYS);
    if (k === '__proto__') Object.defineProperty(o, k, { value: randomValue(rnd, depth + 1), enumerable: true, writable: true, configurable: true });
    else o[k] = randomValue(rnd, depth + 1);
  }
  return o;
}
// Rows of objects that share keys, so every output format (CSV too) has something to show.
function randomRows(rnd, count) {
  return Array.from({ length: count }, (_, i) => {
    const row = { id: i, name: rnd.pick(STRINGS) };
    if (rnd.chance(0.5)) row.note = rnd.pick(STRINGS);
    if (rnd.chance(0.4)) row.nested = { deep: rnd.pick(STRINGS), n: rnd.int(1000) };
    if (rnd.chance(0.3)) row.tags = [rnd.pick(STRINGS), rnd.pick(STRINGS)];
    if (rnd.chance(0.2)) row.flag = rnd.chance(0.5);
    return row;
  });
}

const ALL_FORMATS = ['json', 'yaml', 'csv', 'ts'];
function outputFor(value, format, extra = {}) {
  const r = T.formatParsed(value, { format, indent: 2, csv: { delimiter: extra.delimiter || ',', protect: true }, ...extra });
  return r.status === 'ok' ? r.output : null;
}
const stripTags = html => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// ---------- rows ----------

describe('rowIndex', () => {
  const rows = (text, max) => { const ix = T.rowIndex(text, max); return Array.from({ length: ix.rows }, (_, r) => text.slice(ix.starts[r], ix.starts[r + 1])); };

  test('one row per line, line endings included, covering the text exactly', () => {
    assert.deepEqual(rows(''), ['']);
    assert.deepEqual(rows('a'), ['a']);
    assert.deepEqual(rows('a\n'), ['a\n', '']);
    assert.deepEqual(rows('a\r\nb\rc\n\nd'), ['a\r\n', 'b\r', 'c\n', '\n', 'd']);
    for (const text of ['', 'x', '\n\n', 'a\r\n', 'a\rb', 'one\ntwo\r\nthree']) {
      const ix = T.rowIndex(text);
      assert.equal(ix.rows, T.countLines(text), JSON.stringify(text));
      assert.equal(ix.lines, ix.rows);
      assert.equal(ix.lineStarts, null);
      assert.equal(ix.starts[ix.rows], text.length);
    }
  });

  test('long lines are split into rows of at most rowChars, never inside a surrogate pair', () => {
    assert.deepEqual(rows('abcdefgh\nij', 3), ['abc', 'def', 'gh\n', 'ij']);
    const ix = T.rowIndex('abcdefgh\nij', 3);
    assert.equal(ix.rows, 4);
    assert.equal(ix.lines, 2);
    assert.deepEqual(Array.from(ix.lineStarts), [0, 9, 11]);
    assert.equal(ix.maxRowLength, 3);
    assert.deepEqual([0, 1, 2, 3].map(r => T.isContinuation(ix, r)), [false, true, true, false]);
    assert.deepEqual([0, 1, 2, 3].map(r => T.lineOfRow(ix, r)), [0, 0, 0, 1]);
    assert.equal(T.rowOfLine(ix, 1), 3);
    const smile = '😀';
    assert.deepEqual(rows('ab' + smile + 'cd', 3), ['ab', smile + 'c', 'd']);
  });

  test('rowOfOffset finds the row holding an offset', () => {
    const text = 'ab\ncdefg\n', ix = T.rowIndex(text, 2);   // ab\n | cd | ef | g\n | ''
    assert.deepEqual([0, 2, 3, 4, 5, 7, 8, 9].map(o => T.rowOfOffset(ix, o)), [0, 0, 1, 1, 2, 3, 3, 4]);
  });

  test('maxRowLength is the longest row without its line ending', () => {
    assert.equal(T.rowIndex('a\nabcd\r\nab').maxRowLength, 4);
  });

  test('a big text is indexed quickly', () => {
    const text = JSON.stringify(randomRows(random(3), 40000), null, 2);
    const t0 = Date.now(), ix = T.rowIndex(text);
    assert.equal(ix.rows, T.countLines(text));
    assert.ok(Date.now() - t0 < 1000);
  });
});

describe('virtual scrolling', () => {
  test('without scaling, rows follow the scroll position', () => {
    const w = T.virtualWindow(240, 480, 1000, 24, 16, 1e7);
    assert.equal(w.scaled, false);
    assert.equal(w.height, 1000 * 24 + 32);
    assert.equal(w.top, 240);
    assert.equal(w.shift, 0);
    assert.equal(w.first, 9);     // (240 - 16) / 24 = 9.3
    assert.equal(w.last, 29);     // (240 + 480 - 16) / 24 = 29.3
  });

  test('the first and last rows are clamped, and so is the scroll position', () => {
    let w = T.virtualWindow(-50, 480, 1000, 24, 16, 1e7);
    assert.equal(w.first, 0);
    w = T.virtualWindow(1e9, 480, 1000, 24, 16, 1e7);
    assert.equal(w.last, 999);
    assert.equal(w.top, 1000 * 24 + 32 - 480);
    w = T.virtualWindow(0, 480, 3, 24, 16, 1e7);
    assert.deepEqual([w.first, w.last, w.height], [0, 2, 3 * 24 + 32]);
  });

  test('above the height limit, the scroll range is scaled and still reaches every row', () => {
    const rows = 3000000, max = 1e7, view = 600;
    let w = T.virtualWindow(0, view, rows, 24, 16, max);
    assert.equal(w.scaled, true);
    assert.equal(w.height, max);
    assert.equal(w.first, 0);
    w = T.virtualWindow(max - view, view, rows, 24, 16, max);
    assert.equal(w.last, rows - 1);
    // Halfway down the scrollbar is halfway through the rows.
    w = T.virtualWindow((max - view) / 2, view, rows, 24, 16, max);
    assert.ok(Math.abs(w.first - rows / 2) < 30, String(w.first));
    // A row drawn at its unscaled position plus shift lands inside the visible area.
    const y = 16 + w.first * 24 + w.shift - (max - view) / 2;
    assert.ok(y <= 0 && y > -24, String(y));
  });

  test('virtualScrollTop is the inverse of virtualWindow', () => {
    for (const [rows, max] of [[1000, 1e7], [3000000, 1e7]]) {
      for (const row of [0, 1, 500, rows - 30]) {
        const y = 16 + row * 24;
        const s = T.virtualScrollTop(y, 600, rows, 24, 16, max);
        const w = T.virtualWindow(s, 600, rows, 24, 16, max);
        assert.ok(Math.abs(w.top - y) < 0.01, `${rows} ${row}`);
        assert.equal(w.first, row);
      }
    }
  });
});

// ---------- highlighting part of a text ----------

describe('scanners', () => {
  test('the JSON scanner gives the same highlighting as highlight()', () => {
    const rnd = random(11);
    for (let i = 0; i < 200; i++) {
      const v = randomValue(rnd, 0);
      for (const text of [JSON.stringify(v), JSON.stringify(v, null, 2), JSON.stringify(v, null, '\t')]) {
        const tokens = [];
        T.scannerFor('json').scan(text, 0, text.length, 0, (s, e, cls) => tokens.push({ start: s, end: e, cls }));
        assert.equal(T.renderTokens(text, tokens, []), T.highlight(text), text);
      }
    }
  });

  test('the JSON scanner copes with a very long string', () => {
    const text = JSON.stringify({ big: 'x\\"'.repeat(300000) });
    const tokens = [];
    T.scannerFor('json').scan(text, 0, text.length, 0, (s, e, cls) => tokens.push(cls + ':' + (e - s)));
    assert.deepEqual(tokens, ['k:5', 's:' + (text.length - 8)]);
  });

  test('every row, scanned from its restart point, gets exactly the tokens of a full scan', () => {
    const rnd = random(5);
    for (let round = 0; round < 60; round++) {
      const value = round % 3 ? randomRows(rnd, 1 + rnd.int(6)) : randomValue(rnd, 0);
      for (const format of ALL_FORMATS) {
        const text = outputFor(value, format, { mode: round % 4 === 0 ? 'minify' : 'format', delimiter: rnd.pick([',', ';', '\t']) });
        if (text === null) continue;
        const scanner = T.scannerFor(format, { delimiter: rnd.pick([',']) });
        if (format === 'csv') continue;   // checked below with the matching delimiter
        checkRows(text, scanner, 1 + rnd.int(40));
      }
      for (const delimiter of [',', ';', '\t']) {
        const text = outputFor(value, 'csv', { delimiter });
        if (text !== null) checkRows(text, T.scannerFor('csv', { delimiter }), 1 + rnd.int(40));
      }
    }
  });

  function checkRows(text, scanner, rowChars) {
    const full = [];
    scanner.scan(text, 0, text.length, scanner.initial, (s, e, cls) => full.push({ start: s, end: e, cls }));
    const index = T.rowIndex(text, rowChars), restarts = T.rowRestarts(scanner, text, index);
    let joined = '';
    for (let r = 0; r < index.rows; r++) {
      const s = index.starts[r], e = index.starts[r + 1];
      const expected = full.filter(t => t.end > s && t.start < e).map(t => ({ start: Math.max(t.start, s) - s, end: Math.min(t.end, e) - s, cls: t.cls }));
      const html = T.renderRow(text, index, restarts, scanner, r, null);
      assert.equal(html, T.renderTokens(text.slice(s, e), expected, []), `row ${r} of ${JSON.stringify(text.slice(0, 200))} (rowChars ${rowChars})`);
      joined += stripTags(html);
    }
    assert.equal(joined, text);
  }

  test('restart points are only kept for rows that need them', () => {
    const text = JSON.stringify({ a: 'x'.repeat(50), b: 1 });
    const index = T.rowIndex(text, 10), restarts = T.rowRestarts(T.scannerFor('json'), text, index);
    // Rows 1 to 5 start inside the long string (from offset 5), row 6 inside the key "b" (from 58).
    assert.deepEqual(Array.from(restarts.rows), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(Array.from(restarts.at), [5, 5, 5, 5, 5, 58]);
    const pretty = JSON.stringify({ a: 1, b: [true, null] }, null, 2);
    const ri = T.rowIndex(pretty);
    assert.equal(T.rowRestarts(T.scannerFor('json'), pretty, ri).rows.length, 0);
    assert.deepEqual(T.restartOf(T.rowRestarts(T.scannerFor('json'), pretty, ri), ri, 2), { at: ri.starts[2], state: 0 });
  });

  test('a YAML block scalar keeps its state on every row', () => {
    const text = T.toYaml({ a: 'line one\nkey: not a key\n- not an item', b: 1 }, 2);
    const scanner = T.scannerFor('yaml'), index = T.rowIndex(text), restarts = T.rowRestarts(scanner, text, index);
    const r = text.split('\n').findIndex(l => l.trim() === 'key: not a key');
    assert.equal(T.renderRow(text, index, restarts, scanner, r, null), '  <span class="s">key: not a key</span>\n');
  });

  test('the CSV header stays a header, and quoted fields over several lines stay strings', () => {
    const text = T.toCsv([{ 'na\nme': 'a\nb', n: 1 }, { 'na\nme': 'c', n: 2 }]).text;
    const scanner = T.scannerFor('csv'), index = T.rowIndex(text), restarts = T.rowRestarts(scanner, text, index);
    const html = Array.from({ length: index.rows }, (_, r) => T.renderRow(text, index, restarts, scanner, r, null));
    // A quoted field's line break belongs to the field, so it is inside the token.
    assert.deepEqual(html, ['<span class="k">"na\n</span>', '<span class="k">me"</span>,<span class="k">n</span>\r\n',
      '<span class="s">"a\n</span>', '<span class="s">b"</span>,<span class="n">1</span>\r\n', '<span class="s">c</span>,<span class="n">2</span>']);
  });

  test('renderRow adds search marks, including marks that cross rows', () => {
    const text = '{"name":"abcdef"}', index = T.rowIndex(text, 10), scanner = T.scannerFor('json');
    const restarts = T.rowRestarts(scanner, text, index);
    const ranges = [{ start: 9, end: 13, i: 0 }];
    assert.equal(T.renderRow(text, index, restarts, scanner, 0, ranges),
      '{<span class="k">"name"</span>:<span class="s">"</span><span class="s"><mark class="m" data-i="0">a</mark></span>');
    assert.equal(T.renderRow(text, index, restarts, scanner, 1, ranges),
      '<span class="s"><mark class="m" data-i="0">bcd</mark></span><span class="s">ef"</span>}');
    assert.equal(T.renderRow(text, index, restarts, null, 1, []), 'bcdef"}');
  });
});

// ---------- parsing in slices ----------

describe('createParser', () => {
  const parseAll = (text, opts) => { const p = T.createParser(text, opts); let steps = 0; while (!p.step(5)) steps++; return { p, steps }; };

  test('gives the same value as JSON.parse, in many small pieces', () => {
    const rnd = random(21);
    for (let i = 0; i < 400; i++) {
      const v = i % 2 ? randomValue(rnd, 0) : randomRows(rnd, rnd.int(20));
      const text = rnd.pick([JSON.stringify(v), JSON.stringify(v, null, 2), ' \n' + JSON.stringify(v, null, '\t') + '\r\n ']);
      for (const chunk of [1, 7, 64, 65536]) {
        const { p } = parseAll(text, { chunk });
        assert.equal(p.error, null, text);
        assert.deepEqual(p.value, JSON.parse(text), `chunk ${chunk}: ${text}`);
        assert.equal(JSON.stringify(p.value), JSON.stringify(JSON.parse(text)));   // key order too
      }
      const { p } = parseAll(text, { chunk: 5, sort: true });
      assert.equal(JSON.stringify(p.value), JSON.stringify(T.sortKeys(JSON.parse(text))));
    }
  });

  test('keeps duplicate keys, __proto__ and number-like keys as JSON.parse does', () => {
    const text = '{"b":1,"2":"two","__proto__":{"x":1},"a":[1,2],"b":3,"10":"ten"}';
    const { p } = parseAll(text, { chunk: 3 });
    assert.equal(JSON.stringify(p.value), JSON.stringify(JSON.parse(text)));
    assert.equal(Object.getPrototypeOf(p.value), Object.prototype);
    assert.ok(Object.prototype.hasOwnProperty.call(p.value, '__proto__'));
  });

  test('works through a big document in steps and reports progress', () => {
    const text = JSON.stringify({ rows: randomRows(random(2), 30000) });
    const p = T.createParser(text, { chunk: 4096 });
    let steps = 0, last = 0;
    while (!p.step(2)) { steps++; assert.ok(p.progress() >= last); last = p.progress(); }
    assert.ok(steps > 3, String(steps));
    assert.equal(p.progress(), 1);
    assert.deepEqual(p.value, JSON.parse(text));
  });

  test('top-level values that are not containers, and very deep nesting', () => {
    for (const text of ['1', ' "s" ', 'null', '[]', '{}', '[[[[]]]]']) assert.deepEqual(parseAll(text, { chunk: 1 }).p.value, JSON.parse(text));
    const deep = '['.repeat(5000) + '1' + ']'.repeat(5000);
    const { p } = parseAll(deep, { chunk: 10 });
    assert.equal(p.error, null);
    assert.deepEqual(T.measure(p.value), { keys: 0, depth: 5000 });
  });

  test('reports an error for text that is not valid JSON', () => {
    for (const bad of ['', '[1,]', '[,1]', '{"a":1,}', '{"a" 1}', '{"a":}', '[1 2]', '[1', '{"a":[1,2}', '[1]x', 'nul', '{a:1}']) {
      for (const chunk of [1, 3, 65536]) {
        const { p } = parseAll(bad, { chunk });
        assert.ok(p.error, `${bad} (chunk ${chunk}) should fail, got ${JSON.stringify(p.value)}`);
      }
    }
  });
});

// ---------- jobs ----------

describe('runJob', () => {
  const opts = (o = {}) => ({ mode: 'format', indent: 2, sort: false, format: 'json', csv: { delimiter: ',', protect: true }, ts: { style: 'interface', rootName: 'Root' }, ...o });

  test('formats, minifies, sorts and converts like the page always has', () => {
    const text = '{"b":[1,{"z":null}],"a":"x"}';
    let r = T.runJob(text, opts());
    assert.equal(r.status, 'ok');
    assert.equal(r.output, JSON.stringify(JSON.parse(text), null, 2));
    assert.equal(r.kind, 'object with 2 keys');
    assert.deepEqual(r.stats, { keys: 3, depth: 3 });
    assert.equal(r.inBytes, text.length);
    assert.equal(r.inLines, 1);
    assert.equal(r.outBytes, r.output.length);
    assert.equal(r.index.rows, T.countLines(r.output));
    assert.equal(T.runJob(text, opts({ mode: 'minify' })).output, text);
    assert.equal(T.runJob(text, opts({ sort: true, mode: 'minify' })).output, '{"a":"x","b":[1,{"z":null}]}');
    assert.equal(T.runJob(text, opts({ indent: '\t' })).output, JSON.stringify(JSON.parse(text), null, '\t'));
    assert.equal(T.runJob(text, opts({ format: 'yaml' })).output, T.toYaml(JSON.parse(text), 2));
    assert.equal(T.runJob(text, opts({ format: 'ts' })).output, T.toTypeScript(JSON.parse(text)).text);
  });

  test('invalid JSON, data that cannot be shown as CSV, and failures', () => {
    const bad = T.runJob('{"a":1,}', opts());
    assert.equal(bad.status, 'invalid');
    assert.equal(bad.error.line, 1);
    const csv = T.runJob('[1,[2]]', opts({ format: 'csv' }));
    assert.equal(csv.status, 'unsupported');
    assert.match(csv.message, /CSV/);
    assert.equal(csv.kind, 'array of 2 items');
    assert.equal(T.isTooDeep(new RangeError('Maximum call stack size exceeded')), true);
    assert.equal(T.isTooBig(new RangeError('Invalid string length')), true);
    assert.equal(T.isTooDeep(new RangeError('Invalid string length')), false);
  });

  test('UTF-8 sizes are counted without encoding', () => {
    for (const s of ['', 'abc', 'é', '日本', '😀', '\ud83d', 'a\udc00b']) {
      assert.equal(T.byteLen(s), new TextEncoder().encode(s).length, JSON.stringify(s));
    }
  });
});

describe('createJobTracker', () => {
  test('only the newest job is current; cancelling makes none current', () => {
    const jobs = T.createJobTracker();
    const a = jobs.start(), b = jobs.start();
    assert.equal(jobs.isCurrent(a), false);
    assert.equal(jobs.isCurrent(b), true);
    jobs.cancel();
    assert.equal(jobs.isCurrent(b), false);
    const c = jobs.start();
    assert.ok(c > b);
    assert.equal(jobs.isCurrent(c), true);
  });
});

// ---------- the worker's messages ----------

describe('createWorkerHandler', () => {
  const OPTS = { mode: 'format', indent: 2, sort: false, format: 'json', csv: { delimiter: ',', protect: true }, ts: { style: 'interface', rootName: 'Root' } };
  const SAMPLE = JSON.stringify({ users: [{ name: 'Amina', tags: ['a'] }, { name: 'Bilal', note: 'x\ny' }], total: 2 });

  function harness(options) {
    const sent = [];
    const handle = T.createWorkerHandler((msg, transfer) => sent.push({ msg, transfer }), options);
    return { sent, handle, last: type => [...sent].reverse().find(s => s.msg.type === type) };
  }
  // A job result with the parts the main thread compares: everything but the value.
  const comparable = out => {
    const c = {};
    for (const k of Object.keys(out).sort()) {
      if (k === 'value' || k === 'type' || k === 'id') continue;
      const v = out[k];
      c[k] = k === 'index' ? { ...v, starts: Array.from(v.starts), lineStarts: v.lineStarts && Array.from(v.lineStarts) }
        : k === 'restarts' ? { rows: Array.from(v.rows), at: Array.from(v.at), state: Array.from(v.state) } : v;
    }
    return c;
  };

  test('a job gives the same result as runJob, in every format and mode', () => {
    for (const format of ALL_FORMATS) {
      for (const extra of [{}, { mode: 'minify' }, { sort: true }, { indent: '\t' }]) {
        const opts = { ...OPTS, format, ...extra }, h = harness();
        h.handle({ type: 'job', id: 1, version: 1, text: SAMPLE, opts });
        const res = h.last('result');
        assert.deepEqual(comparable(res.msg), comparable(T.runJob(SAMPLE, opts)), format + ' ' + JSON.stringify(extra));
        // The row index travels as transferable buffers.
        if (res.msg.index) assert.ok(res.transfer.includes(res.msg.index.starts.buffer));
      }
    }
  });

  test('progress is reported before each phase', () => {
    const h = harness();
    h.handle({ type: 'job', id: 7, version: 1, text: SAMPLE, opts: { ...OPTS, sort: true, format: 'yaml' } });
    assert.deepEqual(h.sent.map(s => s.msg.type + (s.msg.phase ? ':' + s.msg.phase : '')), ['progress:parse', 'progress:sort', 'progress:convert', 'result']);
    assert.ok(h.sent.every(s => s.msg.id === 7));
  });

  test('the parsed value is kept: a new option does not need the text again', () => {
    const h = harness();
    h.handle({ type: 'job', id: 1, version: 3, text: SAMPLE, opts: OPTS });
    h.handle({ type: 'job', id: 2, version: 3, opts: { ...OPTS, format: 'ts' } });
    assert.equal(h.last('result').msg.id, 2);
    assert.equal(h.last('result').msg.output, T.toTypeScript(JSON.parse(SAMPLE)).text);
    assert.equal(h.sent.filter(s => s.msg.phase === 'parse').length, 1);
    h.handle({ type: 'job', id: 3, version: 4, opts: OPTS });   // a version it has never seen
    assert.deepEqual(h.last('need-text').msg, { type: 'need-text', id: 3 });
  });

  test('invalid input is reported with its location, and kept for the next option change', () => {
    const h = harness();
    h.handle({ type: 'job', id: 1, version: 1, text: '{\n  "a": 1,\n}', opts: OPTS });
    const r = h.last('result').msg;
    assert.equal(r.status, 'invalid');
    assert.equal(r.error.line, 3);
    h.handle({ type: 'job', id: 2, version: 1, opts: { ...OPTS, mode: 'minify' } });
    assert.equal(h.last('result').msg.status, 'invalid');
  });

  test('search, paths, values and repairs use the kept output and value', () => {
    const h = harness();
    h.handle({ type: 'job', id: 1, version: 1, text: SAMPLE, opts: { ...OPTS, sort: true } });
    const out = h.last('result').msg.output, value = T.sortKeys(JSON.parse(SAMPLE));
    h.handle({ type: 'search', id: 2, query: 'amina', opts: { scope: 'both' } });
    const s = h.last('search').msg;
    const expected = T.searchJson(value, 'amina', { scope: 'both' });
    assert.deepEqual(s.matches, expected.matches);
    assert.deepEqual(s.ranges, T.locateMatches(out, expected.matches));
    assert.equal(out.slice(s.ranges[0].start, s.ranges[0].end), 'Amina');
    const offset = out.indexOf('Bilal');
    h.handle({ type: 'pathAt', id: 3, offset });
    assert.deepEqual(h.last('pathAt').msg.path, ['users', 1, 'name']);
    h.handle({ type: 'rangeOf', id: 4, parts: ['users', 1, 'name'] });
    assert.deepEqual(h.last('rangeOf').msg.range, T.rangeOfPath(out, ['users', 1, 'name']));
    h.handle({ type: 'copyValue', id: 5, parts: ['users', 0], indent: 2 });
    assert.equal(h.last('copyValue').msg.text, T.copyValueText(value.users[0], 2));
    h.handle({ type: 'copyValue', id: 6, parts: ['missing'], indent: 2 });
    assert.equal(h.last('copyValue').msg.text, null);
    h.handle({ type: 'repair', id: 7, text: "{'a': 1,}" });
    assert.deepEqual(h.last('repair').msg.result, T.repairJson("{'a': 1,}"));
    // Text formats search the text that is showing.
    h.handle({ type: 'job', id: 8, version: 1, opts: { ...OPTS, format: 'yaml' } });
    h.handle({ type: 'search', id: 9, query: 'name', opts: {} });
    const yamlOut = h.last('result').msg.output;
    assert.deepEqual(h.last('search').msg.matches, T.searchText(yamlOut, 'name', {}).matches);
  });

  test('errors become error messages instead of stopping the worker', () => {
    const h = harness();
    h.handle({ type: 'search', id: 1, query: 'x', opts: { regex: true } });   // no job yet
    h.handle({ type: 'job', id: 2, version: 1, text: '[1]', opts: OPTS });
    assert.equal(h.last('result').msg.status, 'ok');
  });

  test('sliced mode (no worker) gives the same results, and can be cancelled', async () => {
    const big = JSON.stringify(randomRows(random(9), 3000));
    for (const format of ALL_FORMATS) {
      const opts = { ...OPTS, format }, h = harness({ sliced: true });
      h.handle({ type: 'job', id: 1, version: 1, text: big, opts });
      assert.equal(h.last('result'), undefined);   // it has not finished yet: it yields between steps
      for (let i = 0; i < 200 && !h.last('result'); i++) await new Promise(r => setTimeout(r, 5));
      assert.deepEqual(comparable(h.last('result').msg), comparable(T.runJob(big, opts)), format);
    }
    const h = harness({ sliced: true });
    h.handle({ type: 'job', id: 1, version: 1, text: big, opts: OPTS });
    h.handle({ type: 'cancel', id: 1 });
    await new Promise(r => setTimeout(r, 300));
    assert.equal(h.last('result'), undefined);
  });
});

describe('the worker script', () => {
  // Runs the real worker source (as the page builds it for its Blob URL) in a sandbox with
  // a worker-like global, and checks it answers exactly like the main-thread code.
  function startWorker() {
    const sent = [];
    const self = { postMessage: (msg, transfer) => sent.push({ msg, transfer }) };
    self.self = self;
    const context = vm.createContext({ self, TextEncoder, setTimeout, performance, Uint32Array, Int32Array });
    vm.runInContext(T.workerSource(), context);
    return { sent, post: msg => self.onmessage({ data: msg }) };
  }

  test('the source is this file plus the start-up code', () => {
    const src = T.workerSource();
    const file = fs.readFileSync(path.join(__dirname, '../assets/js/json-tools.js'), 'utf8');
    const body = file.slice(file.indexOf('(function jsonTools'), file.lastIndexOf('})(typeof') + 1).replace(/^\(/, '');
    assert.ok(src.startsWith('(' + body), 'starts with the json-tools function');
    assert.match(src, /createWorkerHandler/);
  });

  test('worker results equal main-thread results in every output format', () => {
    const w = startWorker();
    const text = JSON.stringify({ rows: randomRows(random(4), 50) }, null, 2);
    let id = 0;
    for (const format of ALL_FORMATS) {
      for (const extra of [{}, { mode: 'minify' }, { sort: true }]) {
        const opts = { mode: 'format', indent: 2, sort: false, format, csv: { delimiter: ';', protect: true }, ts: { style: 'type', rootName: 'Data' }, ...extra };
        w.post({ type: 'job', id: ++id, version: 1, text, opts });
        const got = w.sent.filter(s => s.msg.type === 'result').pop().msg;
        const want = T.runJob(text, opts);
        assert.equal(got.status, want.status, format);
        assert.equal(got.output, want.output, format + ' ' + JSON.stringify(extra));
        assert.deepEqual(JSON.parse(JSON.stringify(got.stats)), want.stats);   // made in the sandbox's realm
        assert.equal(got.kind, want.kind);
        if (want.index) {
          assert.deepEqual(Array.from(got.index.starts), Array.from(want.index.starts));
          assert.deepEqual(Array.from(got.restarts.at), Array.from(want.restarts.at));
        }
      }
    }
  });
});
