// Unit tests for assets/js/json-tools.js. Run with: node --test

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../assets/js/json-tools.js');

// ---------- helpers ----------

// Removes highlight markup and decodes the escaped entities: the text a user sees and copies.
const visibleText = html => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// Returns the error JSON.parse throws for a string.
const parseError = text => { try { JSON.parse(text); } catch (e) { return e; } assert.fail('expected invalid JSON: ' + text); };

const deepArray = n => '['.repeat(n) + ']'.repeat(n);

const SAMPLE = {
  service: 'inventory-api', version: 3, healthy: true, deprecated: false, owner: null,
  limits: { maxItems: 500, ratio: 0.75, threshold: -12.5, big: 1.2e6 },
  regions: ['eu-west', 'us-east'],
  items: [{ sku: 'KB-104', price: 89.5, tags: ['keyboard'] }, { sku: 'MS-220', price: 24.99, tags: [] }],
  notes: 'Ships in 2 days, "fragile" items wrapped'
};

// ---------- exports ----------

test('exports every helper', () => {
  for (const name of ['fmtBytes', 'byteLen', 'esc', 'describeError', 'findSyntaxError', 'sortKeys', 'measure', 'kindOf',
    'countLines', 'lineNumbers', 'gutterDigits', 'highlight', 'repairJson', 'summarizeRepairs',
    'groupDigits', 'containerInfo', 'listChildren', 'childPath', 'displayKey', 'scalarView',
    'formatPath', 'pathLabels', 'valueAtPath', 'copyValueText', 'pathAtOffset', 'rangeOfPath']) {
    assert.equal(typeof T[name], 'function', name);
  }
});

// ---------- formatting and minifying ----------
// The app formats with JSON.stringify(value, null, indent) and minifies with JSON.stringify(value),
// then highlights the result. These tests check that pipeline end to end.

