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
    'countLines', 'lineNumbers', 'gutterDigits', 'highlight']) {
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
