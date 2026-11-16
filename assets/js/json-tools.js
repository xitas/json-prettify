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

  /*
   * Repairs common almost-JSON mistakes with a single character-by-character pass:
   * comments, trailing commas, missing commas between items on separate lines,
   * single or curly quotes, unquoted keys, Python/JavaScript values (True, None,
   * undefined, NaN, Infinity), and a byte order mark or non-JSON whitespace.
   *
   * Text inside a double-quoted string is never changed, numbers are copied exactly as
   * written, and key order is kept. Returns:
   *   { ok, text, changed, changes: [{ type, line, col, detail }], summary, error }
   * ok is true only when the result passes JSON.parse. When it is false, text is the
   * original input, unchanged.
   */
  var NON_JSON_SPACE = /[\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000]/;
  var WORD_START = /[A-Za-z_$]/;
  var WORD_CHAR = /[A-Za-z0-9_$]/;
  var VALUE_WORDS = { 'true': 'true', 'false': 'false', 'null': 'null', 'True': 'true', 'False': 'false', 'None': 'null',
    'undefined': 'null', 'NaN': 'null', 'Infinity': 'null', '-Infinity': 'null' };
  var QUOTE_CLOSERS = { "'": "'", '\u2018': '\u2019\u2018', '\u2019': '\u2019\u2018', '\u201c': '\u201d\u201c"', '\u201d': '\u201d\u201c"' };

  function repairJson(text) {
    try {
      JSON.parse(text);
      return { ok: true, text: text, changed: false, changes: [], summary: '', error: null };
    } catch (e) {}

    var n = text.length, i = 0, out = [], changes = [];
    var lineStarts = [0], k;
    for (k = 0; k < n; k++) if (text.charCodeAt(k) === 10) lineStarts.push(k + 1);

    function note(type, pos, detail) {
      var lo = 0, hi = lineStarts.length - 1;
      while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1; }
      changes.push({ type: type, line: lo + 1, col: pos - lineStarts[lo] + 1, detail: detail || null });
    }

    var stack = [];            // open containers: '{' or '['
    var expect = 'value';      // 'value' | 'key' | 'colon' | 'next' (comma or closer) | 'end'
    var pendingComma = -1, pendingCommaPos = 0; // a comma that may turn out to be trailing
    var lastValueEnd = -1, lastValueEndPos = 0; // where a missing comma would go
    var newlineSince = false;  // a line break since the last value
    var failure = null;

    // Called when a key or value starts. Adds a missing comma when the previous item
    // ended on an earlier line; returns the role of the new token.
    function startItem() {
      if (expect === 'next' && stack.length && newlineSince && lastValueEnd > 0) {
        out[lastValueEnd - 1] += ',';
        note('missing-comma', lastValueEndPos);
        expect = stack[stack.length - 1] === '{' ? 'key' : 'value';
      }
      pendingComma = -1;
      newlineSince = false;
      return expect;
    }
    function endItem(role) {
      if (role === 'key') { expect = 'colon'; return; }
      lastValueEnd = out.length;
      lastValueEndPos = i;
      expect = stack.length ? 'next' : 'end';
    }

    // Removes spaces and tabs at the end of the output (whitespace only, never tokens).
    // Returns true when that leaves the output at the start of a line.
    function trimSpacesBefore() {
      var last = out.length - 1;
      while (last >= 0 && out[last] === '') last--;
      if (last < 0) return true;
      if (!/^[ \t\r\n]*$/.test(out[last])) return false;
      out[last] = out[last].replace(/[ \t]+$/, '');
      return out[last] === '' ? trimSpacesBefore() : /[\r\n]$/.test(out[last]);
    }

    // Reads a string opened by ' or a curly quote; returns the JSON string or null.
    function readOddString(open) {
      var closers = QUOTE_CLOSERS[open], strict = open === "'" || open === '\u2018' || open === '\u2019';
      for (var pass = 0; pass < 2; pass++) {
        var j = i + 1, content = '', firstClose = -1;
        while (j < n) {
          var ch = text.charAt(j);
          if (ch === '\\') {
            var nx = text.charAt(j + 1);
            if (nx === "'" || nx === '\u2019' || nx === '\u2018') content += nx;  // \' is not valid JSON
            else content += ch + nx;
            j += 2;
            continue;
          }
          if (closers.indexOf(ch) !== -1) {
            if (firstClose === -1) firstClose = j;
            // Single quotes can be apostrophes: only end where structure follows.
            var after = j + 1;
            while (after < n && (text.charAt(after) === ' ' || text.charAt(after) === '\t')) after++;
            var na = text.charAt(after);
            if (pass === 1 || !strict || after >= n || ',:}]\r\n/'.indexOf(na) !== -1) {
              i = j + 1;
              return '"' + content + '"';
            }
          }
          if (ch === '\n' || ch === '\r') break;
          content += ch === '"' ? '\\"' : ch;
          j++;
        }
        if (firstClose === -1) return null;
        // Second pass: no quote was followed by structure, so the first one ends it.
        if (pass === 0) { var save = text.slice(i + 1, firstClose); if (save.indexOf('\n') !== -1) return null; }
      }
      return null;
    }

    while (i < n) {
      var c = text.charAt(i), role, j;

      if (c === '\ufeff') { note('bom', i); i++; continue; }
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        j = i;
        while (j < n && ' \t\n\r'.indexOf(text.charAt(j)) !== -1) j++;
        if (text.slice(i, j).indexOf('\n') !== -1) newlineSince = true;
        out.push(text.slice(i, j));
        i = j;
        continue;
      }
      if (NON_JSON_SPACE.test(c)) {
        note('whitespace', i);
        if (out.length) out.push(' ');
        i++;
        continue;
      }
      if (c === '/' && (text.charAt(i + 1) === '/' || text.charAt(i + 1) === '*')) {
        if (text.charAt(i + 1) === '/') {
          j = i + 2;
          while (j < n && text.charAt(j) !== '\n' && text.charAt(j) !== '\r') j++;
        } else {
          j = text.indexOf('*/', i + 2);
          if (j === -1) { failure = 'A /* comment is never closed'; break; }
          if (text.slice(i, j).indexOf('\n') !== -1) newlineSince = true;
          j += 2;
        }
        note('comment', i);
        // Tidy up: drop the spaces before the comment, and when the comment had a line
        // of its own, drop that line's line break too, so no blank line is left behind.
        var ownLine = trimSpacesBefore();
        i = j;
        var eol = text.charAt(i) === '\r' && text.charAt(i + 1) === '\n' ? 2 : (text.charAt(i) === '\n' || text.charAt(i) === '\r' ? 1 : 0);
        if (ownLine && (eol || i >= n)) { i += eol; newlineSince = true; }
        continue;
      }
      if (c === '{' || c === '[') {
        startItem();
        out.push(c);
        stack.push(c);
        expect = c === '{' ? 'key' : 'value';
        i++;
        continue;
      }
      if (c === '}' || c === ']') {
        if (pendingComma !== -1) {
          out[pendingComma] = '';
          note('trailing-comma', pendingCommaPos);
          pendingComma = -1;
        }
        out.push(c);
        if (stack.length && stack[stack.length - 1] === (c === '}' ? '{' : '[')) stack.pop();
        i++;
        newlineSince = false;
        endItem('value');
        continue;
      }
      if (c === ',') {
        out.push(c);
        if (expect === 'next') {
          pendingComma = out.length - 1;
          pendingCommaPos = i;
          expect = stack[stack.length - 1] === '{' ? 'key' : 'value';
        }
        newlineSince = false;
        i++;
        continue;
      }
      if (c === ':') {
        out.push(c);
        if (expect === 'colon') expect = 'value';
        newlineSince = false;
        i++;
        continue;
      }
      if (c === '"') {
        role = startItem();
        j = i + 1;
        while (j < n && text.charAt(j) !== '"') j += text.charAt(j) === '\\' ? 2 : 1;
        if (j >= n) { failure = 'A string is never closed'; break; }
        out.push(text.slice(i, j + 1)); // copied exactly: string contents are never changed
        i = j + 1;
        endItem(role);
        continue;
      }
      if (QUOTE_CLOSERS[c]) {
        var start = i;
        role = startItem();
        var str = readOddString(c);
        if (str === null) { failure = 'A quoted string is never closed'; break; }
        note(c === "'" ? 'single-quote' : 'smart-quote', start);
        out.push(str);
        endItem(role);
        continue;
      }
      if (c === '-' && text.substr(i + 1, 8) === 'Infinity') {
        startItem();
        note('value', i, '-Infinity \u2192 null');
        out.push('null');
        i += 9;
        endItem('value');
        continue;
      }
      if (c === '-' || c === '+' || c === '.' || (c >= '0' && c <= '9')) {
        role = startItem();
        j = i + 1;
        while (j < n && /[0-9eE+\-.]/.test(text.charAt(j))) j++;
        var num = text.slice(i, j);
        if (role === 'key') { note('unquoted-key', i); out.push('"' + num + '"'); }
        else out.push(num); // copied exactly as written
        i = j;
        endItem(role);
        continue;
      }
      if (WORD_START.test(c) || (c > '\u007f' && !NON_JSON_SPACE.test(c))) {
        role = startItem();
        j = i + 1;
        while (j < n && (WORD_CHAR.test(text.charAt(j)) || (text.charAt(j) > '\u007f' && !NON_JSON_SPACE.test(text.charAt(j)) && !QUOTE_CLOSERS[text.charAt(j)]))) j++;
        var word = text.slice(i, j);
        if (role === 'key') {
          note('unquoted-key', i);
          out.push('"' + word + '"');
        } else if (VALUE_WORDS.hasOwnProperty(word)) {
          if (VALUE_WORDS[word] !== word) note('value', i, word + ' \u2192 ' + VALUE_WORDS[word]);
          out.push(VALUE_WORDS[word]);
        } else {
          out.push(word); // unknown bare word: left alone, so the result will not parse
        }
        i = j;
        endItem(role);
        continue;
      }
      out.push(c);
      newlineSince = false;
      i++;
    }

    var fail = function (reason) {
      return { ok: false, text: text, changed: false, changes: [], summary: '', error: reason };
    };
    if (failure) return fail(failure);
    var result = out.join('');
    try {
      JSON.parse(result);
    } catch (e) {
      var left = findSyntaxError(result);
      return fail(left ? left.message : 'The JSON still is not valid after repairs');
    }
    return { ok: true, text: result, changed: true, changes: changes, summary: summarizeRepairs(changes), error: null };
  }

  var REPAIR_LABELS = [
    ['trailing-comma', 'trailing comma', 'trailing commas'],
    ['missing-comma', 'missing comma added', 'missing commas added'],
    ['single-quote', 'single-quoted string', 'single-quoted strings'],
    ['smart-quote', 'curly-quoted string', 'curly-quoted strings'],
    ['unquoted-key', 'unquoted key', 'unquoted keys'],
    ['value', 'Python/JavaScript value', 'Python/JavaScript values'],
    ['comment', 'comment removed', 'comments removed'],
    ['bom', 'byte order mark removed', 'byte order marks removed'],
    ['whitespace', 'stray whitespace character', 'stray whitespace characters']
  ];

  // "Fixed: 3 trailing commas, 2 single-quoted strings, 1 comment removed."
  function summarizeRepairs(changes) {
    var counts = {}, parts = [];
    for (var c = 0; c < changes.length; c++) counts[changes[c].type] = (counts[changes[c].type] || 0) + 1;
    for (var l = 0; l < REPAIR_LABELS.length; l++) {
      var count = counts[REPAIR_LABELS[l][0]];
      if (count) parts.push(count + ' ' + (count === 1 ? REPAIR_LABELS[l][1] : REPAIR_LABELS[l][2]));
    }
    return parts.length ? 'Fixed: ' + parts.join(', ') + '.' : '';
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

  // Number of lines in a text, as a code view shows them: "" is 1 line, and a trailing
  // newline starts a new (empty) line. Handles \n, \r\n and lone \r line endings.
  function countLines(text) {
    var count = 1, i = -1;
    while ((i = text.indexOf('\n', i + 1)) !== -1) count++;
    if (text.indexOf('\r') !== -1) {
      // A lone \r (not followed by \n) also ends a line.
      for (i = text.indexOf('\r'); i !== -1; i = text.indexOf('\r', i + 1)) {
        if (text.charAt(i + 1) !== '\n') count++;
      }
    }
    return count;
  }

  // Gutter text for line numbers 1..count, one per line ("1\n2\n3").
  function lineNumbers(count) {
    count = Math.max(1, Math.floor(count) || 1);
    var parts = new Array(count);
    for (var i = 0; i < count; i++) parts[i] = i + 1;
    return parts.join('\n');
  }

  // Width of the gutter in digits: enough for the largest number, at least 2.
  function gutterDigits(count) {
    return Math.max(2, String(Math.max(1, Math.floor(count) || 1)).length);
  }

  // ---- Tree view helpers ----

  // 10000 -> "10,000"
  function groupDigits(n) {
    var s = String(Math.floor(Math.abs(n))), out = '';
    while (s.length > 3) { out = ',' + s.slice(-3) + out; s = s.slice(0, -3); }
    return (n < 0 ? '-' : '') + s + out;
  }

  // Describes an object or array for the tree ({ kind, count, keys, brief, empty, label });
  // returns null for strings, numbers, booleans and null.
  function containerInfo(v) {
    if (v === null || typeof v !== 'object') return null;
    if (Array.isArray(v)) {
      return { kind: 'array', count: v.length, keys: null, brief: '[\u2026]', empty: '[]',
        label: groupDigits(v.length) + (v.length === 1 ? ' item' : ' items') };
    }
    var keys = Object.keys(v);
    return { kind: 'object', count: keys.length, keys: keys, brief: '{\u2026}', empty: '{}',
      label: groupDigits(keys.length) + (keys.length === 1 ? ' key' : ' keys') };
  }

  // Children start..end-1 of an object or array as [{ key, isIndex, value }].
  // Pass the object's keys (from containerInfo) to avoid listing them again.
  function listChildren(v, start, end, keys) {
    var out = [], i;
    start = Math.max(0, start || 0);
    if (Array.isArray(v)) {
      end = Math.min(end, v.length);
      for (i = start; i < end; i++) out.push({ key: i, isIndex: true, value: v[i] });
      return out;
    }
    if (v === null || typeof v !== 'object') return out;
    keys = keys || Object.keys(v);
    end = Math.min(end, keys.length);
    for (i = start; i < end; i++) out.push({ key: keys[i], isIndex: false, value: v[keys[i]] });
    return out;
  }

  // Path of a child in JavaScript notation: data.users[2].email, ["odd key"], [0].
  // The root has the path "".
  var IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  function childPath(parentPath, key, isIndex) {
    if (isIndex) return parentPath + '[' + key + ']';
    if (IDENTIFIER.test(key)) return parentPath ? parentPath + '.' + key : key;
    return parentPath + '[' + JSON.stringify(key) + ']';
  }

  // Key as shown in the tree: plain, or quoted when it would be unclear
  // (empty, surrounding spaces, quotes, backslashes, colons, control characters).
  function displayKey(key) {
    return key === '' || /^\s|\s$|["\\:\u0000-\u001f]/.test(key) ? JSON.stringify(key) : key;
  }

  // Text and highlight class for a scalar value. Strings longer than max characters
  // are cut (never inside a surrogate pair) and marked truncated; full is the whole text.
  function scalarView(v, max) {
    if (typeof v === 'string') {
      var full = JSON.stringify(v);
      if (max && v.length > max) {
        var cut = max, code = v.charCodeAt(cut - 1);
        if (code >= 0xd800 && code <= 0xdbff) cut--;
        return { text: JSON.stringify(v.slice(0, cut)).slice(0, -1) + '\u2026"', full: full, cls: 's', truncated: true };
      }
      return { text: full, full: full, cls: 's', truncated: false };
    }
    var text = JSON.stringify(v);
    return { text: text, full: text, cls: v === null ? 'z' : typeof v === 'boolean' ? 'b' : 'n', truncated: false };
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
    repairJson: repairJson,
    summarizeRepairs: summarizeRepairs,
    sortKeys: sortKeys,
    measure: measure,
    kindOf: kindOf,
    groupDigits: groupDigits,
    containerInfo: containerInfo,
    listChildren: listChildren,
    childPath: childPath,
    displayKey: displayKey,
    scalarView: scalarView,
    countLines: countLines,
    lineNumbers: lineNumbers,
    gutterDigits: gutterDigits,
    highlight: highlight
  };

  // Also loadable from Node for the unit tests (no effect in the browser).
  if (typeof module !== 'undefined' && module.exports) module.exports = global.JsonTools;
})(typeof window !== 'undefined' ? window : globalThis);
