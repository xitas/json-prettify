/*
 * Pure JSON helpers with no DOM access: error parsing, key sorting,
 * structure stats, syntax highlighting and size formatting.
 * Exposed as window.JsonTools so it works when index.html is opened from disk.
 */
(function (global) {
  'use strict';

  // Switches unit when the rounded value would reach the next unit, so 1048575 bytes
  // shows as "1.00 MB" rather than "1024.0 KB".
  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    var kb = (n / 1024).toFixed(1);
    if (+kb < 1024) return kb + ' KB';
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

  function lineColAt(text, pos) {
    var before = text.slice(0, pos).split('\n');
    return { line: before.length, col: before[before.length - 1].length + 1 };
  }

  /*
   * Finds the first JSON syntax error without relying on the browser's message.
   * Returns { message, pos, line, col } (pos is a 0-based character offset), or null
   * when the text is valid JSON. Uses a loop with its own stack, so deep nesting is fine.
   */
  function findSyntaxError(text) {
    var n = text.length, i = 0, stack = [], expect = 'value', c, err;
    var CLOSER = { '{': '}', '[': ']' };

    function fail(message, at) {
      var lc = lineColAt(text, at);
      return { message: message, pos: at, line: lc.line, col: lc.col };
    }
    function show(ch) { return ch === "'" ? '"\'"' : "'" + ch + "'"; }
    function after() { return stack.length ? 'next' : 'end'; }
    function endOfInput() {
      return fail('Unexpected end of input' + (stack.length ? ' (missing ' + show(CLOSER[stack[stack.length - 1]]) + ')' : ''), n);
    }

    function scanString() {
      i++; // opening quote
      while (i < n) {
        var code = text.charCodeAt(i);
        if (code === 34) { i++; return null; }
        if (code === 92) {
          var e2 = text.charAt(i + 1);
          if (!e2) break;
          if ('"\\/bfnrt'.indexOf(e2) !== -1) { i += 2; continue; }
          if (e2 === 'u') {
            if (!/^[0-9a-fA-F]{4}$/.test(text.substr(i + 2, 4))) return fail('Bad unicode escape (\\u needs 4 hex digits)', i);
            i += 6; continue;
          }
          return fail('Bad escape ' + show('\\' + e2) + ' in string', i);
        }
        if (code === 10 || code === 13) return fail('Unterminated string (line break inside string)', i);
        if (code < 32) return fail('Control character in string (use an escape such as \\t)', i);
        i++;
      }
      return fail('Unterminated string', n);
    }

    function scanNumber() {
      var start = i;
      if (text.charAt(i) === '-') i++;
      if (text.charAt(i) === '0') {
        i++;
        if (/[0-9]/.test(text.charAt(i))) return fail('Leading zeros are not allowed in numbers', start);
      } else if (/[1-9]/.test(text.charAt(i))) {
        while (/[0-9]/.test(text.charAt(i))) i++;
      } else {
        return i >= n ? endOfInput() : fail('Expected a digit after ' + show('-'), i);
      }
      if (text.charAt(i) === '.') {
        i++;
        if (!/[0-9]/.test(text.charAt(i))) return i >= n ? endOfInput() : fail('Expected a digit after the decimal point', i);
        while (/[0-9]/.test(text.charAt(i))) i++;
      }
      if (text.charAt(i) === 'e' || text.charAt(i) === 'E') {
        i++;
        if (text.charAt(i) === '+' || text.charAt(i) === '-') i++;
        if (!/[0-9]/.test(text.charAt(i))) return i >= n ? endOfInput() : fail('Expected a digit in the exponent', i);
        while (/[0-9]/.test(text.charAt(i))) i++;
      }
      return null;
    }

    function scanValue() {
      if (c === '"') return scanString();
      if (c === '-' || (c >= '0' && c <= '9')) return scanNumber();
      var words = ['true', 'false', 'null'];
      for (var w = 0; w < words.length; w++) {
        if (text.substr(i, words[w].length) === words[w]) { i += words[w].length; return null; }
        if (words[w].indexOf(text.slice(i)) === 0) return endOfInput(); // e.g. "tru" at the end
      }
      if (c === "'") return fail('Strings must use double quotes', i);
      return fail('Unexpected ' + show(c) + ' where a value was expected', i);
    }

    while (true) {
      while (i < n && (c = text.charAt(i), c === ' ' || c === '\t' || c === '\n' || c === '\r')) i++;
      if (i >= n) return expect === 'end' ? null : endOfInput();
      c = text.charAt(i);

      if (expect === 'end') return fail('Unexpected ' + show(c) + ' after the end of the JSON value', i);

      if (expect === 'value' || expect === 'firstItem') {
        if (expect === 'firstItem' && c === ']') { stack.pop(); i++; expect = after(); continue; }
        if (c === ']' || c === '}') {
          return fail(expect === 'value' && stack.length && text.slice(0, i).replace(/\s+$/, '').slice(-1) === ','
            ? 'Trailing comma before ' + show(c) : 'Unexpected ' + show(c) + ' where a value was expected', i);
        }
        if (c === '{') { stack.push('{'); i++; expect = 'firstKey'; continue; }
        if (c === '[') { stack.push('['); i++; expect = 'firstItem'; continue; }
        if ((err = scanValue())) return err;
        expect = after();
        continue;
      }

      if (expect === 'firstKey' || expect === 'key') {
        if (c === '}') {
          if (expect === 'firstKey') { stack.pop(); i++; expect = after(); continue; }
          return fail('Trailing comma before ' + show('}'), i);
        }
        if (c === '"') { if ((err = scanString())) return err; expect = 'colon'; continue; }
        if (c === "'") return fail('Property names must use double quotes', i);
        return fail('Expected a property name in double quotes', i);
      }

      if (expect === 'colon') {
        if (c === ':') { i++; expect = 'value'; continue; }
        return fail('Expected ' + show(':') + ' after the property name', i);
      }

      // expect === 'next': after a value inside an object or array
      var top = stack[stack.length - 1];
      if (c === ',') { i++; expect = top === '{' ? 'key' : 'value'; continue; }
      if (c === CLOSER[top]) { stack.pop(); i++; expect = after(); continue; }
      return fail(top === '{' ? 'Missing ' + show(',') + ' or ' + show('}') + ' after a property value'
        : 'Missing ' + show(',') + ' or ' + show(']') + ' after an array item', i);
    }
  }

  // Normalizes JSON.parse errors across browsers into { message, pos, line, col }.
  // When the browser gives no position (current Chrome/Edge, Safari), findSyntaxError
  // locates the error instead.
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
    if (pos === null && /end of (json|data)|unexpected end|unexpected eof/i.test(raw)) pos = text.length;
    if (pos === null) {
      var found = findSyntaxError(text);
      if (found) pos = found.pos;
    }
    if (pos !== null && line === null) {
      var lc = lineColAt(text, pos);
      line = lc.line;
      col = lc.col;
    }
    var clean = raw
      .replace(/^JSON\.parse:\s*/i, '')                       // Firefox
      .replace(/^JSON Parse error:\s*/i, '')                  // Safari
      .replace(/,\s*(\.\.\.)?"[\s\S]*"(\.\.\.)?\s+is not valid JSON\.?$/i, '') // Chrome: drops the repeated input slice
      .replace(/\s*(in JSON )?at position \d+.*$/i, '')
      .replace(/\s*at line \d+ column \d+.*$/i, '')
      .replace(/\s*\(line \d+ column \d+\)/i, '');
    if (!clean) clean = 'Invalid JSON';
    clean = clean.charAt(0).toUpperCase() + clean.slice(1);
    return { message: clean, pos: pos, line: line, col: col };
  }

  function isContainer(v) { return v !== null && typeof v === 'object'; }

  // Assigns a key as a plain own property, including "__proto__" (which a normal
  // assignment would treat as the prototype setter).
  function setKey(obj, key, value) {
    if (key === '__proto__') Object.defineProperty(obj, key, { value: value, writable: true, enumerable: true, configurable: true });
    else obj[key] = value;
  }

  // Returns a copy with object keys sorted (code-point order) at every level.
  // Uses a loop with its own stack, so very deep nesting does not overflow.
  function sortKeys(v) {
    if (!isContainer(v)) return v;
    var root = Array.isArray(v) ? [] : {};
    var stack = [v, root];
    while (stack.length) {
      var out = stack.pop(), src = stack.pop(), i, val, copy;
      if (Array.isArray(src)) {
        for (i = 0; i < src.length; i++) {
          val = src[i];
          copy = isContainer(val) ? (Array.isArray(val) ? [] : {}) : val;
          out.push(copy);
          if (copy !== val) stack.push(val, copy);
        }
      } else {
        var keys = Object.keys(src).sort(function (a, b) { return a < b ? -1 : a > b ? 1 : 0; });
        for (i = 0; i < keys.length; i++) {
          val = src[keys[i]];
          copy = isContainer(val) ? (Array.isArray(val) ? [] : {}) : val;
          setKey(out, keys[i], copy);
          if (copy !== val) stack.push(val, copy);
        }
      }
    }
    return root;
  }

  // Counts object keys at every level and the maximum nesting depth (scalars at the
  // top level have depth 0). Uses a loop with its own stack.
  function measure(v) {
    var keys = 0, maxDepth = 0, stack = [v, 0];
    while (stack.length) {
      var d = stack.pop(), x = stack.pop(), i;
      if (d > maxDepth) maxDepth = d;
      if (Array.isArray(x)) {
        for (i = 0; i < x.length; i++) stack.push(x[i], d + 1);
      } else if (isContainer(x)) {
        var ks = Object.keys(x);
        keys += ks.length;
        for (i = 0; i < ks.length; i++) stack.push(x[ks[i]], d + 1);
      }
    }
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
    findSyntaxError: findSyntaxError,
    sortKeys: sortKeys,
    measure: measure,
    kindOf: kindOf,
    highlight: highlight
  };

  // Also loadable from Node for the unit tests (no effect in the browser).
  if (typeof module !== 'undefined' && module.exports) module.exports = global.JsonTools;
})(typeof window !== 'undefined' ? window : globalThis);
