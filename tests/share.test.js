// Unit tests for share links (encodeShare, encodeCompareShare, decodeShare): the JSON travels
// inside the link.
// Run with: node --test
//
// These tests are in their own file, so they run in their own process. They drive Node's
// CompressionStream and DecompressionStream (zlib), and after that work Node 24 has been seen
// to lose the SyntaxError of a later JSON.parse call in the same process, which then returns
// the part it parsed as if the input were valid. That broke the exact JSON.parse comparisons
// in json-tools.test.js about once in a few hundred runs, so keep stream tests here, away from
// the tests that rely on invalid JSON being rejected.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../assets/js/json-tools.js');

const SAMPLE = {
  service: 'inventory-api', version: 3, healthy: true, deprecated: false, owner: null,
  limits: { maxItems: 500, ratio: 0.75, threshold: -12.5, big: 1.2e6 },
  regions: ['eu-west', 'us-east'],
  items: [{ sku: 'KB-104', price: 89.5, tags: ['keyboard'] }, { sku: 'MS-220', price: 24.99, tags: [] }],
  notes: 'Ships in 2 days, "fragile" items wrapped'
};

describe('share links', () => {
  const SMILE = String.fromCodePoint(0x1f600);
  const SAMPLES = [
    '', '{}', '{"a":1}', JSON.stringify(SAMPLE, null, 2),
    '  \n\t{ "spaced" :  [ 1 ,2 ] }\r\n\n  ',                         // whitespace kept exactly
    '{"été":"日本語 ' + SMILE + '👍🏽"}', // unicode and emoji
    String.fromCharCode(0xfeff) + '{"bom":true}',                           // a leading BOM survives
    '{"broken": [1, 2,, }',                                               // invalid JSON is fine too
    '{"s":"' + 'x'.repeat(300000) + '"}',                                 // very long string
    '<script>alert(1)</script>',
  ];

  test('crc32 matches known values', () => {
    const bytes = s => new TextEncoder().encode(s);
    assert.equal(T.crc32(bytes('')), '00000000');
    assert.equal(T.crc32(bytes('123456789')), 'cbf43926');
    assert.equal(T.crc32(bytes('The quick brown fox jumps over the lazy dog')), '414fa339');
  });

  test('base64url round trip, no padding or + / characters', () => {
    for (let n = 0; n < 70; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n * 11) & 255);
      const s = T.base64urlEncode(bytes);
      assert.match(s, /^[A-Za-z0-9_-]*$/);
      assert.deepEqual(T.base64urlDecode(s), bytes);
    }
    assert.equal(T.base64urlDecode('ab+c'), null);
    assert.equal(T.base64urlDecode('abcde'), null, 'impossible length');
  });

  for (const compress of [true, false]) {
    const kind = compress ? 'compressed (j1)' : 'uncompressed (u1)';
    test(`encoding then decoding gives back exactly the same text: ${kind}`, async () => {
      for (const text of SAMPLES) {
        const hash = await T.encodeShare(text, null, { compress });
        assert.ok(hash.startsWith(compress ? 'j1=' : 'u1='), hash.slice(0, 5));
        assert.match(hash, /^[ju]1=[0-9a-f]{8}\.[A-Za-z0-9_-]*$/);
        const r = await T.decodeShare('#' + hash);
        assert.equal(r.ok, true);
        assert.equal(r.text, text);
        assert.equal(r.compressed, compress);
        assert.deepEqual(r.settings, {});
      }
    });
  }

  test('compression makes typical JSON links much shorter', async () => {
    const text = JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ id: i, name: 'item-' + i, ok: true })), null, 2);
    const j = await T.encodeShare(text, null, { compress: true });
    const u = await T.encodeShare(text, null, { compress: false });
    assert.ok(j.length * 5 < u.length, `${j.length} vs ${u.length}`);
  });

  test('settings travel with the link', async () => {
    const hash = await T.encodeShare('{"a":1}', { indent: 'tab', sortKeys: true, mode: 'minify', view: 'tree' });
    assert.match(hash, /&i=tab&k=1&m=m&v=t$/);
    const r = await T.decodeShare(hash);
    assert.deepEqual(r.settings, { indent: 'tab', sortKeys: true, mode: 'minify', view: 'tree' });
    const r2 = await T.decodeShare(await T.encodeShare('{}', { indent: '4', sortKeys: false, mode: 'format', view: 'code' }));
    assert.deepEqual(r2.settings, { indent: '4', sortKeys: false, mode: 'format', view: 'code' });
  });

  test('unknown or unsafe settings are ignored', () => {
    assert.deepEqual(T.parseShareSettings('&i=8&k=yes&m=<script>&v=tree&x=1&=2&i'), {});
    assert.deepEqual(T.parseShareSettings('&i=2&v=c&i=4'), { indent: '4', view: 'code' });
  });

  test('hashes that are not share links are left alone', async () => {
    for (const h of ['', '#', '#top', '#section-2', '#j=abc', '#x1=abc', '#jq']) assert.equal(await T.decodeShare(h), null, h);
  });

  test('a link from a newer format version is reported', async () => {
    assert.deepEqual(await T.decodeShare('#j2=00000000.abc'), { ok: false, reason: 'version' });
    assert.deepEqual(await T.decodeShare('#u7=anything'), { ok: false, reason: 'version' });
  });

  test('cut-off links are reported as incomplete, never thrown', async () => {
    const text = JSON.stringify(SAMPLE, null, 2);
    for (const compress of [true, false]) {
      const hash = await T.encodeShare(text, { view: 'tree' }, { compress });
      const data = hash.split('&')[0];
      for (const cut of [5, 12, 30, Math.floor(data.length / 2), data.length - 7, data.length - 1]) {
        const r = await T.decodeShare('#' + data.slice(0, cut));
        assert.deepEqual(r, { ok: false, reason: 'incomplete' }, `${compress ? 'j1' : 'u1'} cut at ${cut}`);
      }
    }
  });

  test('damaged links are reported as incomplete, never thrown', async () => {
    const text = JSON.stringify(SAMPLE);
    for (const compress of [true, false]) {
      const hash = await T.encodeShare(text, null, { compress });
      const prefix = hash.slice(0, 12), data = hash.slice(12);
      const damaged = [
        prefix + data.slice(0, 20) + (data[20] === 'A' ? 'B' : 'A') + data.slice(21),   // one character changed
        prefix + data.replace(/[A-Za-z]/, '%'),                                          // invalid character
        hash.slice(0, 3) + 'zzzzzzzz' + hash.slice(11),                                  // bad checksum text
        hash.slice(0, 3) + '00000000' + hash.slice(11),                                  // wrong checksum
        hash.slice(0, 11) + data,                                                        // missing separator
      ];
      for (const h of damaged) assert.deepEqual(await T.decodeShare('#' + h), { ok: false, reason: 'incomplete' }, h.slice(0, 30));
    }
    // random garbage after a valid-looking prefix
    for (const g of ['j1=', 'j1=12345678.', 'j1=12345678.____', 'u1=12345678.' + 'A'.repeat(50)]) {
      const r = await T.decodeShare('#' + g);
      assert.equal(r.ok, false, g);
    }
  });

  test('size limits', () => {
    assert.deepEqual(T.shareLinkCheck(2000), { length: 2000, warn: false, tooBig: false });
    assert.equal(T.shareLinkCheck(T.SHARE_WARN_LENGTH).warn, false);
    assert.equal(T.shareLinkCheck(T.SHARE_WARN_LENGTH + 1).warn, true);
    assert.equal(T.shareLinkCheck(T.SHARE_MAX_LENGTH).tooBig, false);
    assert.equal(T.shareLinkCheck(T.SHARE_MAX_LENGTH + 1).tooBig, true);
    assert.equal(T.SHARE_WARN_LENGTH, 8000);
    assert.equal(T.SHARE_MAX_LENGTH, 1000000);
  });
});