describe('formatting and minifying', () => {
  for (const [label, indent] of [['2 spaces', 2], ['4 spaces', 4], ['tab', '\t']]) {
    test(`formatted output (${label}) shows exactly the formatted text`, () => {
      const text = JSON.stringify(SAMPLE, null, indent);
      assert.equal(visibleText(T.highlight(text)), text);
    });
  }

  test('minified output shows exactly the minified text', () => {
    const text = JSON.stringify(SAMPLE);
    assert.ok(!/\s(?=(?:[^"]*"[^"]*")*[^"]*$)/.test(text), 'no whitespace outside strings');
    assert.equal(visibleText(T.highlight(text)), text);
  });

  test('formatting then minifying round-trips to the same data', () => {
    const formatted = JSON.stringify(SAMPLE, null, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(JSON.parse(formatted))), SAMPLE);
  });

  test('empty containers', () => {
    assert.equal(JSON.stringify({}, null, 2), '{}');
    assert.equal(JSON.stringify([], null, 2), '[]');
    assert.equal(visibleText(T.highlight('{}')), '{}');
  });

  test('numbers keep their JSON form (1e10, 1e21, small exponents)', () => {
    const text = JSON.stringify([1e10, 1e21, -1.5e-7, 0.1, -12.5]);
    assert.equal(text, '[10000000000,1e+21,-1.5e-7,0.1,-12.5]');
    assert.equal(T.highlight(text),
      '[<span class="n">10000000000</span>,<span class="n">1e+21</span>,<span class="n">-1.5e-7</span>,' +
      '<span class="n">0.1</span>,<span class="n">-12.5</span>]');
  });

  test('-0 is written as 0 (JSON.stringify behavior, kept as a known limitation)', () => {
    assert.ok(Object.is(JSON.parse('-0'), -0));
    assert.equal(JSON.stringify(JSON.parse('[-0]')), '[0]');
  });
});

// ---------- sortKeys ----------

describe('sortKeys', () => {
  test('sorts object keys alphabetically', () => {
    assert.deepEqual(Object.keys(T.sortKeys({ b: 1, a: 2, c: 3 })), ['a', 'b', 'c']);
  });

  test('sorts nested objects, including objects inside arrays', () => {
    const out = T.sortKeys({ z: { y: 1, x: 2 }, a: [{ d: 1, c: 2 }] });
    assert.equal(JSON.stringify(out), '{"a":[{"c":2,"d":1}],"z":{"x":2,"y":1}}');
  });

  test('keeps array order', () => {
    assert.deepEqual(T.sortKeys([3, 1, 2]), [3, 1, 2]);
  });

  test('returns primitives and null unchanged', () => {
    for (const v of [null, 0, -1.5, 'text', true, false]) assert.equal(T.sortKeys(v), v);
  });

  test('uses code-point order (uppercase before lowercase, unicode last)', () => {
    assert.deepEqual(Object.keys(T.sortKeys({ b: 1, B: 1, a: 1, 'é': 1, '😀': 1, '1': 1 })), ['1', 'B', 'a', 'b', 'é', '😀']);
  });

  test('does not change the input object', () => {
    const input = { b: { d: 1, c: 2 }, a: 1 };
    const before = JSON.stringify(input);
    T.sortKeys(input);
    assert.equal(JSON.stringify(input), before);
  });

  test('keeps a "__proto__" key from the JSON data as a normal key', () => {
    const out = T.sortKeys(JSON.parse('{"b":1,"__proto__":{"x":1}}'));
    assert.equal(JSON.stringify(out), '{"__proto__":{"x":1},"b":1}');
    assert.equal(Object.getPrototypeOf(out), Object.prototype, 'output is still a plain object');
    assert.ok(Object.prototype.hasOwnProperty.call(out, '__proto__'));
  });

  test('never loses a key, including names that exist on Object.prototype', () => {
    const special = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', '__defineGetter__', 'prototype', ''];
    const text = '{' + special.map((k, i) => JSON.stringify(k) + ':{' + special.map((k2, j) => JSON.stringify(k2) + ':' + (i * 10 + j)).join(',') + '}').join(',') + '}';
    const input = JSON.parse(text);
    const out = T.sortKeys(input);
    const sorted = [...special].sort();
    assert.deepEqual(Object.keys(out), sorted);
    for (const k of special) {
      assert.deepEqual(Object.keys(out[k]), sorted, `nested keys under ${k}`);
      for (const k2 of special) assert.equal(out[k][k2], input[k][k2]);
    }
    assert.equal(T.measure(out).keys, T.measure(input).keys);
    assert.deepEqual(JSON.parse(JSON.stringify(out)), JSON.parse(text));
  });

  test('keeps the same keys and values as the input for the sample', () => {
    assert.deepEqual(T.sortKeys(SAMPLE), SAMPLE);
  });

  test('handles 10,000 levels of nesting', () => {
    const out = T.sortKeys(JSON.parse(deepArray(10000)));
    assert.equal(T.measure(out).depth, 9999);
  });

  test('handles 100,000 levels of nesting, objects and arrays mixed', () => {
    const text = '{"a":['.repeat(50000) + '1' + ']}'.repeat(50000);
    const out = T.sortKeys(JSON.parse(text));
    assert.equal(T.measure(out).depth, 100000);
  });
});

// ---------- measure (stats) ----------

describe('measure', () => {
  test('counts keys in all nested objects and reports max depth', () => {
    assert.deepEqual(T.measure({ a: 1, b: { c: 2, d: [{ e: 3 }] } }), { keys: 5, depth: 4 });
  });

  test('scalars and empty containers have no keys and depth 0', () => {
    for (const v of [null, 1, 'x', true, {}, []]) assert.deepEqual(T.measure(v), { keys: 0, depth: 0 }, JSON.stringify(v));
  });

  test('array items add depth but not keys', () => {
    assert.deepEqual(T.measure([1, [2, [3]]]), { keys: 0, depth: 3 });
  });

  test('counts the sample: 9 top-level + 4 in limits + 3 in each of 2 items', () => {
    assert.deepEqual(T.measure(SAMPLE), { keys: 19, depth: 4 });
  });

  test('handles 1,000 levels of nesting', () => {
    assert.deepEqual(T.measure(JSON.parse(deepArray(1000))), { keys: 0, depth: 999 });
  });

  test('handles 10,000 levels of nesting', () => {
    assert.deepEqual(T.measure(JSON.parse(deepArray(10000))), { keys: 0, depth: 9999 });
  });

  test('handles 100,000 levels of nesting', () => {
    assert.deepEqual(T.measure(JSON.parse(deepArray(100000))), { keys: 0, depth: 99999 });
    assert.deepEqual(T.measure(JSON.parse('{"k":'.repeat(100000) + '0' + '}'.repeat(100000))), { keys: 100000, depth: 100000 });
  });

  test('counts a "__proto__" key like any other key', () => {
    assert.deepEqual(T.measure(JSON.parse('{"__proto__":{"x":1},"b":2}')), { keys: 3, depth: 2 });
  });
});

// ---------- kindOf ----------

describe('kindOf', () => {
  test('describes arrays and objects with correct plurals', () => {
    assert.equal(T.kindOf([]), 'array of 0 items');
    assert.equal(T.kindOf([1]), 'array of 1 item');
    assert.equal(T.kindOf([1, 2]), 'array of 2 items');
    assert.equal(T.kindOf({}), 'object with 0 keys');
    assert.equal(T.kindOf({ a: 1 }), 'object with 1 key');
    assert.equal(T.kindOf({ a: 1, b: 2 }), 'object with 2 keys');
  });

  test('describes top-level scalars', () => {
    assert.equal(T.kindOf(null), 'null');
    assert.equal(T.kindOf('s'), 'string');
    assert.equal(T.kindOf(1e10), 'number');
    assert.equal(T.kindOf(false), 'boolean');
  });
});

// ---------- sizes: byteLen and fmtBytes ----------

describe('byteLen', () => {
  test('counts UTF-8 bytes, not characters', () => {
    assert.equal(T.byteLen(''), 0);
    assert.equal(T.byteLen('abc'), 3);
    assert.equal(T.byteLen('é'), 2);
    assert.equal(T.byteLen('ключ'), 8);
    assert.equal(T.byteLen('€'), 3);
    assert.equal(T.byteLen('😀'), 4);
    assert.equal(T.byteLen('👍🏽'), 8);
  });

  test('handles very long strings', () => {
    assert.equal(T.byteLen('x'.repeat(5_000_000)), 5_000_000);
  });
});

describe('fmtBytes', () => {
  test('bytes, kilobytes and megabytes', () => {
    assert.equal(T.fmtBytes(0), '0 B');
    assert.equal(T.fmtBytes(1023), '1023 B');
    assert.equal(T.fmtBytes(1024), '1.0 KB');
    assert.equal(T.fmtBytes(1536), '1.5 KB');
    assert.equal(T.fmtBytes(1048576), '1.00 MB');
    assert.equal(T.fmtBytes(5 * 1048576 + 1048576 / 4), '5.25 MB');
  });

  test('switches to MB from 1023.95 KB up, so it never shows "1024.0 KB"', () => {
    assert.equal(T.fmtBytes(1048524), '1023.9 KB'); // 1023.949 KB
    assert.equal(T.fmtBytes(1048525), '1.00 MB');   // 1023.950 KB
    assert.equal(T.fmtBytes(1048575), '1.00 MB');
    for (let n = 1024; n < 1048576 * 2; n += 997) assert.ok(!/^1024\.\d KB$/.test(T.fmtBytes(n)), `${n} -> ${T.fmtBytes(n)}`);
  });

  test('bytes to KB boundary: 1023 B, then 1.0 KB', () => {
    assert.equal(T.fmtBytes(1023), '1023 B');
    assert.equal(T.fmtBytes(1024), '1.0 KB');
    assert.equal(T.fmtBytes(1075), '1.0 KB');
    assert.equal(T.fmtBytes(1076), '1.1 KB');
  });
});

// ---------- line numbers ----------

describe('countLines', () => {
  test('empty text is one line', () => {
    assert.equal(T.countLines(''), 1);
  });

  test('counts newline-separated lines', () => {
    assert.equal(T.countLines('a'), 1);
    assert.equal(T.countLines('a\nb'), 2);
    assert.equal(T.countLines('a\nb\nc'), 3);
  });

  test('a trailing newline starts a new empty line, like an editor', () => {
    assert.equal(T.countLines('a\n'), 2);
    assert.equal(T.countLines('\n'), 2);
    assert.equal(T.countLines('\n\n\n'), 4);
  });

  test('handles \\r\\n and lone \\r line endings', () => {
    assert.equal(T.countLines('a\r\nb\r\nc'), 3);
    assert.equal(T.countLines('a\rb\rc'), 3);
    assert.equal(T.countLines('a\r\nb\rc\nd'), 4);
  });

  test('matches the formatted output line by line', () => {
    for (const indent of [2, 4, '\t']) {
      const text = JSON.stringify(SAMPLE, null, indent);
      assert.equal(T.countLines(text), text.split('\n').length);
    }
    assert.equal(T.countLines(JSON.stringify(SAMPLE)), 1, 'minified output is one line');
  });

  test('newlines escaped inside JSON strings do not count', () => {
    assert.equal(T.countLines(JSON.stringify({ a: 'line1\nline2' }, null, 2)), 3);
  });

  test('counts 100,000 lines quickly', () => {
    const text = 'x\n'.repeat(99_999) + 'x';
    const t0 = performance.now();
    assert.equal(T.countLines(text), 100_000);
    assert.ok(performance.now() - t0 < 100);
  });
});

describe('lineNumbers', () => {
  test('builds the gutter text 1..n, one number per line', () => {
    assert.equal(T.lineNumbers(1), '1');
    assert.equal(T.lineNumbers(3), '1\n2\n3');
    assert.equal(T.lineNumbers(12).split('\n').at(-1), '12');
  });

  test('always has as many lines as the text it numbers', () => {
    for (const text of ['', 'a', 'a\n', '{\n  "a": 1\n}', JSON.stringify(SAMPLE, null, 2)]) {
      assert.equal(T.countLines(T.lineNumbers(T.countLines(text))), T.countLines(text));
    }
  });

  test('falls back to a single line for zero, negative or invalid counts', () => {
    assert.equal(T.lineNumbers(0), '1');
    assert.equal(T.lineNumbers(-5), '1');
    assert.equal(T.lineNumbers(NaN), '1');
    assert.equal(T.lineNumbers(2.7), '1\n2');
  });

  test('builds 5,000 and 100,000 lines quickly', () => {
    const t0 = performance.now();
    const big = T.lineNumbers(100_000);
    assert.ok(performance.now() - t0 < 200);
    assert.equal(T.countLines(big), 100_000);
    assert.ok(big.endsWith('\n99999\n100000'));
    assert.equal(T.lineNumbers(5000).split('\n')[4999], '5000');
  });
});

describe('gutterDigits', () => {
  test('is at least 2, then grows with the largest line number', () => {
    assert.equal(T.gutterDigits(1), 2);
    assert.equal(T.gutterDigits(99), 2);
    assert.equal(T.gutterDigits(100), 3);
    assert.equal(T.gutterDigits(9999), 4);
    assert.equal(T.gutterDigits(10000), 5);
    assert.equal(T.gutterDigits(0), 2);
  });
});

// ---------- tree view helpers ----------

describe('groupDigits', () => {
  test('adds thousands separators', () => {
    assert.deepEqual([0, 7, 999, 1000, 10000, 1234567, -2500].map(T.groupDigits), ['0', '7', '999', '1,000', '10,000', '1,234,567', '-2,500']);
  });
});

describe('containerInfo', () => {
  test('objects: count, keys in order and summary', () => {
    const info = T.containerInfo({ b: 1, a: 2, c: { d: 1 }, e: [], f: null });
    assert.deepEqual(info, { kind: 'object', count: 5, keys: ['b', 'a', 'c', 'e', 'f'], brief: '{…}', empty: '{}', label: '5 keys' });
  });

  test('arrays: count and summary with separators', () => {
    assert.deepEqual(T.containerInfo(new Array(120).fill(0)), { kind: 'array', count: 120, keys: null, brief: '[…]', empty: '[]', label: '120 items' });
    assert.equal(T.containerInfo(new Array(10000).fill(0)).label, '10,000 items');
  });

  test('singular and empty labels', () => {
    assert.equal(T.containerInfo({ a: 1 }).label, '1 key');
    assert.equal(T.containerInfo([1]).label, '1 item');
    assert.equal(T.containerInfo({}).label, '0 keys');
    assert.equal(T.containerInfo([]).count, 0);
  });

  test('scalars are not containers', () => {
    for (const v of [null, 0, 'x', true, false]) assert.equal(T.containerInfo(v), null);
  });

  test('counts a "__proto__" key from the JSON', () => {
    assert.deepEqual(T.containerInfo(JSON.parse('{"__proto__": 1, "a": 2}')).keys, ['__proto__', 'a']);
  });
});

describe('listChildren', () => {
  test('array slice with indexes', () => {
    assert.deepEqual(T.listChildren(['a', 'b', 'c', 'd'], 1, 3), [
      { key: 1, isIndex: true, value: 'b' }, { key: 2, isIndex: true, value: 'c' }]);
  });

  test('object slice in key order, using given keys', () => {
    const v = { z: 1, a: 2, m: 3 };
    assert.deepEqual(T.listChildren(v, 0, 2), [{ key: 'z', isIndex: false, value: 1 }, { key: 'a', isIndex: false, value: 2 }]);
    assert.deepEqual(T.listChildren(v, 2, 10, ['z', 'a', 'm']), [{ key: 'm', isIndex: false, value: 3 }]);
  });

  test('end past the last child and start past the end', () => {
    assert.equal(T.listChildren([1, 2], 0, 100).length, 2);
    assert.deepEqual(T.listChildren([1, 2], 5, 10), []);
  });

  test('scalars have no children', () => {
    assert.deepEqual(T.listChildren('text', 0, 10), []);
    assert.deepEqual(T.listChildren(null, 0, 10), []);
  });

  test('pages through 10,000 items in order', () => {
    const big = Array.from({ length: 10000 }, (_, i) => i);
    const seen = [];
    for (let start = 0; start < big.length; start += 100) seen.push(...T.listChildren(big, start, start + 100).map(c => c.value));
    assert.deepEqual(seen, big);
  });

  test('a "__proto__" key keeps its own value', () => {
    const v = T.sortKeys(JSON.parse('{"b": 1, "__proto__": {"x": 1}}'));
    assert.deepEqual(T.listChildren(v, 0, 10), [{ key: '__proto__', isIndex: false, value: { x: 1 } }, { key: 'b', isIndex: false, value: 1 }]);
  });
});

describe('childPath', () => {
  test('builds paths like data.users[2].email', () => {
    let p = T.childPath('', 'data', false);
    p = T.childPath(p, 'users', false);
    p = T.childPath(p, 2, true);
    assert.equal(T.childPath(p, 'email', false), 'data.users[2].email');
  });

  test('root arrays start with an index', () => {
    assert.equal(T.childPath(T.childPath('', 0, true), 'id', false), '[0].id');
  });

  test('keys that are not identifiers use bracket notation', () => {
    assert.equal(T.childPath('a', 'with space', false), 'a["with space"]');
    assert.equal(T.childPath('a', '1st', false), 'a["1st"]');
    assert.equal(T.childPath('', '', false), '[""]');
    assert.equal(T.childPath('a', 'say "hi"', false), 'a["say \\"hi\\""]');
    assert.equal(T.childPath('a', 'dash-key', false), 'a["dash-key"]');
    assert.equal(T.childPath('', '$ref', false), '$ref');
  });

  test('every path in a document leads back to its value', () => {
    // Small resolver for the path syntax above (used by the copy-path feature later).
    const resolve = (root, path) => {
      const re = /^(?:\.?([A-Za-z_$][A-Za-z0-9_$]*)|\[(\d+)\]|\[("(?:[^"\\]|\\.)*")\])/;
      let v = root, rest = path;
      while (rest) {
        const m = re.exec(rest);
        assert.ok(m, `cannot read ${rest}`);
        v = v[m[1] !== undefined ? m[1] : m[2] !== undefined ? +m[2] : JSON.parse(m[3])];
        rest = rest.slice(m[0].length);
      }
      return v;
    };
    const doc = { ...SAMPLE, 'odd key': [{ 'a.b': 1, '': 2, 'q"': [true] }] };
    let checked = 0;
    const walk = (v, path) => {
      assert.deepEqual(resolve(doc, path), v, path);
      checked++;
      const info = T.containerInfo(v);
      if (info) for (const c of T.listChildren(v, 0, info.count, info.keys)) walk(c.value, T.childPath(path, c.key, c.isIndex));
    };
    walk(doc, '');
    assert.ok(checked > 30);
  });
});

// ---------- path formats ----------

// Independent resolvers, one per format, used to check formatPath.
const RESOLVE = {
  // Real JavaScript evaluation of root + path.
  js: (root, path) => new Function('root', 'return root' + (path === '' || path[0] === '[' ? '' : '.') + path)(root),
  jsonpath: (root, path) => {
    assert.equal(path[0], '$', path);
    let v = root, rest = path.slice(1);
    const re = /^(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]|\[("(?:[^"\\]|\\.)*")\])/;
    while (rest) {
      const m = re.exec(rest);
      assert.ok(m, `bad JSONPath segment in ${path} at ${rest}`);
      v = m[1] !== undefined ? v[m[1]] : m[2] !== undefined ? v[+m[2]] : v[JSON.parse(m[3])];
      rest = rest.slice(m[0].length);
    }
    return v;
  },
  jq: (root, path) => {
    assert.equal(path[0], '.', path);
    if (path === '.') return root;
    let v = root, rest = path;
    const re = /^(?:\.([A-Za-z_][A-Za-z0-9_]*)|\.("(?:[^"\\]|\\.)*")|\.?\[(\d+)\])/;
    while (rest) {
      const m = re.exec(rest);
      assert.ok(m, `bad jq segment in ${path} at ${rest}`);
      v = m[1] !== undefined ? v[m[1]] : m[2] !== undefined ? v[JSON.parse(m[2])] : v[+m[3]];
      rest = rest.slice(m[0].length);
    }
    return v;
  },
  // RFC 6901
  pointer: (root, path) => {
    if (path === '') return root;
    assert.equal(path[0], '/', path);
    let v = root;
    for (const token of path.slice(1).split('/')) {
      const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
      if (Array.isArray(v)) { assert.match(key, /^(0|[1-9]\d*)$/); v = v[+key]; }
      else { assert.ok(Object.prototype.hasOwnProperty.call(v, key), `missing ${key}`); v = v[key]; }
    }
    return v;
  }
};

const TRICKY_KEYS = ['plain', 'with space', 'a.b', 'say "hi"', 'back\\slash', 'til~de', 'sl/ash', '~1', '~0/~1',
  String.fromCodePoint(0x1f600), '', '0', '12', '__proto__', 'constructor', 'toString', '$dollar', '_under',
  'tab\there', 'line\nbreak', 'été', '[x]', "o'k", 'jq\\(interp)', '-', '1e3'];

// A document whose keys are all tricky, built from JSON text so "__proto__" is a real key.
function trickyDoc() {
  const obj = (keys, leaf) => '{' + keys.map((k, i) => JSON.stringify(k) + ':' + leaf(i)).join(',') + '}';
  const inner = i => obj(TRICKY_KEYS, j => i * 100 + j);
  return JSON.parse('{' + TRICKY_KEYS.map((k, i) => JSON.stringify(k) + ':' + inner(i)).join(',') +
    ',"list":[' + inner(99) + ',[1,[2,{"' + 'deep key' + '":true}]],null,"text"]}');
}

function allPaths(root) {
  const out = [];
  (function walk(v, parts) {
    out.push({ parts, value: v });
    const info = T.containerInfo(v);
    if (info) for (const c of T.listChildren(v, 0, info.count, info.keys)) walk(c.value, parts.concat(c.key));
  })(root, []);
  return out;
}

describe('formatPath', () => {
  test('examples in each format', () => {
    const parts = ['data', 'users', 2, 'email'];
    assert.equal(T.formatPath(parts, 'js'), 'data.users[2].email');
    assert.equal(T.formatPath(parts, 'jsonpath'), '$.data.users[2].email');
    assert.equal(T.formatPath(parts, 'jq'), '.data.users[2].email');
    assert.equal(T.formatPath(parts, 'pointer'), '/data/users/2/email');
  });

  test('keys that need quoting', () => {
    const parts = ['data', 'odd key', 0];
    assert.equal(T.formatPath(parts, 'js'), 'data["odd key"][0]');
    assert.equal(T.formatPath(parts, 'jsonpath'), '$.data["odd key"][0]');
    assert.equal(T.formatPath(parts, 'jq'), '.data."odd key"[0]');
    assert.equal(T.formatPath(parts, 'pointer'), '/data/odd key/0');
  });

  test('JSON Pointer escapes ~ as ~0 and / as ~1', () => {
    assert.equal(T.formatPath(['a/b', '~', 'x~/y'], 'pointer'), '/a~1b/~0/x~0~1y');
  });

  test('the root in each format', () => {
    assert.deepEqual(['js', 'jsonpath', 'jq', 'pointer'].map(f => T.formatPath([], f)), ['', '$', '.', '']);
  });

  test('a root array starts with an index', () => {
    assert.equal(T.formatPath([0, 'id'], 'js'), '[0].id');
    assert.equal(T.formatPath([0, 'id'], 'jq'), '.[0].id');
    assert.equal(T.formatPath([0, 'id'], 'jsonpath'), '$[0].id');
  });

  test('__proto__, numeric keys and $ are quoted where a plain name would be wrong', () => {
    assert.equal(T.formatPath(['__proto__'], 'js'), '["__proto__"]');
    assert.equal(T.formatPath(['0'], 'js'), '["0"]');
    assert.equal(T.formatPath(['0'], 'jq'), '."0"');
    assert.equal(T.formatPath(['$ref'], 'js'), '$ref');
    assert.equal(T.formatPath(['$ref'], 'jsonpath'), '$["$ref"]');
  });

  for (const format of ['js', 'jsonpath', 'jq', 'pointer']) {
    test(`every path in a document of tricky keys resolves back to its value (${format})`, () => {
      const doc = trickyDoc();
      const paths = allPaths(doc);
      assert.ok(paths.length > 700, `${paths.length} paths`);
      for (const { parts, value } of paths) {
        const path = T.formatPath(parts, format);
        assert.strictEqual(RESOLVE[format](doc, path), value, `${format}: ${path}`);
      }
    });
  }

  test('the tree row path (childPath) matches the JavaScript format', () => {
    for (const { parts } of allPaths(trickyDoc())) {
      let p = '';
      for (const k of parts) p = T.childPath(p, k, typeof k === 'number');
      assert.equal(p, T.formatPath(parts, 'js'));
    }
  });
});

describe('pathLabels, valueAtPath and copyValueText', () => {
  test('breadcrumb labels', () => {
    assert.deepEqual(T.pathLabels(['data', 'users', 2, 'email']), ['root', 'data', 'users', '[2]', 'email']);
    assert.deepEqual(T.pathLabels(['', 'a:b']), ['root', '""', '"a:b"']);
  });

  test('valueAtPath finds every value and only own keys', () => {
    const doc = trickyDoc();
    for (const { parts, value } of allPaths(doc)) assert.strictEqual(T.valueAtPath(doc, parts), value);
    assert.equal(T.valueAtPath({ a: 1 }, ['constructor']), undefined);
    assert.equal(T.valueAtPath({ a: 1 }, ['toString']), undefined);
    assert.equal(T.valueAtPath([1], [1]), undefined);
    assert.equal(T.valueAtPath([1], ['0']), undefined);
    assert.equal(T.valueAtPath({ a: [1] }, ['a', 0, 'x']), undefined);
  });

  test('copyValueText: formatted JSON for containers, raw text for plain values', () => {
    assert.equal(T.copyValueText({ a: [1] }, 2), '{\n  "a": [\n    1\n  ]\n}');
    assert.equal(T.copyValueText([1, 2], '\t'), '[\n\t1,\n\t2\n]');
    assert.equal(T.copyValueText('it\'s "raw"\n'), 'it\'s "raw"\n');
    assert.equal(T.copyValueText(-1.5e-7), '-1.5e-7');
    assert.equal(T.copyValueText(true), 'true');
    assert.equal(T.copyValueText(null), 'null');
  });
});

describe('pathAtOffset and rangeOfPath (Code view)', () => {
  for (const [label, indent] of [['2 spaces', 2], ['tab', '\t'], ['minified', undefined]]) {
    test(`every value can be found by path and by offset (${label})`, () => {
      const doc = trickyDoc();
      const text = JSON.stringify(doc, null, indent);
      for (const { parts, value } of allPaths(doc)) {
        const range = T.rangeOfPath(text, parts);
        assert.ok(range, JSON.stringify(parts));
        assert.deepEqual(JSON.parse(text.slice(range.start, range.end)), JSON.parse(JSON.stringify(value)));
        assert.deepEqual(T.pathAtOffset(text, range.start), parts, 'offset at the value start');
        assert.deepEqual(T.pathAtOffset(text, range.end - 1), parts, 'offset at the value end');
      }
    });
  }

  test('an offset on a key gives the member; on punctuation, the container', () => {
    const text = '{\n  "a": {\n    "b": 1\n  },\n  "c": [10, 20]\n}';
    assert.deepEqual(T.pathAtOffset(text, text.indexOf('"b"')), ['a', 'b']);
    assert.deepEqual(T.pathAtOffset(text, text.indexOf('"b"') + 3), ['a', 'b'], 'the colon after a key');
    assert.deepEqual(T.pathAtOffset(text, text.indexOf('20')), ['c', 1]);
    assert.deepEqual(T.pathAtOffset(text, text.indexOf(', 20')), ['c'], 'comma between items');
    assert.deepEqual(T.pathAtOffset(text, 0), []);
    assert.deepEqual(T.pathAtOffset(text, text.length), [], 'past the end');
  });

  test('rangeOfPath returns null for a missing path', () => {
    assert.equal(T.rangeOfPath('{"a": 1}', ['b']), null);
  });
});

describe('displayKey', () => {
  test('plain keys are shown as is', () => {
    for (const k of ['name', 'with space', 'dash-key', 'été', '1']) assert.equal(T.displayKey(k), k);
  });

  test('unclear keys are quoted', () => {
    assert.equal(T.displayKey(''), '""');
    assert.equal(T.displayKey(' padded '), '" padded "');
    assert.equal(T.displayKey('a:b'), '"a:b"');
    assert.equal(T.displayKey('say "hi"'), '"say \\"hi\\""');
    assert.equal(T.displayKey('tab\there'), '"tab\\there"');
  });
});

describe('scalarView', () => {
  test('text and class for each scalar type', () => {
    assert.deepEqual(T.scalarView('hi', 80), { text: '"hi"', full: '"hi"', cls: 's', truncated: false });
    assert.deepEqual(T.scalarView(-1.5e-7, 80), { text: '-1.5e-7', full: '-1.5e-7', cls: 'n', truncated: false });
    assert.deepEqual(T.scalarView(true, 80), { text: 'true', full: 'true', cls: 'b', truncated: false });
    assert.deepEqual(T.scalarView(null, 80), { text: 'null', full: 'null', cls: 'z', truncated: false });
  });

  test('long strings are cut with an ellipsis and keep the full text', () => {
    const s = 'x'.repeat(200);
    const view = T.scalarView(s, 80);
    assert.equal(view.text, '"' + 'x'.repeat(80) + '…"');
    assert.equal(view.full, JSON.stringify(s));
    assert.equal(view.truncated, true);
  });

  test('cutting never splits an emoji or an escape', () => {
    const emoji = String.fromCodePoint(0x1f600);
    const view = T.scalarView('a'.repeat(79) + emoji + 'tail', 80);
    assert.equal(view.text, '"' + 'a'.repeat(79) + '…"');
    assert.equal(T.scalarView('\n'.repeat(100), 3).text, '"\\n\\n\\n…"');
  });

  test('strings at the limit are not cut', () => {
    assert.equal(T.scalarView('x'.repeat(80), 80).truncated, false);
  });
});

// ---------- esc and highlight ----------

describe('esc', () => {
  test('escapes &, < and >', () => {
    assert.equal(T.esc('a & b <c> d'), 'a &amp; b &lt;c&gt; d');
  });

  test('escapes & first, so existing entities stay literal', () => {
    assert.equal(T.esc('&lt;'), '&amp;lt;');
  });
});

describe('highlight', () => {
  test('wraps each token type in its class', () => {
    const html = T.highlight('{"k": "s", "n": -1.5e3, "t": true, "f": false, "z": null}');
    assert.match(html, /<span class="k">"k"<\/span>: <span class="s">"s"<\/span>/);
    assert.match(html, /<span class="n">-1\.5e3<\/span>/);
    assert.match(html, /<span class="b">true<\/span>/);
    assert.match(html, /<span class="b">false<\/span>/);
    assert.match(html, /<span class="z">null<\/span>/);
  });

  test('leaves only punctuation and whitespace outside token spans', () => {
    const outside = T.highlight(JSON.stringify(SAMPLE, null, 2)).replace(/<span class="[a-z]">.*?<\/span>/g, '');
    assert.match(outside, /^[\s{}[\],:]*$/);
  });

  test('does not highlight words or numbers inside strings', () => {
    const html = T.highlight('{"a": "true null 42"}');
    assert.equal(html, '{<span class="k">"a"</span>: <span class="s">"true null 42"</span>}');
  });

  test('handles escaped quotes and backslashes inside strings', () => {
    const text = JSON.stringify({ 'say "hi"': 'C:\\path\\', q: '"' });
    const html = T.highlight(text);
    assert.equal(visibleText(html), text);
    assert.match(html, /<span class="k">"say \\"hi\\""<\/span>/);
  });

  test('escapes HTML so <script> inside JSON cannot run', () => {
    const text = JSON.stringify({ '<img src=x onerror=alert(1)>': '<script>alert(1)</script>', amp: '&amp;' });
    const html = T.highlight(text);
    assert.ok(!html.includes('<script'), 'no raw <script> tag');
    assert.ok(!html.includes('<img'), 'no raw <img> tag');
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(html.includes('&amp;amp;'), 'existing entities are escaped again');
    // The only tags in the output are the highlighter's own spans.
    assert.deepEqual([...new Set(html.match(/<\/?[a-z]+[^>]*>/g))].sort(),
      ['</span>', '<span class="k">', '<span class="s">'].sort());
    assert.equal(visibleText(html), text);
  });

  test('a string cannot close the highlighter span early', () => {
    const html = T.highlight(JSON.stringify(['</span><b>bold</b>']));
    assert.equal(html, '[<span class="s">"&lt;/span&gt;&lt;b&gt;bold&lt;/b&gt;"</span>]');
  });

  test('unicode and emoji pass through unchanged', () => {
    const text = JSON.stringify({ 'ключ': '😀👍🏽', 'ä日本': ['é', '\u2028'] }, null, 2);
    assert.equal(visibleText(T.highlight(text)), text);
  });

  test('very long strings (400 KB) highlight quickly', () => {
    const text = JSON.stringify({ s: 'x'.repeat(400_000), e: '"'.repeat(100_000) });
    const t0 = performance.now();
    const html = T.highlight(text);
    assert.ok(performance.now() - t0 < 1000, 'under a second');
    assert.equal(visibleText(html), text);
  });

  test('empty input gives empty output', () => {
    assert.equal(T.highlight(''), '');
  });
});

// ---------- describeError ----------

describe('describeError: Chrome / Node (V8)', () => {
  test('message with position and line/column', () => {
    const text = '{"a":1,}';
    assert.deepEqual(T.describeError(new SyntaxError('Expected double-quoted property name in JSON at position 7 (line 1 column 8)'), text),
      { message: 'Expected double-quoted property name', pos: 7, line: 1, col: 8 });
  });

  test('position on a later line is converted to line and column', () => {
    const text = '{\n  "a": 1\n  "b": 2\n}';
    assert.deepEqual(T.describeError(new SyntaxError("Expected ',' or '}' after property value in JSON at position 13 (line 3 column 3)"), text),
      { message: "Expected ',' or '}' after property value", pos: 13, line: 3, col: 3 });
  });

  test('older format: "Unexpected token } in JSON at position N"', () => {
    assert.deepEqual(T.describeError(new SyntaxError('Unexpected token } in JSON at position 5'), '{"a":}'),
      { message: 'Unexpected token }', pos: 5, line: 1, col: 6 });
  });

  test('unexpected end points just past the last character', () => {
    assert.deepEqual(T.describeError(new SyntaxError('Unexpected end of JSON input'), '{"a":'),
      { message: 'Unexpected end of JSON input', pos: 5, line: 1, col: 6 });
  });

  test('trailing content after valid JSON', () => {
    assert.deepEqual(T.describeError(new SyntaxError('Unexpected non-whitespace character after JSON at position 4 (line 1 column 5)'), '[1] x'),
      { message: 'Unexpected non-whitespace character after JSON', pos: 4, line: 1, col: 5 });
  });

  test('current format "Unexpected token \'}\', "…" is not valid JSON" gets a location from the scanner', () => {
    const text = '{"a":}';
    const e = new SyntaxError('Unexpected token \'}\', "{"a":}" is not valid JSON');
    assert.deepEqual(T.describeError(e, text), { message: "Unexpected token '}'", pos: 5, line: 1, col: 6 });
  });

  test('the slice of input in the message is not repeated, even with quotes and ellipses', () => {
    const text = '{\n  "name": "Widget",\n  "tags": ["a", "b",],\n  "price": 9.5\n}';
    const e = new SyntaxError('Unexpected token \']\', ..."["a", "b",],\n  "pric"... is not valid JSON');
    assert.deepEqual(T.describeError(e, text), { message: "Unexpected token ']'", pos: 42, line: 3, col: 21 });
    assert.equal(text[42], ']');
  });

  test('real errors thrown by this Node version always get a location', () => {
    for (const text of ['', ' ', '{', '{"a":}', '{"a":', '{a:1}', '[1] x', '{"a":1,}', '[1,,2]', '"\\x"', 'tru', '{"a":1\n"b":2}', '01', '[1,]', "{'a':1}"]) {
      const d = T.describeError(parseError(text), text);
      assert.ok(d.message && d.message.length > 0, `message for ${JSON.stringify(text)}`);
      assert.ok(!/is not valid JSON/.test(d.message), `no repeated input for ${JSON.stringify(text)}: ${d.message}`);
      assert.match(d.message, /^[A-Z]/, `capitalized: ${d.message}`);
      assert.notEqual(d.pos, null, `position for ${JSON.stringify(text)}`);
      assert.ok(d.pos >= 0 && d.pos <= text.length, `pos in range for ${JSON.stringify(text)}`);
      assert.ok(d.line >= 1 && d.col >= 1, `line/col for ${JSON.stringify(text)}`);
    }
  });

  test('empty input is reported at line 1, column 1', () => {
    assert.deepEqual(T.describeError(parseError(''), ''), { message: 'Unexpected end of JSON input', pos: 0, line: 1, col: 1 });
  });
});

describe('describeError: Firefox (SpiderMonkey)', () => {
  test('line/column message is converted to a position, first letter capitalized', () => {
    assert.deepEqual(T.describeError(new SyntaxError("JSON.parse: expected property name or '}' at line 1 column 2 of the JSON data"), '{a:1}'),
      { message: "Expected property name or '}'", pos: 1, line: 1, col: 2 });
  });

  test('multi-line position', () => {
    const text = '{\n  "a": 1\n  "b": 2\n}';
    const d = T.describeError(new SyntaxError("JSON.parse: expected ',' or '}' after property value in object at line 3 column 3 of the JSON data"), text);
    assert.deepEqual(d, { message: "Expected ',' or '}' after property value in object", pos: 13, line: 3, col: 3 });
    assert.equal(text[d.pos], '"');
  });

  test('unexpected end of data', () => {
    assert.deepEqual(T.describeError(new SyntaxError('JSON.parse: unexpected end of data at line 1 column 6 of the JSON data'), '{"a":'),
      { message: 'Unexpected end of data', pos: 5, line: 1, col: 6 });
  });
});

describe('describeError: Safari (JavaScriptCore)', () => {
  test('"JSON Parse error:" prefix is removed', () => {
    assert.equal(T.describeError(new SyntaxError('JSON Parse error: Unexpected identifier "x"'), 'x').message, 'Unexpected identifier "x"');
  });

  test('messages without a position get a location from the scanner', () => {
    assert.deepEqual(T.describeError(new SyntaxError('JSON Parse error: Unexpected identifier "x"'), '[1, x]'),
      { message: 'Unexpected identifier "x"', pos: 4, line: 1, col: 5 });
    assert.deepEqual(T.describeError(new SyntaxError("JSON Parse error: Expected '}'"), '{"a":1'),
      { message: "Expected '}'", pos: 6, line: 1, col: 7 });
  });

  test('"Unexpected EOF" points to the end of the input', () => {
    assert.deepEqual(T.describeError(new SyntaxError('JSON Parse error: Unexpected EOF'), '{"a":'),
      { message: 'Unexpected EOF', pos: 5, line: 1, col: 6 });
  });
});

describe('describeError: other inputs', () => {
  test('non-Error values are turned into a message', () => {
    assert.equal(T.describeError('boom', '{').message, 'Boom');
    assert.equal(T.describeError(null, '{').message, 'Null');
  });

  test('an error with an empty message falls back to its name', () => {
    assert.equal(T.describeError(new SyntaxError(''), '{').message, 'SyntaxError');
  });

  test('a message that is only location details falls back to "Invalid JSON"', () => {
    assert.equal(T.describeError(new SyntaxError('at position 3'), '{"a').message, 'Invalid JSON');
  });

  test('positions with unicode and emoji before the error', () => {
    const text = '{"😀": "é",\n "k": }';
    const d = T.describeError(new SyntaxError('Unexpected token } in JSON at position ' + text.indexOf('}')), text);
    assert.equal(d.line, 2);
    assert.equal(d.col, 7);
  });
});

// ---------- findSyntaxError (scanner used when the browser gives no position) ----------

describe('findSyntaxError', () => {
  // [description, input, expected message, expected offset]; line/col are checked from the offset.
  const CASES = [
    // missing commas
    ['missing comma between properties', '{"a":1 "b":2}', "Missing ',' or '}' after a property value", 7],
    ['missing comma between array items', '[1 2]', "Missing ',' or ']' after an array item", 3],
    ['missing comma on the next line', '{\n  "a": 1\n  "b": 2\n}', "Missing ',' or '}' after a property value", 13],
    ['missing comma between objects', '[{"a":1}{"b":2}]', "Missing ',' or ']' after an array item", 8],
    // trailing commas
    ['trailing comma in array', '[1,2,]', "Trailing comma before ']'", 5],
    ['trailing comma in object', '{"a":1,}', "Trailing comma before '}'", 7],
    ['trailing comma before a newline', '{\n  "a": 1,\n}', "Trailing comma before '}'", 12],
    ['double comma', '[1,,2]', "Unexpected ',' where a value was expected", 3],
    // unclosed strings
    ['unclosed string at end of input', '{"a": "abc', 'Unterminated string', 10],
    ['line break inside a string', '{"a": "ab\ncd"}', 'Unterminated string (line break inside string)', 9],
    ['unclosed key', '{"a', 'Unterminated string', 3],
    ['raw tab inside a string', '["a\tb"]', 'Control character in string (use an escape such as \\t)', 3],
    // unclosed braces and brackets
    ['unclosed object', '{"a":1', "Unexpected end of input (missing '}')", 6],
    ['unclosed array', '[[1,2]', "Unexpected end of input (missing ']')", 6],
    ['unclosed nested object', '{"a":{"b":[1,2]}', "Unexpected end of input (missing '}')", 16],
    ['wrong closing bracket', '[1}', "Missing ',' or ']' after an array item", 2],
    ['extra closing brace', '{"a":1}}', "Unexpected '}' after the end of the JSON value", 7],
    // bad escapes
    ['unknown escape', '{"a": "\\x"}', "Bad escape '\\x' in string", 7],
    ['short unicode escape', '["\\u12"]', 'Bad unicode escape (\\u needs 4 hex digits)', 2],
    ['non-hex unicode escape', '{"a":"\\u12g4"}', 'Bad unicode escape (\\u needs 4 hex digits)', 6],
    // single quotes
    ['single-quoted key', "{'a':1}", 'Property names must use double quotes', 1],
    ['single-quoted value', "{\"a\":'b'}", 'Strings must use double quotes', 5],
    ['unquoted key', '{a:1}', 'Expected a property name in double quotes', 1],
    // leading zeros and other number errors
    ['leading zero', '[01]', 'Leading zeros are not allowed in numbers', 1],
    ['negative leading zero', '{"n":-007}', 'Leading zeros are not allowed in numbers', 5],
    ['lone minus', '[-]', "Expected a digit after '-'", 2],
    ['decimal point without digits', '[1.]', 'Expected a digit after the decimal point', 3],
    ['exponent without digits', '[1e+]', 'Expected a digit in the exponent', 4],
    ['plus sign', '[+1]', "Unexpected '+' where a value was expected", 1],
    // unexpected end of input
    ['empty input', '', 'Unexpected end of input', 0],
    ['only whitespace', ' \n ', 'Unexpected end of input', 3],
    ['end after colon', '{"a":', "Unexpected end of input (missing '}')", 5],
    ['end after comma', '[1,', "Unexpected end of input (missing ']')", 3],
    ['cut-off literal', '{"a":tru', "Unexpected end of input (missing '}')", 8],
    // other
    ['missing colon', '{"a" 1}', "Expected ':' after the property name", 5],
    ['misspelled literal', '[nul]', "Unexpected 'n' where a value was expected", 1],
    ['text after the value', '[1] 2', "Unexpected '2' after the end of the JSON value", 4],
    ['unicode before the error', '{"ключ": "😀",\n "k": }', "Unexpected '}' where a value was expected", 21],
  ];

  for (const [name, text, message, pos] of CASES) {
    test(name, () => {
      const before = text.slice(0, pos).split('\n');
      const expected = { message, pos, line: before.length, col: before[before.length - 1].length + 1 };
      assert.deepEqual(T.findSyntaxError(text), expected);
      assert.throws(() => JSON.parse(text), SyntaxError, 'the input really is invalid');
    });
  }

  test('returns null for valid JSON of every kind', () => {
    const valid = ['0', '-0', '1e10', '-1.5E-7', '"text"', 'true', 'false', 'null', '[]', '{}', ' [ ] ',
      '{"a":[1,{"b":null}],"c":-0.5e+3}', '"\\"\\\\\\/\\b\\f\\n\\r\\t\\u00e9"', '{"ключ":"😀👍🏽"}', '\r\n{\t"a" : 1 }\r\n',
      JSON.stringify(SAMPLE), JSON.stringify(SAMPLE, null, '\t'), JSON.stringify({ s: 'x'.repeat(500_000) })];
    for (const text of valid) {
      assert.doesNotThrow(() => JSON.parse(text));
      assert.equal(T.findSyntaxError(text), null, JSON.stringify(text).slice(0, 60));
    }
  });

  test('handles 100,000 levels of nesting', () => {
    assert.equal(T.findSyntaxError(deepArray(100000)), null);
    const unclosed = deepArray(100000).slice(0, -1);
    assert.deepEqual(T.findSyntaxError(unclosed), { message: "Unexpected end of input (missing ']')", pos: 199999, line: 1, col: 200000 });
  });

  test('agrees with JSON.parse on thousands of randomly broken inputs', () => {
    // Small seeded random generator so failures are reproducible.
    let seed = 12345;
    const rand = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const base = JSON.stringify(SAMPLE, null, 2);
    const pieces = ['{', '}', '[', ']', ',', ':', '"', "'", '\\', ' ', '\n', '0', '-', '.', 'e', 'x', 'n', 't'];
    for (let round = 0; round < 3000; round++) {
      let text = base;
      for (let edits = 1 + rand(3); edits > 0; edits--) {
        const at = rand(text.length + 1);
        const kind = rand(3);
        if (kind === 0) text = text.slice(0, at) + text.slice(at + 1);                       // delete a character
        else if (kind === 1) text = text.slice(0, at) + pieces[rand(pieces.length)] + text.slice(at); // insert one
        else text = text.slice(0, at) + pieces[rand(pieces.length)] + text.slice(at + 1);    // replace one
      }
      let valid = true;
      try { JSON.parse(text); } catch { valid = false; }
      const found = T.findSyntaxError(text);
      assert.equal(found === null, valid, `round ${round}: ${JSON.stringify(text)}`);
      if (found) assert.ok(found.pos >= 0 && found.pos <= text.length);
    }
  });
});

// ---------- repairJson ----------

// Characters built from code points so the source stays plain ASCII.
const BOM = String.fromCharCode(0xfeff), NBSP = String.fromCharCode(0xa0), ZWSP = String.fromCharCode(0x200b);
const LDQ = String.fromCharCode(0x201c), RDQ = String.fromCharCode(0x201d);
const LSQ = String.fromCharCode(0x2018), RSQ = String.fromCharCode(0x2019);

// Repairs, checks the result parses, and returns { value, text, types }.
function repaired(input) {
  const r = T.repairJson(input);
  assert.equal(r.ok, true, `should repair ${JSON.stringify(input)}: ${r.error}`);
  return { value: JSON.parse(r.text), text: r.text, types: r.changes.map(c => c.type), r };
}

describe('repairJson: each repair type', () => {
  test('trailing commas in objects and arrays', () => {
    const { value, types, text } = repaired('{"a": [1, 2,], "b": {"c": 3,},}');
    assert.deepEqual(value, { a: [1, 2], b: { c: 3 } });
    assert.deepEqual(types, ['trailing-comma', 'trailing-comma', 'trailing-comma']);
    assert.equal(text, '{"a": [1, 2], "b": {"c": 3}}');
  });

  test('trailing comma followed by a newline and a comment', () => {
    assert.deepEqual(repaired('[\n  1,\n  2, // last\n]').value, [1, 2]);
  });

  test('single-quoted strings and keys become double-quoted', () => {
    const { value, types } = repaired("{'name': 'Widget', 'tags': ['a', 'b']}");
    assert.deepEqual(value, { name: 'Widget', tags: ['a', 'b'] });
    assert.ok(types.every(t => t === 'single-quote'));
    assert.equal(types.length, 5); // name, Widget, tags, a, b
  });

  test('double quotes inside single-quoted strings are escaped', () => {
    assert.deepEqual(repaired(`{'say': 'he said "hi"'}`).value, { say: 'he said "hi"' });
  });

  test("escaped \\' inside single-quoted strings becomes a plain apostrophe", () => {
    assert.deepEqual(repaired("['it\\'s', 'a\\\\b', 'line\\nbreak']").value, ["it's", 'a\\b', 'line\nbreak']);
  });

  test("an apostrophe inside a single-quoted string is kept ('it's')", () => {
    assert.deepEqual(repaired("{'text': 'it's here', 'n': 1}").value, { text: "it's here", n: 1 });
  });

  test('unquoted keys', () => {
    const { value, types, text } = repaired('{name: "x", $id: 1, _private: true, 2: "two", camelCase9: null}');
    assert.deepEqual(value, { name: 'x', $id: 1, _private: true, 2: 'two', camelCase9: null });
    assert.equal(types.filter(t => t === 'unquoted-key').length, 5);
    assert.equal(text, '{"name": "x", "$id": 1, "_private": true, "2": "two", "camelCase9": null}');
  });

  test('// line and /* block */ comments are removed', () => {
    const input = '// header\n{\n  "a": 1, // trailing note\n  /* block\n     over lines */ "b": 2\n}';
    const { value, types } = repaired(input);
    assert.deepEqual(value, { a: 1, b: 2 });
    assert.deepEqual(types, ['comment', 'comment', 'comment']);
  });

  test('removing comments leaves no blank lines or trailing spaces', () => {
    const input = '// header\n{\n  // own line\n  "a": 1, // after a value\n  /* own line */\n  "b": [1, /* inline */ 2]\n}\n// footer';
    assert.equal(repaired(input).text, '{\n  "a": 1,\n  "b": [1, 2]\n}\n');
  });

  test('a comment with Windows line endings is removed with its line', () => {
    assert.equal(repaired('{\r\n  // note\r\n  "a": 1\r\n}').text, '{\r\n  "a": 1\r\n}');
  });

  test('curly double and single quotes used as string quotes', () => {
    const input = `{${LDQ}title${RDQ}: ${LDQ}Hello${RDQ}, ${LSQ}note${RSQ}: ${LSQ}it${RSQ}s fine${RSQ}}`;
    const { value, types } = repaired(input);
    assert.deepEqual(value, { title: 'Hello', note: `it${RSQ}s fine` });
    assert.deepEqual(types, ['smart-quote', 'smart-quote', 'smart-quote', 'smart-quote']);
  });

  test('curly quotes mixed with a straight closing quote', () => {
    assert.deepEqual(repaired(`[${LDQ}mixed"]`).value, ['mixed']);
  });

  test('Python True/False/None become true/false/null', () => {
    const { value, r } = repaired('{"a": True, "b": False, "c": None}');
    assert.deepEqual(value, { a: true, b: false, c: null });
    assert.deepEqual(r.changes.map(c => c.detail), ['True \u2192 true', 'False \u2192 false', 'None \u2192 null']);
  });

  test('JavaScript undefined, NaN, Infinity and -Infinity become null', () => {
    assert.deepEqual(repaired('[undefined, NaN, Infinity, -Infinity, 1]').value, [null, null, null, null, 1]);
  });

  test('a byte order mark at the start is removed', () => {
    const { value, text, types } = repaired(BOM + '{"a": 1}');
    assert.deepEqual(value, { a: 1 });
    assert.equal(text, '{"a": 1}');
    assert.deepEqual(types, ['bom']);
  });

  test('stray non-JSON whitespace at the start (and elsewhere) is removed', () => {
    const { value, text, types } = repaired(NBSP + ZWSP + '{"a":' + NBSP + '1}');
    assert.deepEqual(value, { a: 1 });
    assert.equal(text, '{"a": 1}');
    assert.deepEqual(types, ['whitespace', 'whitespace', 'whitespace']);
  });

  test('missing commas between items on separate lines', () => {
    const { value, text, types } = repaired('{\n  "a": 1\n  "b": [\n    1\n    2\n  ]\n  "c": {"d": 1}\n  "e": "x"\n}');
    assert.deepEqual(value, { a: 1, b: [1, 2], c: { d: 1 }, e: 'x' });
    assert.equal(types.filter(t => t === 'missing-comma').length, 4);
    assert.equal(text, '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ],\n  "c": {"d": 1},\n  "e": "x"\n}');
  });

  test('missing comma before an unquoted key on the next line', () => {
    assert.deepEqual(repaired('{\n  a: 1\n  b: 2\n}').value, { a: 1, b: 2 });
  });
});

describe('repairJson: positions and summary', () => {
  const MIXED = "{\n  // settings\n  name: 'Widget',\n  tags: ['a', 'b',],\n  active: True\n  price: 9.50,\n}";

  test('reports the line and column of each change in the original text', () => {
    const r = T.repairJson(MIXED);
    assert.equal(r.ok, true);
    assert.deepEqual(r.changes.map(c => `${c.type}@${c.line}:${c.col}`), [
      'comment@2:3', 'unquoted-key@3:3', 'single-quote@3:9', 'unquoted-key@4:3', 'single-quote@4:10', 'single-quote@4:15',
      'trailing-comma@4:18', 'unquoted-key@5:3', 'value@5:11', 'missing-comma@5:15', 'unquoted-key@6:3', 'trailing-comma@6:14']);
  });

  test('mixed problems: value, summary and exact text', () => {
    const r = T.repairJson(MIXED);
    assert.deepEqual(JSON.parse(r.text), { name: 'Widget', tags: ['a', 'b'], active: true, price: 9.5 });
    assert.ok(r.text.includes('"price": 9.50'), 'number written exactly as before');
    assert.equal(r.summary, 'Fixed: 2 trailing commas, 1 missing comma added, 3 single-quoted strings, 4 unquoted keys, ' +
      '1 Python/JavaScript value, 1 comment removed.');
  });

  test('mixed problems from a JavaScript object literal', () => {
    const input = "/* config */ {debug: false, retries: 3, hosts: ['a.example', \"b.example\",], timeout: undefined,}";
    assert.deepEqual(repaired(input).value, { debug: false, retries: 3, hosts: ['a.example', 'b.example'], timeout: null });
  });

  test('mixed problems from a Python dict', () => {
    const input = "{'id': 7, 'ok': True, 'tags': ('x'), 'meta': None}".replace("('x')", "['x',]");
    assert.deepEqual(repaired(input).value, { id: 7, ok: true, tags: ['x'], meta: null });
  });

  test('summarizeRepairs uses singular and plural labels in a fixed order', () => {
    const ch = types => types.map(type => ({ type }));
    assert.equal(T.summarizeRepairs(ch(['comment', 'trailing-comma', 'trailing-comma', 'trailing-comma', 'single-quote', 'single-quote'])),
      'Fixed: 3 trailing commas, 2 single-quoted strings, 1 comment removed.');
    assert.equal(T.summarizeRepairs(ch(['bom'])), 'Fixed: 1 byte order mark removed.');
    assert.equal(T.summarizeRepairs([]), '');
  });
});

describe('repairJson: string contents are never changed', () => {
  const tricky = {
    url: 'http://example.com/path?q=1#frag',
    apostrophe: "it's",
    slashes: 'a // not a comment',
    block: 'a /* not */ a comment',
    quotes: 'say "hi"',
    backslash: 'C:\\temp\\',
    curly: `${LDQ}quoted${RDQ} and ${LSQ}single${RSQ}`,
    words: 'True None undefined NaN Infinity',
    commas: 'a,} b,] c',
    unicode: '\u00e9\u65e5\u672c ' + String.fromCodePoint(0x1f600),
    bom: BOM + 'inside'
  };

  test('double-quoted strings pass through untouched while other parts are repaired', () => {
    const input = JSON.stringify(tricky, null, 2).replace(/\n}$/, ',\n  // done\n}');
    const { value, types } = repaired(input);
    assert.deepEqual(value, tricky);
    // The comment comes before the closing brace, so it is recorded before the comma is known to be trailing.
    assert.deepEqual(types, ['comment', 'trailing-comma']);
  });

  test('the repaired text keeps every string exactly as written', () => {
    const input = JSON.stringify(tricky).replace(/}$/, ',}');
    const { text } = repaired(input);
    for (const v of Object.values(tricky)) assert.ok(text.includes(JSON.stringify(v)), JSON.stringify(v));
  });

  test('keys that look like comments or words are kept', () => {
    assert.deepEqual(repaired('{"//": 1, "/*x*/": 2, "None": 3,}').value, { '//': 1, '/*x*/': 2, None: 3 });
  });

  test('escaped quotes inside strings do not end the string', () => {
    assert.deepEqual(repaired('{"a": "x\\"y, // z", }').value, { a: 'x"y, // z' });
    assert.deepEqual(repaired("{'a': 'x\\'y, // z', }").value, { a: "x'y, // z" });
  });
});

describe('repairJson: numbers, order and valid input', () => {
  test('number precision and spelling are kept exactly', () => {
    const { text } = repaired('{"big": 12345678901234567890123, "f": 1.10, "e": 1E+5, "neg": -0.000, "pi": 3.14159265358979323846,}');
    assert.equal(text, '{"big": 12345678901234567890123, "f": 1.10, "e": 1E+5, "neg": -0.000, "pi": 3.14159265358979323846}');
  });

  test('key order is kept', () => {
    assert.deepEqual(Object.keys(repaired("{z: 1, 'a': 2, m: 3,}").value), ['z', 'a', 'm']);
  });

  test('already-valid JSON comes back unchanged', () => {
    for (const text of ['{}', '[]', '0', '"x"', ' [ 1 ,2 ] ', JSON.stringify(SAMPLE, null, 2), '{"a":"// not a comment, it\'s"}', '\n\t{"a": [1.10]}\n']) {
      const r = T.repairJson(text);
      assert.deepEqual({ ok: r.ok, changed: r.changed, text: r.text, changes: r.changes }, { ok: true, changed: false, text, changes: [] });
    }
  });
});

describe('repairJson: input that cannot be repaired', () => {
  const CANNOT = [
    ['missing comma on the same line (ambiguous)', '[1 2]'],
    ['bare word value', '{"a": hello}'],
    ['unterminated double-quoted string', '{"a": "unterminated'],
    ['unterminated single-quoted string', "{'a': 'unterminated"],
    ['unterminated block comment', '{"a": 1} /* open'],
    ['unclosed object', '{a: 1'],
    ['mismatched brackets', '[1}'],
    ['two top-level values', '{"a": 1} {"b": 2}'],
    ['double comma', '[1,,2]'],
    ['leading plus sign', '[+1]'],
    ['empty input', ''],
  ];
  for (const [name, input] of CANNOT) {
    test(name, () => {
      const r = T.repairJson(input);
      assert.equal(r.ok, false);
      assert.equal(r.text, input, 'input returned unchanged');
      assert.equal(r.changed, false);
      assert.deepEqual(r.changes, []);
      assert.equal(typeof r.error, 'string');
      assert.ok(r.error.length > 0);
    });
  }
});

describe('repairJson: fuzz', () => {
  test('valid JSON broken in the supported ways repairs back to the same value', () => {
    let seed = 2024;
    const rand = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const chance = p => rand(1000) < p * 1000;
    const pick = list => list[rand(list.length)];
    const STRINGS = ['plain', "it's", 'say "hi"', 'http://x.com/a//b', 'a /* b */ c', 'back\\slash', 'tab\there', 'line\nbreak',
      '\u00e9t\u00e9', 'emoji ' + String.fromCodePoint(0x1f600), 'True', 'null', '', ' spaced ', 'comma, colon: brace}'];
    const KEYS = ['id', 'name', '$ref', '_x', 'camelCase', 'with space', 'dash-key', "o'k", 'n1'];

    function makeValue(depth) {
      const r = rand(depth > 3 ? 4 : 6);
      if (r === 0) return pick(STRINGS);
      if (r === 1) return pick([0, 1, -5, 3.25, 1e21, -0.5, 12345678]);
      if (r === 2) return pick([true, false]);
      if (r === 3) return null;
      if (r === 4) return Array.from({ length: rand(4) }, () => makeValue(depth + 1));
      const o = {};
      for (let k = rand(4); k > 0; k--) o[pick(KEYS) + (k > 1 ? k : '')] = makeValue(depth + 1);
      return o;
    }

    // JSON string body (without quotes) re-escaped for a single-quoted string.
    function singleQuoted(s) {
      const inner = JSON.stringify(s).slice(1, -1);
      let out = '';
      for (let i = 0; i < inner.length; i++) {
        if (inner[i] === '\\') { const pair = inner.slice(i, i + 2); out += pair === '\\"' ? '"' : pair; i++; }
        else out += inner[i] === "'" ? "\\'" : inner[i];
      }
      return "'" + out + "'";
    }
    function stringToken(s, isKey) {
      if (isKey && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s) && chance(0.3)) return s;          // unquoted key
      const style = rand(4);
      if (style === 1) return singleQuoted(s);
      if (style === 2 && !/[\u2018\u2019\u201c\u201d]/.test(s)) return LDQ + JSON.stringify(s).slice(1, -1) + RDQ;
      if (style === 3 && !/[\u2018\u2019\u201c\u201d]/.test(s)) return LSQ + JSON.stringify(s).slice(1, -1) + RSQ;
      return JSON.stringify(s);
    }
    function brokenText(v, indent) {
      const pad = '  '.repeat(indent + 1), end = '  '.repeat(indent);
      if (v === null) return pick(['null', 'None', 'undefined', 'NaN', 'Infinity', '-Infinity']);
      if (v === true) return pick(['true', 'True']);
      if (v === false) return pick(['false', 'False']);
      if (typeof v === 'number') return JSON.stringify(v);
      if (typeof v === 'string') return stringToken(v, false);
      const isArr = Array.isArray(v);
      const items = isArr ? v.map(x => brokenText(x, indent + 1))
        : Object.entries(v).map(([k, x]) => stringToken(k, true) + ': ' + brokenText(x, indent + 1));
      if (!items.length) return isArr ? '[]' : '{}';
      let body = '';
      items.forEach((item, idx) => {
        if (chance(0.15)) body += pad + '/* note */\n';
        body += pad + item;
        const last = idx === items.length - 1;
        if (!last) body += chance(0.25) ? '' : ',';            // missing comma (always followed by a newline)
        else if (chance(0.3)) body += ',';                      // trailing comma
        if (chance(0.15)) body += ' // comment';
        body += '\n';
      });
      return (isArr ? '[' : '{') + '\n' + body + end + (isArr ? ']' : '}');
    }

    let repairedCount = 0;
    for (let round = 0; round < 1500; round++) {
      const original = { root: makeValue(0), list: [makeValue(1), makeValue(1)] };
      let text = brokenText(original, 0);
      if (chance(0.1)) text = BOM + text;
      if (chance(0.1)) text = NBSP + text;
      const r = T.repairJson(text);
      assert.equal(r.ok, true, `round ${round} should repair:\n${text}\n${r.error}`);
      assert.deepEqual(JSON.parse(r.text), original, `round ${round}:\n${text}`);
      if (r.changed) repairedCount++;
    }
    assert.ok(repairedCount > 1400, `most rounds needed repairs (${repairedCount})`);
  });
});
