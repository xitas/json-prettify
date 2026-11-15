// Unit tests for assets/js/json-tools.js. Run with: node --test
//
// Tests marked { todo } describe the correct behavior for a known bug. They run and are
// reported as TODO, but do not fail the suite until the bug is fixed.

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
  for (const name of ['fmtBytes', 'byteLen', 'esc', 'describeError', 'sortKeys', 'measure', 'kindOf', 'highlight']) {
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

  test('keeps a "__proto__" key from the JSON data', { todo: 'BUG: sortKeys drops a "__proto__" key (it sets the prototype instead)' }, () => {
    const out = T.sortKeys(JSON.parse('{"b":1,"__proto__":{"x":1}}'));
    assert.equal(JSON.stringify(out), '{"__proto__":{"x":1},"b":1}');
  });

  test('handles 1,000 levels of nesting', () => {
    assert.ok(T.sortKeys(JSON.parse(deepArray(1000))));
  });

  test('handles very deep nesting (10,000 levels) without crashing', { todo: 'BUG: recursion overflows the stack at a few thousand levels' }, () => {
    assert.doesNotThrow(() => T.sortKeys(JSON.parse(deepArray(10000))));
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

  test('handles very deep nesting (10,000 levels) without crashing', { todo: 'BUG: recursion overflows the stack at a few thousand levels' }, () => {
    assert.deepEqual(T.measure(JSON.parse(deepArray(10000))), { keys: 0, depth: 9999 });
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

  test('just under 1 MB rounds up to 1.00 MB, not 1024.0 KB', { todo: 'BUG: 1048064–1048575 bytes show as "1024.0 KB"' }, () => {
    assert.equal(T.fmtBytes(1048575), '1.00 MB');
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

  test('current format "Unexpected token \'}\', "…" is not valid JSON" gives a location',
    { todo: 'BUG: current Chrome/Node messages have no position, so no line/column or "Go to error"' }, () => {
      const text = '{"a":}';
      const e = new SyntaxError('Unexpected token \'}\', "{"a":}" is not valid JSON');
      assert.deepEqual(T.describeError(e, text), { message: "Unexpected token '}'", pos: 5, line: 1, col: 6 });
    });

  test('real errors thrown by this Node version are described sensibly', () => {
    for (const text of ['', ' ', '{', '{"a":}', '{"a":', '{a:1}', '[1] x', '{"a":1,}', '[1,,2]', '"\\x"', 'tru', '{"a":1\n"b":2}', '01']) {
      const d = T.describeError(parseError(text), text);
      assert.ok(d.message && d.message.length > 0, `message for ${JSON.stringify(text)}`);
      if (d.pos !== null) {
        assert.ok(d.pos >= 0 && d.pos <= text.length, `pos in range for ${JSON.stringify(text)}`);
        assert.ok(d.line >= 1 && d.col >= 1, `line/col for ${JSON.stringify(text)}`);
      }
    }
  });

  test('empty input is reported at line 1, column 1', () => {
    assert.deepEqual(T.describeError(parseError(''), ''), { message: 'Unexpected end of JSON input', pos: 0, line: 1, col: 1 });
  });
});

describe('describeError: Firefox (SpiderMonkey)', () => {
  test('line/column message is converted to a position', () => {
    assert.deepEqual(T.describeError(new SyntaxError("JSON.parse: expected property name or '}' at line 1 column 2 of the JSON data"), '{a:1}'),
      { message: "expected property name or '}'", pos: 1, line: 1, col: 2 });
  });

  test('multi-line position', () => {
    const text = '{\n  "a": 1\n  "b": 2\n}';
    const d = T.describeError(new SyntaxError("JSON.parse: expected ',' or '}' after property value in object at line 3 column 3 of the JSON data"), text);
    assert.deepEqual(d, { message: "expected ',' or '}' after property value in object", pos: 13, line: 3, col: 3 });
    assert.equal(text[d.pos], '"');
  });

  test('unexpected end of data', () => {
    assert.deepEqual(T.describeError(new SyntaxError('JSON.parse: unexpected end of data at line 1 column 6 of the JSON data'), '{"a":'),
      { message: 'unexpected end of data', pos: 5, line: 1, col: 6 });
  });

  test('message starts with a capital letter like other browsers', { todo: 'Minor: Firefox messages stay lowercase ("expected property name…")' }, () => {
    const d = T.describeError(new SyntaxError("JSON.parse: expected property name or '}' at line 1 column 2 of the JSON data"), '{a:1}');
    assert.equal(d.message, "Expected property name or '}'");
  });
});

describe('describeError: Safari (JavaScriptCore)', () => {
  test('messages without a position do not crash and keep pos null', () => {
    const d = T.describeError(new SyntaxError("JSON Parse error: Expected '}'"), '{"a":1');
    assert.equal(d.pos, null);
    assert.equal(d.line, null);
    assert.ok(d.message.includes("Expected '}'"));
  });

  test('"JSON Parse error:" prefix is removed', { todo: 'BUG: Safari messages keep the "JSON Parse error: " prefix' }, () => {
    assert.equal(T.describeError(new SyntaxError('JSON Parse error: Unexpected identifier "x"'), 'x').message, 'Unexpected identifier "x"');
  });

  test('"Unexpected EOF" points to the end of the input', { todo: 'BUG: Safari "Unexpected EOF" is not recognized as end of input' }, () => {
    assert.deepEqual(T.describeError(new SyntaxError('JSON Parse error: Unexpected EOF'), '{"a":'),
      { message: 'Unexpected EOF', pos: 5, line: 1, col: 6 });
  });
});

describe('describeError: other inputs', () => {
  test('non-Error values are turned into a message', () => {
    assert.equal(T.describeError('boom', '{').message, 'boom');
    assert.equal(T.describeError(null, '{').message, 'null');
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
