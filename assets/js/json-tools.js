/*
 * Pure JSON helpers with no DOM access: error parsing, key sorting,
 * structure stats, syntax highlighting and size formatting.
 * Exposed as window.JsonTools so it works when index.html is opened from disk.
 */
(function (global) {
  'use strict';

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  function byteLen(s) {
    try { return new TextEncoder().encode(s).length; } catch (e) { return s.length; }
  }

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function offsetFrom(text, line, col) {
    var lines = text.split('\n'), pos = 0, i;
    for (i = 0; i < line - 1 && i < lines.length; i++) pos += lines[i].length + 1;
    return pos + Math.max(0, col - 1);
  }

  // Normalizes JSON.parse errors across browsers into { message, pos, line, col }.
  function describeError(e, text) {
    var raw = (e && e.message) ? e.message : String(e);
    var pos = null, line = null, col = null, m;
    m = raw.match(/position (\d+)/i);
    if (m) {
      pos = +m[1];
    } else {
      m = raw.match(/line (\d+) column (\d+)/i);
      if (m) { line = +m[1]; col = +m[2]; pos = offsetFrom(text, line, col); }
    }
    if (pos === null && /end of (json|data)|unexpected end/i.test(raw)) pos = text.length;
    if (pos !== null && line === null) {
      var before = text.slice(0, pos).split('\n');
      line = before.length;
      col = before[before.length - 1].length + 1;
    }
    var clean = raw
      .replace(/^JSON\.parse:\s*/i, '')
      .replace(/\s*(in JSON )?at position \d+.*$/i, '')
      .replace(/\s*at line \d+ column \d+.*$/i, '')
      .replace(/\s*\(line \d+ column \d+\)/i, '');
    if (!clean) clean = 'Invalid JSON';
    return { message: clean, pos: pos, line: line, col: col };
  }

  function sortKeys(v) {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      var out = {};
      Object.keys(v).sort(function (a, b) { return a < b ? -1 : a > b ? 1 : 0; }).forEach(function (k) { out[k] = sortKeys(v[k]); });
      return out;
    }
    return v;
  }

  function measure(v) {
    var keys = 0, maxDepth = 0;
    (function walk(x, d) {
      if (d > maxDepth) maxDepth = d;
      if (Array.isArray(x)) { x.forEach(function (y) { walk(y, d + 1); }); }
      else if (x && typeof x === 'object') {
        Object.keys(x).forEach(function (k) { keys++; walk(x[k], d + 1); });
      }
    })(v, 0);
    return { keys: keys, depth: maxDepth };
  }

  function kindOf(v) {
    if (Array.isArray(v)) return 'array of ' + v.length + (v.length === 1 ? ' item' : ' items');
    if (v === null) return 'null';
    if (typeof v === 'object') return 'object with ' + Object.keys(v).length + (Object.keys(v).length === 1 ? ' key' : ' keys');
    return typeof v;
  }

  var TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

  function highlight(text) {
    return esc(text).replace(TOKEN, function (m, str, colon, bool) {
      if (str) return colon ? '<span class="k">' + str + '</span>' + colon : '<span class="s">' + str + '</span>';
      if (bool) return '<span class="b">' + m + '</span>';
      if (m === 'null') return '<span class="z">null</span>';
      return '<span class="n">' + m + '</span>';
    });
  }

  global.JsonTools = {
    fmtBytes: fmtBytes,
    byteLen: byteLen,
    esc: esc,
    describeError: describeError,
    sortKeys: sortKeys,
    measure: measure,
    kindOf: kindOf,
    highlight: highlight
  };
})(window);