// ---------- links with both documents (Compare mode) ----------

describe('compare share links', () => {
  const pairs = [['{"a":1}', '{"a":2}'], ['', '[]'], ['12:not json', '{"x":"日本 😀"}'], ['[1,2]', '']];
  for (const compress of [true, false]) {
    test(`round trip (${compress ? 'compressed, d1=' : 'plain, e1='})`, async () => {
      for (const [original, changed] of pairs) {
        const hash = await T.encodeCompareShare(original, changed, { arrays: 'key', key: 'id & "x"', ignoreOrder: true, numbersEqual: false, onlyChanges: true, indent: '4' }, { compress });
        assert.match(hash, compress ? /^d1=[0-9a-f]{8}\./ : /^e1=[0-9a-f]{8}\./);
        const r = await T.decodeShare('#' + hash);
        assert.equal(r.ok, true);
        assert.equal(r.compare, true);
        assert.equal(r.original, original);
        assert.equal(r.changed, changed);
        assert.deepEqual(r.settings, { indent: '4', arrays: 'key', key: 'id & "x"', ignoreOrder: true, numbersEqual: false, onlyChanges: true });
      }
    });
  }
  test('damaged or cut links are refused; unknown settings are ignored', async () => {
    const hash = await T.encodeCompareShare('{"a":1}', '{"a":2}', {}, { compress: false });
    assert.deepEqual(await T.decodeShare(hash.slice(0, -3)), { ok: false, reason: 'incomplete' });
    assert.deepEqual(await T.decodeShare(hash.replace(/^e1/, 'e2')), { ok: false, reason: 'version' });
    // A length header longer than the text is refused even with a correct checksum.
    const bytes = new TextEncoder().encode('99:{}');
    const forged = 'e1=' + T.crc32(bytes) + '.' + T.base64urlEncode(bytes);
    assert.deepEqual(await T.decodeShare(forged), { ok: false, reason: 'incomplete' });
    const r = await T.decodeShare(hash + '&a=zzz&ak=' + 'k'.repeat(300) + '&ao=yes&evil=<script>');
    assert.deepEqual(r.settings, {});
  });
});
