/*
 * Pure JSON helpers with no DOM access: error parsing, key sorting,
 * structure stats, syntax highlighting and size formatting.
 * Exposed as window.JsonTools so it works when index.html is opened from disk.
 */
(function jsonTools(global) {
  'use strict';

  // Switches unit when the rounded value would reach the next unit, so 1048575 bytes
  // shows as "1.00 MB" rather than "1024.0 KB".
  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    var kb = (n / 1024).toFixed(1);
    if (+kb < 1024) return kb + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  // UTF-8 size of a string, counted without making an encoded copy (outputs can be large).
  // A lone surrogate counts as U+FFFD (3 bytes), as TextEncoder writes it.
  function byteLen(s) {
    var n = s.length, bytes = n;
    for (var i = 0; i < n; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) continue;
      if (c < 0x800) bytes += 1;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < n && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { bytes += 2; i++; }
      else bytes += 2;
    }
    return bytes;
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
    if (IDENTIFIER.test(key) && key !== '__proto__') return parentPath ? parentPath + '.' + key : key;
    return parentPath + '[' + JSON.stringify(key) + ']';
  }

  // ---- Paths ----
  // A path is an array of parts: strings for object keys, numbers for array indexes.

  var JSONPATH_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;   // RFC 9535 shorthand (ASCII only, no $)

  // Formats a path as JavaScript (data.users[2].email), JSONPath ($.data.users[2].email),
  // jq (.data.users[2].email) or JSON Pointer (/data/users/2/email). Keys that cannot be
  // written as plain names use the quoted form of each format.
  function formatPath(parts, format) {
    var out = '', i, p;
    if (format === 'pointer') {
      for (i = 0; i < parts.length; i++) out += '/' + String(parts[i]).replace(/~/g, '~0').replace(/\//g, '~1');
      return out;
    }
    if (format === 'jq') {
      for (i = 0; i < parts.length; i++) {
        p = parts[i];
        if (typeof p === 'number') out += (out ? '' : '.') + '[' + p + ']';
        else out += '.' + (JSONPATH_NAME.test(p) ? p : JSON.stringify(p));
      }
      return out || '.';
    }
    var jsonpath = format === 'jsonpath';
    if (jsonpath) out = '$';
    for (i = 0; i < parts.length; i++) {
      p = parts[i];
      if (typeof p === 'number') out += '[' + p + ']';
      else if (jsonpath ? JSONPATH_NAME.test(p) : IDENTIFIER.test(p) && p !== '__proto__') out += (out ? '.' : '') + p;
      else out += '[' + JSON.stringify(p) + ']';
    }
    return out;
  }

  // Breadcrumb labels: "root", then keys as shown in the tree and indexes as [2].
  function pathLabels(parts) {
    var out = ['root'];
    for (var i = 0; i < parts.length; i++) out.push(typeof parts[i] === 'number' ? '[' + parts[i] + ']' : displayKey(parts[i]));
    return out;
  }

  // The value at a path, or undefined when the path does not exist. Only own keys count,
  // so "constructor" or "__proto__" never reach Object.prototype.
  function valueAtPath(root, parts) {
    var v = root;
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (Array.isArray(v)) {
        if (typeof p !== 'number' || p < 0 || p >= v.length) return undefined;
      } else if (v === null || typeof v !== 'object' || typeof p !== 'string' || !Object.prototype.hasOwnProperty.call(v, p)) {
        return undefined;
      }
      v = v[p];
    }
    return v;
  }

  // Text for "Copy value": formatted JSON for objects and arrays, the raw value otherwise
  // (a string without its quotes).
  function copyValueText(v, indent) {
    if (v !== null && typeof v === 'object') return JSON.stringify(v, null, indent === undefined ? 2 : indent);
    return typeof v === 'string' ? v : JSON.stringify(v);
  }

  // Walks valid JSON text and calls onValue(parts, from, end, start) for every value after
  // its children, so inner values come first. from is where the member starts (its key,
  // for object members), start where the value starts, end is just past it. Returning
  // true stops the walk.
  function walkJsonValues(text, onValue) {
    var i = 0, n = text.length, parts = [];
    function skip() {
      while (i < n) { var c = text.charCodeAt(i); if (c === 32 || c === 9 || c === 10 || c === 13) i++; else break; }
    }
    function str() {
      i++;
      while (i < n && text.charCodeAt(i) !== 34) i += text.charCodeAt(i) === 92 ? 2 : 1;
      i++;
    }
    function value(from) {
      skip();
      var start = i, c = text.charAt(i);
      if (c === '{' || c === '[') {
        var obj = c === '{';
        i++;
        skip();
        if (text.charAt(i) === (obj ? '}' : ']')) i++;
        else {
          for (var idx = 0; ; idx++) {
            skip();
            var memberStart = i;
            if (obj) { str(); parts.push(JSON.parse(text.slice(memberStart, i))); skip(); i++; }
            else parts.push(idx);
            if (value(memberStart)) return true;
            parts.pop();
            skip();
            if (text.charAt(i) === ',') { i++; continue; }
            i++;
            break;
          }
        }
      } else if (c === '"') {
        str();
      } else {
        while (i < n && ',]} \t\n\r'.indexOf(text.charAt(i)) === -1) i++;
      }
      return onValue(parts, from, i, start) === true;
    }
    value(0);
  }

  // Path of the innermost value at a character offset in formatted JSON text. An offset on
  // a key gives that member's path; on punctuation or space, the enclosing container's.
  function pathAtOffset(text, offset) {
    var found = null;
    walkJsonValues(text, function (parts, from, end) {
      if (offset >= from && offset < end) { found = parts.slice(); return true; }
    });
    return found || [];
  }

  // Character range { start, end } of the value at a path in JSON text, or null.
  function rangeOfPath(text, target) {
    var found = null;
    walkJsonValues(text, function (parts, from, end, start) {
      if (parts.length !== target.length) return false;
      for (var k = 0; k < parts.length; k++) if (parts[k] !== target[k]) return false;
      found = { start: start, end: end };
      return true;
    });
    return found;
  }

  // ---- Search ----

  // Builds the regular expression for a search. Returns { re } (re is null for an empty
  // query) or { re: null, error } for an invalid regex.
  function buildMatcher(query, opts) {
    if (!query) return { re: null };
    var src = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (opts.wholeWord) src = '(?<![\\p{L}\\p{N}_])(?:' + src + ')(?![\\p{L}\\p{N}_])';
    try {
      return { re: new RegExp(src, 'gu' + (opts.caseSensitive ? '' : 'i')) };
    } catch (e) {
      var msg = String(e && e.message || 'invalid pattern').replace(/^.*: /, '');
      return { re: null, error: 'Invalid pattern: ' + msg.charAt(0).toLowerCase() + msg.slice(1) };
    }
  }

  // Text a value is searched as: strings without quotes; numbers, true, false, null as written.
  function valueText(v) {
    return typeof v === 'string' ? v : JSON.stringify(v);
  }

  /*
   * A search over parsed JSON that can run in slices. options: { scope: 'keys' | 'values' |
   * 'both', caseSensitive, wholeWord, regex, limit (default 10000) }. Call step(budget)
   * until it returns true; budget is how many keys/values to look at in this slice.
   * Results: matches [{ path, where: 'key' | 'value', start, end }] in document order
   * (start/end are offsets in the key or the value text), truncated (more than the limit)
   * and error (invalid regex). Array indexes are not searched; empty matches are ignored.
   * Uses its own stack, so deep nesting is fine.
   */
  function createSearch(root, query, options) {
    var opts = options || {}, scope = opts.scope || 'both', limit = opts.limit || 10000;
    var m = buildMatcher(query, opts);
    var s = { matches: [], truncated: false, error: m.error || null, done: !m.re, step: step };
    if (s.done) { s.step = function () { return true; }; return s; }
    var re = m.re, keysOn = scope !== 'values', valuesOn = scope !== 'keys';
    var parts = [], frames = [], started = false;

    function scan(text, where) {
      re.lastIndex = 0;
      var r;
      while ((r = re.exec(text))) {
        if (r[0] === '') {                       // skip empty matches without looping forever
          if (r.index >= text.length) break;
          re.lastIndex = r.index + (text.codePointAt(r.index) > 0xffff ? 2 : 1);
          continue;
        }
        if (s.matches.length >= limit) { s.truncated = true; return false; }
        s.matches.push({ path: parts.slice(), where: where, start: r.index, end: r.index + r[0].length });
      }
      return true;
    }
    function push(v) {
      var keys = Array.isArray(v) ? null : Object.keys(v);
      frames.push({ v: v, keys: keys, n: keys ? keys.length : v.length, i: 0 });
    }
    function finish() { s.done = true; frames = []; return true; }

    function step(budget) {
      if (s.done) return true;
      if (!started) {
        started = true;
        if (root !== null && typeof root === 'object') push(root);
        else return finish(valuesOn && scan(valueText(root), 'value'));
      }
      while (frames.length && budget-- > 0) {
        var f = frames[frames.length - 1];
        if (f.i >= f.n) { frames.pop(); if (frames.length) parts.pop(); continue; }
        var key = f.keys ? f.keys[f.i] : f.i;
        var child = f.v[key];
        f.i++;
        parts.push(key);
        if (f.keys && keysOn && !scan(key, 'key')) return finish();
        if (child !== null && typeof child === 'object') push(child);
        else {
          if (valuesOn && !scan(valueText(child), 'value')) return finish();
          parts.pop();
        }
      }
      return frames.length ? false : finish();
    }
    return s;
  }

  // Runs a whole search at once: { matches, truncated, error }.
  function searchJson(root, query, options) {
    var s = createSearch(root, query, options);
    s.step(Infinity);
    return { matches: s.matches, truncated: s.truncated, error: s.error };
  }

  // Offset in JSON.stringify(raw) (including the opening quote) of offset k in raw.
  function jsonStringOffset(raw, k) {
    return JSON.stringify(raw.slice(0, k)).length - 1;
  }

  // Walks valid JSON text in document order and calls onToken(parts, where, start, end)
  // for every key ('key', parts = the member's path) and every plain value ('value').
  // Returning false stops. Uses its own stack.
  function walkTokens(text, onToken) {
    var i = 0, n = text.length, parts = [], frames = [];
    function skip() {
      while (i < n) { var c = text.charCodeAt(i); if (c === 32 || c === 9 || c === 10 || c === 13) i++; else break; }
    }
    function strEnd(p) {
      p++;
      while (p < n && text.charCodeAt(p) !== 34) p += text.charCodeAt(p) === 92 ? 2 : 1;
      return p + 1;
    }
    function key() {
      var ks = i, ke = strEnd(i);
      parts.push(JSON.parse(text.slice(ks, ke)));
      if (onToken(parts, 'key', ks, ke) === false) return false;
      i = ke;
      skip();
      i++;                                       // the colon
      return true;
    }
    for (;;) {
      skip();
      var c = text.charAt(i);
      if (c === '{' || c === '[') {
        var obj = c === '{';
        i++;
        skip();
        if (text.charAt(i) !== (obj ? '}' : ']')) {
          frames.push(obj);
          if (obj) { if (!key()) return; } else parts.push(0);
          continue;                              // read the first member's value
        }
        i++;                                     // empty container
      } else {
        var s = i;
        if (c === '"') i = strEnd(i);
        else while (i < n && ',]} \t\n\r'.indexOf(text.charAt(i)) === -1) i++;
        if (onToken(parts, 'value', s, i) === false) return;
      }
      for (;;) {                                 // after a value: next member, or close
        if (!frames.length) return;
        skip();
        if (text.charAt(i) === ',') {
          i++;
          skip();
          if (frames[frames.length - 1]) { parts.pop(); if (!key()) return; } else parts[parts.length - 1]++;
          break;
        }
        i++;
        frames.pop();
        parts.pop();
      }
    }
  }

  // Character ranges { start, end } in formatted JSON text for each match from a search of
  // the same data (null when a match is not found). Offsets inside strings account for the
  // quotes and escapes in the text.
  function locateMatches(text, matches) {
    var out = new Array(matches.length), k = 0;
    if (!matches.length) return out;
    walkTokens(text, function (parts, where, s, e) {
      var m = matches[k];
      while (m && m.where === where && m.path.length === parts.length && samePath(m.path, parts)) {
        if (text.charAt(s) === '"') {
          var raw = JSON.parse(text.slice(s, e));
          out[k] = { start: s + jsonStringOffset(raw, m.start), end: s + jsonStringOffset(raw, m.end) };
        } else {
          out[k] = { start: s + m.start, end: s + m.end };
        }
        m = matches[++k];
      }
      return k < matches.length;
    });
    for (var j = 0; j < out.length; j++) if (!out[j]) out[j] = null;
    return out;
  }
  function samePath(a, b) {
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // Like highlight(), with <mark class="m" data-i="..."> around the given ranges
  // ([{ start, end, i }], sorted, within single tokens). Without syntax highlighting it
  // only escapes the text and adds the marks.
  function highlightMarked(text, ranges, withSyntax) {
    var out = [], ri = 0;
    function piece(a, b) {
      while (a < b) {
        while (ri < ranges.length && ranges[ri].end <= a) ri++;
        var r = ranges[ri];
        if (!r || r.start >= b) { out.push(esc(text.slice(a, b))); return; }
        if (r.start > a) { out.push(esc(text.slice(a, r.start))); a = r.start; }
        var e = Math.min(r.end, b);
        out.push('<mark class="m" data-i="' + r.i + '">' + esc(text.slice(a, e)) + '</mark>');
        a = e;
      }
    }
    if (!withSyntax) { piece(0, text.length); return out.join(''); }
    var last = 0, m;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(text))) {
      piece(last, m.index);
      var end = m.index + m[0].length;
      if (m[1]) {
        var strEnd = m.index + m[1].length;
        out.push(m[2] ? '<span class="k">' : '<span class="s">');
        piece(m.index, strEnd);
        out.push('</span>');
        piece(strEnd, end);
      } else {
        out.push('<span class="' + (m[3] ? 'b' : m[0] === 'null' ? 'z' : 'n') + '">');
        piece(m.index, end);
        out.push('</span>');
      }
      last = end;
    }
    TOKEN.lastIndex = 0;
    piece(last, text.length);
    return out.join('');
  }

  // ---- Other output formats: shared pieces ----

  // Renders text with syntax tokens ([{ start, end, cls }], sorted, not overlapping) and
  // search ranges ([{ start, end, i }], sorted) as HTML. Ranges may cross token edges; the
  // pieces of one range share its data-i.
  function renderTokens(text, tokens, ranges) {
    var out = [], ti = 0, ri = 0, pos = 0, n = text.length;
    ranges = ranges || [];
    while (pos < n) {
      while (ti < tokens.length && tokens[ti].end <= pos) ti++;
      while (ri < ranges.length && ranges[ri].end <= pos) ri++;
      var t = tokens[ti], r = ranges[ri], next = n;
      var inT = t && t.start <= pos, inR = r && r.start <= pos;
      if (t) next = Math.min(next, inT ? t.end : t.start);
      if (r) next = Math.min(next, inR ? r.end : r.start);
      var piece = esc(text.slice(pos, next));
      // A range may name its own class (the compare view's character marks have no index).
      if (inR) piece = '<mark class="' + (r.cls || 'm') + '"' + (r.cls && r.i < 0 ? '' : ' data-i="' + r.i + '"') + '>' + piece + '</mark>';
      if (inT) piece = '<span class="' + t.cls + '">' + piece + '</span>';
      out.push(piece);
      pos = next;
    }
    return out.join('');
  }

  // Searches plain text (used for YAML, CSV and TypeScript output): { matches: [{ start,
  // end }], truncated, error }. Same options as createSearch; scope does not apply.
  function searchText(text, query, options) {
    var opts = options || {}, limit = opts.limit || 10000, m = buildMatcher(query, opts);
    var res = { matches: [], truncated: false, error: m.error || null };
    if (!m.re) return res;
    var re = m.re, r;
    re.lastIndex = 0;
    while ((r = re.exec(text))) {
      if (r[0] === '') {
        if (r.index >= text.length) break;
        re.lastIndex = r.index + (text.codePointAt(r.index) > 0xffff ? 2 : 1);
        continue;
      }
      if (res.matches.length >= limit) { res.truncated = true; break; }
      res.matches.push({ start: r.index, end: r.index + r[0].length });
    }
    return res;
  }

  // ---- YAML ----

  var YAML_WORDS = /^(?:null|Null|NULL|~|true|True|TRUE|false|False|FALSE|yes|Yes|YES|no|No|NO|on|On|ON|off|Off|OFF|y|Y|n|N|=|<<)$/;
  var LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff]/;
  var YAML_UNPRINTABLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\ufeff]/;

  // Whether a string can be written without quotes and still read back as the same string
  // in YAML 1.2 and in YAML 1.1 parsers (which also treat yes/no/on/off and more as values).
  function yamlPlain(s) {
    return s !== '' && !YAML_WORDS.test(s) &&
      !/^\s|\s$/.test(s) &&                                   // leading or trailing spaces
      !/^[-?:,[\]{}#&*!|>'"%@`]/.test(s) &&                   // starts with an indicator
      !/[:#\t\r\n]/.test(s) &&                                 // : and # can start mappings and comments
      !/^[-+]?(?:[0-9]|\.[0-9]|\.(?:inf|nan)$)/i.test(s) &&   // numbers, dates, 0x1F, .5, .inf
      !/^\.(?:inf|nan)$/i.test(s) &&
      !/^[-+]?\.[0-9._]*(?:[eE][-+]?[0-9]+)?$/.test(s) &&    // ".", "..", "._": floats in YAML 1.1
      !/^[-+]?[0-9._]*[eE][-+]?[0-9]+$/.test(s) &&            // "e5": read as a float by some parsers
      !YAML_UNPRINTABLE.test(s) && !LONE_SURROGATE.test(s);
  }

  // A double-quoted YAML string. Characters YAML does not allow as-is are escaped.
  function yamlQuote(s) {
    var out = '"';
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i), c = s.charCodeAt(i);
      if (ch === '"' || ch === '\\') { out += '\\' + ch; continue; }
      if (c === 10) { out += '\\n'; continue; }
      if (c === 13) { out += '\\r'; continue; }
      if (c === 9) { out += '\\t'; continue; }
      var lone = (c >= 0xd800 && c <= 0xdbff && !(s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff)) ||
        (c >= 0xdc00 && c <= 0xdfff && !(s.charCodeAt(i - 1) >= 0xd800 && s.charCodeAt(i - 1) <= 0xdbff));
      if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || c === 0xfeff || lone) {
        out += '\\u' + ('000' + c.toString(16)).slice(-4);
      } else {
        out += ch;
      }
    }
    return out + '"';
  }

  // Whether a multi-line string can be written as a literal block scalar (|).
  function yamlBlockOk(s) {
    return s.indexOf('\n') !== -1 && /\S/.test(s) && s.indexOf('\r') === -1 &&
      !YAML_UNPRINTABLE.test(s) && !LONE_SURROGATE.test(s);
  }

  // A scalar or empty container: { head, body } where body holds the lines of a block
  // scalar (without indentation; the caller indents them). A block scalar that needs an
  // indentation indicator is only used as a mapping value (where its meaning is clear);
  // elsewhere such strings are double-quoted.
  function yamlScalar(v, unit, inMapping) {
    if (v === null) return { head: 'null', body: [] };
    if (Array.isArray(v)) return { head: '[]', body: [] };
    if (typeof v === 'object') return { head: '{}', body: [] };
    if (typeof v !== 'string') return { head: JSON.stringify(v), body: [] };
    if (yamlPlain(v)) return { head: v, body: [] };
    var indicator = /^\S/.test(v) ? '' : String(unit.length);
    if (!yamlBlockOk(v) || (indicator && !inMapping)) return { head: yamlQuote(v), body: [] };
    // Literal block with the chomping indicator that keeps trailing newlines exactly:
    // - (none), clip (one), + (keep all).
    var trailing = /\n*$/.exec(v)[0].length;
    var chomp = trailing === 0 ? '-' : trailing === 1 ? '' : '+';
    var lines = v.slice(0, v.length - trailing).split('\n');
    for (var k = 1; k < trailing; k++) lines.push('');
    return { head: '|' + indicator + chomp, body: lines };
  }

  function yamlKey(k) {
    return yamlPlain(k) ? k : yamlQuote(k);
  }

  function isFilled(v) {
    return v !== null && typeof v === 'object' && (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0);
  }

  function pushScalar(out, prefix, sc, bodyIndent) {
    out.push(prefix + sc.head);
    for (var i = 0; i < sc.body.length; i++) out.push(sc.body[i] === '' ? '' : bodyIndent + sc.body[i]);
  }

  function yamlLines(v, ind, unit, out) {
    var i, x, start;
    if (Array.isArray(v)) {
      for (i = 0; i < v.length; i++) {
        x = v[i];
        if (isFilled(x)) {
          // Compact form: the first line of the nested block goes right after "- ".
          start = out.length;
          yamlLines(x, ind + '  ', unit, out);
          out[start] = ind + '- ' + out[start].slice(ind.length + 2);
        } else {
          pushScalar(out, ind + '- ', yamlScalar(x, unit, false), ind + unit);
        }
      }
      return;
    }
    var keys = Object.keys(v);
    for (i = 0; i < keys.length; i++) {
      x = v[keys[i]];
      var key = yamlKey(keys[i]);
      if (key.length > 1000) {
        // Implicit keys are limited to 1024 characters; long ones use the explicit form.
        out.push(ind + '? ' + key);
        if (isFilled(x)) { out.push(ind + ':'); yamlLines(x, ind + unit, unit, out); }
        else pushScalar(out, ind + ': ', yamlScalar(x, unit, false), ind + unit);
      } else if (isFilled(x)) {
        out.push(ind + key + ':');
        yamlLines(x, ind + unit, unit, out);
      } else {
        pushScalar(out, ind + key + ': ', yamlScalar(x, unit, true), ind + unit);
      }
    }
  }

  // Serializes a JSON value as YAML, ending with a newline (which also keeps the last line
  // break of a |+ block). indent: 2, 4 or '\t' (YAML does not allow tabs for indentation,
  // so Tab uses 4 spaces).
  function toYaml(value, indent) {
    var unit = indent === '\t' || indent === 'tab' ? '    ' : new Array((+indent || 2) + 1).join(' ');
    var out = [];
    if (isFilled(value)) yamlLines(value, '', unit, out);
    else pushScalar(out, '', yamlScalar(value, unit, false), unit);
    return out.join('\n') + '\n';
  }

  // Syntax tokens for YAML written by toYaml: keys, strings, numbers, booleans and null.
  function yamlTokens(text) { return collectTokens(scanYaml, text, 0); }

  // The YAML scanner (see "Highlighting part of a text"). It reads whole lines, so it starts
  // at a line start; state is 0, or 1 + the indent of the block scalar the line is in.
  // onLine(start, state) is called at the start of each line.
  function scanYaml(text, from, to, state, emit, onLine) {
    var pos = from, n = text.length, block = state - 1;
    function scalar(s, at) {
      if (!s) return;
      var cls = s.charAt(0) === '"' ? 's' : /^(?:null|~)$/.test(s) ? 'z' : /^(?:true|false)$/.test(s) ? 'b' :
        /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?$/.test(s) ? 'n' : /^(?:\{\}|\[\]|\|\d?[-+]?)$/.test(s) ? null : 's';
      if (cls) emit(at, at + s.length, cls);
    }
    function quotedEnd(s, i) {
      for (i++; i < s.length; i++) { if (s.charAt(i) === '\\') i++; else if (s.charAt(i) === '"') return i + 1; }
      return s.length;
    }
    while (pos < to) {
      if (onLine) onLine(pos, block + 1);
      var nl = text.indexOf('\n', pos);
      if (nl === -1) nl = n;
      var line = text.slice(pos, nl), indent = /^ */.exec(line)[0].length;
      if (block >= 0 && (line === '' || indent > block)) {   // inside a block scalar
        if (line.length > indent) emit(pos + indent, pos + line.length, 's');
      } else {
        block = -1;
        var i = indent;
        while (line.substr(i, 2) === '- ') i += 2;
        var dashEnd = i, rest = line.slice(i), value = rest, valueAt = i;
        if (rest.charAt(0) === '?' && rest.charAt(1) === ' ') scalar(rest.slice(2), pos + i + 2);
        else {
          if (rest.charAt(0) === ':' && (rest.length === 1 || rest.charAt(1) === ' ')) { value = rest.slice(2); valueAt = i + 2; }
          else {
            var keyEnd = rest.charAt(0) === '"' ? quotedEnd(rest, 0) : rest.indexOf(':');
            if (keyEnd > 0 && rest.charAt(keyEnd) === ':' && (keyEnd + 1 === rest.length || rest.charAt(keyEnd + 1) === ' ')) {
              emit(pos + i, pos + i + keyEnd, 'k');
              value = rest.slice(keyEnd + 2);
              valueAt = i + keyEnd + 2;
            } else if (rest.charAt(0) !== '"' && keyEnd > 0 && rest.charAt(keyEnd) === ':') {
              value = rest;
            }
          }
          scalar(value, pos + valueAt);
          if (/^\|\d?[-+]?$/.test(value)) block = dashEnd > indent ? dashEnd - 2 : indent;
        }
      }
      if (nl >= n) break;
      pos = nl + 1;
    }
  }

  // ---- CSV ----

  function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  // Flattens an object into dotted column names (user.name). Arrays and empty objects stay
  // whole and become JSON text in the cell.
  function flattenRow(obj, prefix, row, columns, seen) {
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
      var name = prefix ? prefix + '.' + keys[i] : keys[i], v = obj[keys[i]];
      if (isPlainObject(v) && Object.keys(v).length) { flattenRow(v, name, row, columns, seen); continue; }
      if (!seen.has(name)) { seen.add(name); columns.push(name); }
      row.set(name, v);
    }
  }

  // RFC 4180 field: quoted when it holds the delimiter, a quote or a line break. With
  // protect on, text starting with = + - @ tab or carriage return gets a ' in front, so a
  // spreadsheet shows it instead of running it as a formula.
  function csvField(v, delimiter, protect) {
    var s, fromText = false;
    if (v === undefined || v === null) s = '';
    else if (typeof v === 'string') { s = v; fromText = true; }
    else if (typeof v === 'object') s = JSON.stringify(v);
    else s = String(v === 0 && 1 / v < 0 ? 0 : v);
    if (protect && fromText && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    if (s.indexOf(delimiter) !== -1 || /["\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function describeKind(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'an array';
    if (typeof v === 'object') return 'an object';
    return 'a ' + typeof v;
  }

  // Converts JSON to CSV. options: { delimiter: ',' | ';' | '\t', protect: true }.
  // Works on an array of objects (one row each, columns in the order keys first appear), a
  // single object (one row) or an array of plain values (a "value" column). Returns
  // { text } or { error } with a short explanation.
  function toCsv(value, options) {
    var opts = options || {}, d = opts.delimiter || ',', protect = opts.protect !== false;
    var items, i;
    if (isPlainObject(value)) items = [value];
    else if (Array.isArray(value)) items = value;
    else return { error: 'CSV needs an array of objects, but this JSON is ' + describeKind(value) + '.' };
    if (!items.length) return { error: 'The array is empty, so there are no rows to show as CSV.' };
    var objects = 0, plain = 0;
    for (i = 0; i < items.length; i++) {
      if (isPlainObject(items[i])) objects++;
      else if (items[i] === null || typeof items[i] !== 'object') plain++;
    }
    var lines = [];
    if (plain === items.length) {
      lines.push(csvField('value', d, protect));
      for (i = 0; i < items.length; i++) lines.push(csvField(items[i], d, protect));
      return { text: lines.join('\r\n') };
    }
    if (objects !== items.length) {
      return { error: 'CSV needs an array of objects, but this array ' + (objects ? 'mixes objects with other values' : 'contains arrays') + '.' };
    }
    var columns = [], seen = new Set(), rows = [];
    for (i = 0; i < items.length; i++) {
      var row = new Map();
      flattenRow(items[i], '', row, columns, seen);
      rows.push(row);
    }
    lines.push(columns.map(function (c) { return csvField(c, d, protect); }).join(d));
    for (i = 0; i < rows.length; i++) {
      var cells = [];
      for (var c = 0; c < columns.length; c++) cells.push(csvField(rows[i].get(columns[c]), d, protect));
      lines.push(cells.join(d));
    }
    return { text: lines.join('\r\n') };
  }

  // Syntax tokens for CSV: the header row as keys; numbers, booleans and text in the rows.
  function csvTokens(text, delimiter) { return collectTokens(csvScanner(delimiter), text, 1); }

  // The CSV scanner for a delimiter (see "Highlighting part of a text"). It starts at the
  // start of a field; state is 1 in the header record and 0 after it. onLine(start, state)
  // is called at the start of each record.
  function csvScanner(delimiter) {
    var d = delimiter || ',';
    return function scanCsv(text, from, to, state, emit, onLine) {
      var i = from, n = text.length, header = state === 1;
      if (onLine) onLine(from, state);
      while (i < to) {
        var start = i, quoted = text.charAt(i) === '"';
        if (quoted) {
          for (i++; i < n; i++) {
            if (text.charAt(i) === '"') { if (text.charAt(i + 1) === '"') i++; else { i++; break; } }
          }
        }
        while (i < n && text.charAt(i) !== d && text.charAt(i) !== '\r' && text.charAt(i) !== '\n') i++;
        if (i > start) {
          var raw = text.slice(start, i);
          var cls = header ? 'k' : quoted ? 's' : /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?$/.test(raw) ? 'n' :
            raw === 'true' || raw === 'false' ? 'b' : 's';
          emit(start, i, cls);
        }
        if (text.charAt(i) === d) i++;
        else if (text.charAt(i) === '\r' || text.charAt(i) === '\n') {
          if (text.charAt(i) === '\r' && text.charAt(i + 1) === '\n') i++;
          i++;
          header = false;
          if (onLine) onLine(i, 0);
        }
      }
    };
  }

  // ---- TypeScript ----
  // A type is inferred from the data and merged across array items. A type here is a union:
  // { prims: ['string', 'number', 'boolean', 'null'] in first-seen order, obj, arr } where
  // obj = { count, props: Map(key -> { t, count }) } and arr = { item }. A type with no
  // members is an empty array's item and is written as unknown.
  function tsEmpty() { return { prims: [], obj: null, arr: null }; }

  function tsInfer(v) {
    var t = tsEmpty();
    if (v === null) t.prims.push('null');
    else if (Array.isArray(v)) {
      var item = tsEmpty();
      for (var i = 0; i < v.length; i++) item = tsMerge(item, tsInfer(v[i]));
      t.arr = { item: item };
    } else if (typeof v === 'object') {
      var props = new Map(), keys = Object.keys(v);
      for (var k = 0; k < keys.length; k++) props.set(keys[k], { t: tsInfer(v[keys[k]]), count: 1 });
      t.obj = { count: 1, props: props };
    } else {
      t.prims.push(typeof v);   // string, number or boolean
      // Also noted for generated JSON Schemas: whether numbers have fractions, and a few
      // string values (for enums).
      if (typeof v === 'number') t.frac = !Number.isInteger(v);
      if (typeof v === 'string') t.strs = v.length <= 40 ? { values: new Map([[v, 1]]), total: 1, over: false } : { values: null, total: 1, over: true };
    }
    return t;
  }
  var ENUM_MAX = 12;
  function mergeStrs(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    if (a.over || b.over) return { values: null, total: a.total + b.total, over: true };
    var values = new Map(a.values);
    b.values.forEach(function (n, v) { values.set(v, (values.get(v) || 0) + n); });
    return values.size > ENUM_MAX ? { values: null, total: a.total + b.total, over: true } : { values: values, total: a.total + b.total, over: false };
  }

  function tsMerge(a, b) {
    var t = { prims: a.prims.slice(), obj: a.obj, arr: a.arr, frac: !!(a.frac || b.frac), strs: mergeStrs(a.strs, b.strs) };
    b.prims.forEach(function (p) { if (t.prims.indexOf(p) === -1) t.prims.push(p); });
    if (b.arr) t.arr = a.arr ? { item: tsMerge(a.arr.item, b.arr.item) } : b.arr;
    if (b.obj) {
      if (!a.obj) t.obj = b.obj;
      else {
        var props = new Map();
        a.obj.props.forEach(function (p, k) { props.set(k, p); });
        b.obj.props.forEach(function (p, k) {
          var q = props.get(k);
          props.set(k, q ? { t: tsMerge(q.t, p.t), count: q.count + p.count } : p);
        });
        t.obj = { count: a.obj.count + b.obj.count, props: props };
      }
    }
    return t;
  }

  // Names that would be confusing or break the output if a generated type took them.
  var TS_RESERVED = ('break case catch class const continue debugger default delete do else enum export extends false finally for ' +
    'function if import in instanceof new null return super switch this throw true try typeof var void while with implements ' +
    'interface let package private protected public static yield any boolean number string symbol bigint unknown never object ' +
    'undefined type as of declare namespace module async await keyof readonly infer is asserts unique global require ' +
    'Array Object String Number Boolean Symbol BigInt Function Date Promise Map Set Error RegExp JSON Math Record Partial Required ' +
    'Readonly Pick Omit').split(' ');

  function tsIsIdentifier(s) { return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s); }

  // "user_profile", "user-profile", "userProfile" and "User profile" all become UserProfile.
  function tsPascal(s) {
    var words = String(s).replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean);
    var name = words.map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join('');
    if (/^[0-9]/.test(name)) name = 'T' + name;
    return name;
  }

  // users -> user, categories -> category, boxes -> box, people -> person. Words that
  // already look singular (status, analysis, data) are left alone.
  var TS_IRREGULAR = { people: 'person', children: 'child', men: 'man', women: 'woman', mice: 'mouse', geese: 'goose', teeth: 'tooth', feet: 'foot', criteria: 'criterion', indices: 'index', matrices: 'matrix', vertices: 'vertex' };
  function tsSingular(word) {
    var m = /^(.*?)([A-Za-z]+)$/.exec(word);
    if (!m) return word;
    var head = m[1], w = m[2], lower = w.toLowerCase(), out;
    var fix = function (s) { return w.charAt(0) === w.charAt(0).toUpperCase() ? s.charAt(0).toUpperCase() + s.slice(1) : s; };
    if (TS_IRREGULAR[lower]) out = fix(TS_IRREGULAR[lower]);
    else if (/[^aeiou]ies$/i.test(w)) out = w.slice(0, -3) + 'y';
    else if (/(?:ss|sh|ch|x|z)es$/i.test(w)) out = w.slice(0, -2);
    else if (/(?:ss|us|is|ous)$/i.test(w) || !/s$/i.test(w) || w.length < 3) out = w;
    else out = w.slice(0, -1);
    return head + out;
  }

  function tsKey(k) { return tsIsIdentifier(k) ? k : JSON.stringify(k); }

  // Structural signature, used to give identical shapes one shared name.
  function tsSignature(t, memo) {
    if (memo.has(t)) return memo.get(t);
    var parts = t.prims.slice().sort();
    if (t.arr) parts.push('[' + tsSignature(t.arr.item, memo) + ']');
    if (t.obj) {
      var o = t.obj, props = [];
      o.props.forEach(function (p, k) { props.push(JSON.stringify(k) + (p.count < o.count ? '?' : '') + ':' + tsSignature(p.t, memo)); });
      parts.push('{' + props.sort().join(',') + '}');   // key order does not change the shape
    }
    var sig = parts.join('|');
    memo.set(t, sig);
    return sig;
  }

  // toTypeScript(value, { rootName, style: 'interface' | 'type', indent })
  //   -> { text } with export declarations, the root first, or { error } for data nested
  //   too deeply to walk.
  function toTypeScript(value, options) {
    try { return tsDeclarations(value, options || {}); } catch (e) {
      if (e instanceof RangeError) return { error: 'This JSON is nested too deeply to describe as TypeScript.' };
      throw e;
    }
  }

  function tsDeclarations(value, opts) {
    var style = opts.style === 'type' ? 'type' : 'interface';
    var unit = opts.indent === '\t' ? '\t' : new Array((Number(opts.indent) || 2) + 1).join(' ');
    var raw = String(opts.rootName == null ? '' : opts.rootName).trim();
    var rootName = tsIsIdentifier(raw) && TS_RESERVED.indexOf(raw) === -1 ? raw : tsPascal(raw);
    if (!rootName || TS_RESERVED.indexOf(rootName) !== -1) rootName = 'Root';

    var root = tsInfer(value);

    var memo = new Map(), sigToName = new Map(), used = new Set([rootName]), queue = [];

    function nameFor(obj, hint, parent) {
      var holder = { prims: [], obj: obj, arr: null };
      var sig = tsSignature(holder, memo);
      if (sigToName.has(sig)) return sigToName.get(sig);
      var base = tsPascal(hint) || 'Item';
      var name = base;
      if (used.has(name) || TS_RESERVED.indexOf(name) !== -1) name = parent + base;
      for (var n = 2; used.has(name) || TS_RESERVED.indexOf(name) !== -1; n++) name = parent + base + n;
      used.add(name);
      sigToName.set(sig, name);
      queue.push({ name: name, obj: obj });
      return name;
    }

    // hint: the key the value sits under; parent: the type that holds it.
    function expr(t, hint, parent) {
      var parts = [];
      if (t.obj) parts.push(t.obj.props.size ? nameFor(t.obj, hint, parent) : 'Record<string, unknown>');
      if (t.arr) {
        var item = t.arr.item;
        var n = (item.obj ? 1 : 0) + (item.arr ? 1 : 0) + item.prims.length;
        var singular = tsSingular(hint);
        var inner = expr(item, singular === hint ? hint + 'Item' : singular, parent);
        parts.push(n > 1 ? '(' + inner + ')[]' : inner + '[]');
      }
      t.prims.forEach(function (p) { if (p !== 'null') parts.push(p); });
      if (t.prims.indexOf('null') !== -1) parts.push('null');
      return parts.length ? parts.join(' | ') : 'unknown';
    }

    function body(obj, name) {
      var lines = [];
      obj.props.forEach(function (p, k) {
        lines.push(unit + tsKey(k) + (p.count < obj.count ? '?' : '') + ': ' + expr(p.t, k, name) + ';');
      });
      return '{\n' + lines.join('\n') + '\n}';
    }

    var decls = [];
    var rootIsObject = root.obj && root.obj.props.size && !root.arr && !root.prims.length;
    if (rootIsObject) {
      sigToName.set(tsSignature({ prims: [], obj: root.obj, arr: null }, memo), rootName);
      queue.push({ name: rootName, obj: root.obj });
    } else {
      decls.push('export type ' + rootName + ' = ' + expr(root, rootName, rootName) + ';');
    }
    for (var q = 0; q < queue.length; q++) {
      var d = queue[q], b = body(d.obj, d.name);
      decls.push(style === 'type' ? 'export type ' + d.name + ' = ' + b + ';' : 'export interface ' + d.name + ' ' + b);
    }
    return { text: decls.join('\n\n') + '\n' };
  }

  // Highlighting for the TypeScript output: property names, keywords, type names, null.
  function tsTokens(text) { return collectTokens(scanTs, text, 0); }

  // The TypeScript scanner (see "Highlighting part of a text"); it can start at any token edge.
  var TS_TOKEN = /"(?:[^"\\\n]|\\.)*"(?=\??:)|[A-Za-z_$][A-Za-z0-9_$]*(?=\??:)|\b(?:export|interface|type)\b|\b(?:string|number|boolean|unknown|Record)\b|\bnull\b|[A-Z][A-Za-z0-9_$]*/g;
  function scanTs(text, from, to, state, emit) {
    var re = TS_TOKEN, m;
    re.lastIndex = from;
    while ((m = re.exec(text)) && m.index < to) {
      var s = m[0], end = re.lastIndex;
      var after = text.charAt(end);
      var cls = after === ':' || (after === '?' && text.charAt(end + 1) === ':') ? 'k'
        : s === 'export' || s === 'interface' || s === 'type' ? 'b'
        : s === 'null' ? 'z'
        : /^[a-z]/.test(s) || s === 'Record' ? 'n' : 's';
      emit(m.index, end, cls);
      re.lastIndex = end;
    }
    re.lastIndex = 0;
  }

  // ---- Share links ----
  // The JSON travels inside the link's hash (#...), which browsers never send to a server.
  // Format: j1=<crc32>.<base64url of deflate-raw bytes>  or  u1=<crc32>.<base64url of the
  // UTF-8 bytes> (when CompressionStream is not available), then optional settings:
  // &i=2|4|tab (indent) &k=1|0 (sort keys) &m=f|m (format/minify) &v=c|t (code/tree view).
  // The number after j/u is the format version. The CRC32 of the text catches links that
  // were cut off or changed.
  var SHARE_WARN_LENGTH = 8000, SHARE_MAX_LENGTH = 1000000;
  var crcTable = null;

  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
    }
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return ('0000000' + ((crc ^ 0xffffffff) >>> 0).toString(16)).slice(-8);
  }

  function base64urlEncode(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // Returns the bytes, or null when the text is not valid base64url.
  function base64urlDecode(str) {
    if (!/^[A-Za-z0-9_-]*$/.test(str) || str.length % 4 === 1) return null;
    var b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var bin;
    try { bin = atob(b64); } catch (e) { return null; }
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // Whether this browser can make compressed (j1) links.
  function canCompress() {
    if (typeof CompressionStream !== 'function' || typeof DecompressionStream !== 'function') return false;
    try { new CompressionStream('deflate-raw'); new DecompressionStream('deflate-raw'); return true; } catch (e) { return false; }
  }

  function pipeThrough(bytes, stream) {
    var writer = stream.writable.getWriter();
    writer.write(bytes).catch(function () {});
    writer.close().catch(function () {});
    return new Response(stream.readable).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }

  function settingsSuffix(s) {
    var out = '';
    if (!s) return out;
    if (s.indent === '2' || s.indent === '4' || s.indent === 'tab') out += '&i=' + s.indent;
    if (typeof s.sortKeys === 'boolean') out += '&k=' + (s.sortKeys ? 1 : 0);
    if (s.mode === 'format' || s.mode === 'minify') out += '&m=' + (s.mode === 'minify' ? 'm' : 'f');
    if (s.view === 'code' || s.view === 'tree') out += '&v=' + (s.view === 'tree' ? 't' : 'c');
    // Compare mode
    if (s.arrays === 'position' || s.arrays === 'smart' || s.arrays === 'key') out += '&a=' + s.arrays.charAt(0);
    if (typeof s.key === 'string' && s.key && s.key.length <= 200) out += '&ak=' + encodeURIComponent(s.key);
    if (typeof s.ignoreOrder === 'boolean') out += '&ao=' + (s.ignoreOrder ? 1 : 0);
    if (typeof s.numbersEqual === 'boolean') out += '&an=' + (s.numbersEqual ? 1 : 0);
    if (typeof s.onlyChanges === 'boolean') out += '&ah=' + (s.onlyChanges ? 1 : 0);
    return out;
  }

  // Reads only known settings with known values; anything else is ignored.
  function parseShareSettings(rest) {
    var s = {}, pairs = String(rest || '').split('&');
    for (var i = 0; i < pairs.length; i++) {
      var eq = pairs[i].indexOf('='), k = pairs[i].slice(0, eq), v = pairs[i].slice(eq + 1);
      if (eq < 1) continue;
      if (k === 'i' && (v === '2' || v === '4' || v === 'tab')) s.indent = v;
      else if (k === 'k' && (v === '0' || v === '1')) s.sortKeys = v === '1';
      else if (k === 'm' && (v === 'f' || v === 'm')) s.mode = v === 'm' ? 'minify' : 'format';
      else if (k === 'v' && (v === 'c' || v === 't')) s.view = v === 't' ? 'tree' : 'code';
      else if (k === 'a' && (v === 'p' || v === 's' || v === 'k')) s.arrays = v === 'p' ? 'position' : v === 's' ? 'smart' : 'key';
      else if (k === 'ak') {
        var key = null;
        try { key = decodeURIComponent(v); } catch (e) {}
        if (key && key.length <= 200) s.key = key;
      }
      else if (k === 'ao' && (v === '0' || v === '1')) s.ignoreOrder = v === '1';
      else if (k === 'an' && (v === '0' || v === '1')) s.numbersEqual = v === '1';
      else if (k === 'ah' && (v === '0' || v === '1')) s.onlyChanges = v === '1';
    }
    return s;
  }

  // Compare links carry both documents: "<length of the original>:" then the original,
  // then the changed document, compressed or not like single links (d1= / e1=).
  function encodeCompareShare(original, changed, settings, options) {
    return encodeShare(original.length + ':' + original + changed, settings, options).then(function (hash) {
      return (hash.charAt(0) === 'j' ? 'd' : 'e') + hash.slice(1);
    });
  }

  // Makes the hash part of a share link (without "#"). options.compress: true or false to
  // force a kind (default: compressed when the browser supports it). Resolves to a string.
  function encodeShare(text, settings, options) {
    var bytes = new TextEncoder().encode(text), crc = crc32(bytes);
    var compress = options && typeof options.compress === 'boolean' ? options.compress : canCompress();
    var data = compress ? pipeThrough(bytes, new CompressionStream('deflate-raw')) : Promise.resolve(bytes);
    return data.then(function (out) {
      return (compress ? 'j1=' : 'u1=') + crc + '.' + base64urlEncode(out) + settingsSuffix(settings);
    });
  }

  // Reads a share hash ("#j1=..." or "j1=..."). Resolves to null when the hash is not a share
  // link, { ok: true, text, settings, compressed } when it opens, or { ok: false, reason }
  // with reason 'incomplete' (cut off or damaged), 'version' (made by a newer format) or
  // 'unsupported' (this browser cannot decompress it). Never throws.
  // Compare links (d1= / e1=) resolve to { ok: true, compare: true, original, changed,
  // settings, compressed }.
  function decodeShare(hash) {
    var m = /^([jude])(\d+)=([^&]*)((?:&.*)?)$/.exec(String(hash || '').replace(/^#/, ''));
    if (!m) return Promise.resolve(null);
    if (m[2] !== '1') return Promise.resolve({ ok: false, reason: 'version' });
    var fail = { ok: false, reason: 'incomplete' };
    var crc = m[3].slice(0, 8), data = m[3].charAt(8) === '.' ? base64urlDecode(m[3].slice(9)) : null;
    if (!/^[0-9a-f]{8}$/.test(crc) || !data) return Promise.resolve(fail);
    var compressed = m[1] === 'j' || m[1] === 'd', compare = m[1] === 'd' || m[1] === 'e';
    if (compressed && !canCompress()) return Promise.resolve({ ok: false, reason: 'unsupported' });
    var bytes;
    try {
      bytes = compressed ? pipeThrough(data, new DecompressionStream('deflate-raw')) : Promise.resolve(data);
    } catch (e) {
      return Promise.resolve(fail);
    }
    return bytes.then(function (b) {
      if (crc32(b) !== crc) return fail;
      var text;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(b); } catch (e) { return fail; }
      if (compare) {
        var head = /^(0|[1-9]\d{0,9}):/.exec(text), len = head ? +head[1] : -1, rest = head ? text.slice(head[0].length) : '';
        if (!head || len > rest.length) return fail;
        return { ok: true, compare: true, original: rest.slice(0, len), changed: rest.slice(len), settings: parseShareSettings(m[4]), compressed: compressed };
      }
      return { ok: true, text: text, settings: parseShareSettings(m[4]), compressed: compressed };
    }, function () { return fail; });
  }

  // Size check for a whole share link: { length, warn (long enough that some apps may cut
  // it off), tooBig (over the limit for sharing by link) }.
  function shareLinkCheck(length) {
    return { length: length, warn: length > SHARE_WARN_LENGTH, tooBig: length > SHARE_MAX_LENGTH };
  }

  // File name for downloading the output. A loaded file's name is reused (data.json ->
  // data.formatted.json, or data.min.json when minified); otherwise formatted.json or
  // minified.json. Characters that are not allowed in file names become "_".
  // format: 'json' (default), 'yaml' (data.yaml), 'csv' (data.csv) or 'ts' (data.types.ts).
  function downloadName(sourceName, minified, format) {
    var base = sourceName ? String(sourceName).replace(/^.*[\\/]/, '') : '';
    base = base.replace(/\.[^.]*$/, '').replace(/\.(min|formatted|types)$/i, '');
    base = base.replace(/[\u0000-\u001f<>:"|?*]+/g, '_').replace(/^[\s.]+|[\s.]+$/g, '');
    if (format === 'yaml' || format === 'csv') return (base || 'formatted') + '.' + format;
    if (format === 'ts') return (base || 'data') + '.types.ts';
    if (!base) return minified ? 'minified.json' : 'formatted.json';
    return base + (minified ? '.min.json' : '.formatted.json');
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
        return { text: JSON.stringify(v.slice(0, cut)).slice(0, -1) + '\u2026"', full: full, cls: 's', truncated: true, cut: cut };
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

  // ---- Comparing two documents ----
  // The parsed data is compared, not the text, so whitespace and key order are not changes.
  // One walk over both documents gives the list of changes, a JSON Patch (RFC 6902) that
  // turns the original into the changed document, and (optionally) a side-by-side view
  // with the changed lines lined up.

  var DIFF_SAME = 0, DIFF_ADD = 1, DIFF_DEL = 2, DIFF_MOD = 3, DIFF_GAP = 4;

  function jsonType(v) { return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v; }
  function pointerToken(k) { return String(k).replace(/~/g, '~0').replace(/\//g, '~1'); }
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  // The same text for equal data whatever the key order (keys sorted).
  function canonicalJson(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    var out = [], i;
    if (Array.isArray(v)) {
      for (i = 0; i < v.length; i++) out.push(canonicalJson(v[i]));
      return '[' + out.join(',') + ']';
    }
    var keys = Object.keys(v).sort();
    for (i = 0; i < keys.length; i++) out.push(JSON.stringify(keys[i]) + ':' + canonicalJson(v[keys[i]]));
    return '{' + out.join(',') + '}';
  }

  // Longest common subsequence of two sequences of numbers, with Myers' O(ND) algorithm
  // (common start and end trimmed first). Returns the matched index pairs [[i, j], ...] in
  // order, or null when the sequences differ in more than maxD places.
  function lcsPairs(A, B, maxD) {
    var n = A.length, m = B.length, pre = 0, suf = 0, out = [], k;
    while (pre < n && pre < m && A[pre] === B[pre]) pre++;
    while (suf < n - pre && suf < m - pre && A[n - 1 - suf] === B[m - 1 - suf]) suf++;
    var mid = myersPairs(A, B, pre, n - pre - suf, m - pre - suf, maxD);
    if (mid === null) return null;
    for (k = 0; k < pre; k++) out.push([k, k]);
    for (k = 0; k < mid.length; k++) out.push(mid[k]);
    for (k = 0; k < suf; k++) out.push([n - suf + k, m - suf + k]);
    return out;
  }
  function myersPairs(A, B, off, N, M, maxD) {
    var max = N + M;
    if (!max) return [];
    var limit = Math.min(max, maxD), o = max + 1, V = new Int32Array(2 * max + 3), trace = [];
    for (var d = 0; d <= limit; d++) {
      trace.push(V.slice(o - d - 1, o + d + 2));   // V after step d - 1, for k in -d-1 .. d+1
      for (var k = -d; k <= d; k += 2) {
        var x = k === -d || (k !== d && V[o + k - 1] < V[o + k + 1]) ? V[o + k + 1] : V[o + k - 1] + 1;
        var y = x - k;
        while (x < N && y < M && A[off + x] === B[off + y]) { x++; y++; }
        V[o + k] = x;
        if (x >= N && y >= M) return myersBack(trace, d, off, N, M);
      }
    }
    return null;
  }
  function myersBack(trace, D, off, N, M) {
    var x = N, y = M, pairs = [];
    for (var d = D; d > 0; d--) {
      var snap = trace[d], k = x - y, b = d + 1;
      var down = k === -d || (k !== d && snap[k - 1 + b] < snap[k + 1 + b]);
      var prevK = down ? k + 1 : k - 1, prevX = snap[prevK + b];
      var startX = down ? prevX : prevX + 1;
      while (x > startX) { x--; y--; pairs.push([off + x, off + y]); }
      x = prevX;
      y = prevX - prevK;
    }
    while (x > 0 && y > 0) { x--; y--; pairs.push([off + x, off + y]); }
    return pairs.reverse();
  }

  // Character-level differences between two strings: [{ op: '=' | '-' | '+', text }].
  // Strings too long (or too different) to compare quickly come back as one removal and
  // one insertion. Works on code points, so surrogate pairs are never split.
  function textDiff(a, b, limit) {
    if (a === b) return a ? [{ op: '=', text: a }] : [];
    var max = limit || 20000;
    var ca = Array.from(a), cb = Array.from(b), ids = Object.create(null), next = 0;
    var map = function (list) { return list.map(function (c) { return ids[c] === undefined ? (ids[c] = next++) : ids[c]; }); };
    var pairs = ca.length + cb.length <= max ? lcsPairs(map(ca), map(cb), 1000) : null;
    var out = [], push = function (op, text) {
      if (!text) return;
      var last = out[out.length - 1];
      if (last && last.op === op) last.text += text; else out.push({ op: op, text: text });
    };
    if (!pairs) { push('-', a); push('+', b); return out; }
    var i = 0, j = 0;
    for (var k = 0; k <= pairs.length; k++) {
      var pi = k < pairs.length ? pairs[k][0] : ca.length, pj = k < pairs.length ? pairs[k][1] : cb.length;
      push('-', ca.slice(i, pi).join(''));
      push('+', cb.slice(j, pj).join(''));
      if (k < pairs.length) push('=', ca[pi]);
      i = pi + 1;
      j = pj + 1;
    }
    return out;
  }

  // Raw text of every number in valid JSON, by JSON Pointer (for "1 and 1.0 are different").
  function numberTexts(text) {
    var map = new Map();
    walkJsonValues(text, function (parts, from, end, start) {
      var c = text.charCodeAt(start);
      if (c === 45 || (c >= 48 && c <= 57)) map.set(formatPath(parts, 'pointer'), text.slice(start, end));
    });
    return map;
  }

  /*
   * Compares two parsed documents. options:
   *   arrays: 'position' | 'smart' | 'key' (how array items are matched; default 'smart')
   *   key: the key for 'key' (items are matched by its value)
   *   ignoreOrder: with 'smart' or 'key', items that only moved are not changes
   *   numbersByText + rawA, rawB (maps from numberTexts): 1 and 1.0 count as different
   *   view: { indent } to also build the side-by-side view (see diffViewText)
   *   smartLimit: most differences per array for 'smart' (above it: by position, with a note)
   * Returns { changes: [{ op: 'add' | 'remove' | 'change' | 'type', pathA, pathB, before,
   * after }], patch: [JSON Patch operations], counts: { added, removed, changed }, notes,
   * view }. pathA is the path in the original (null for an addition), pathB in the changed
   * document (null for a removal).
   */
  function diffJson(a, b, options) {
    var opts = options || {}, mode = opts.arrays || 'smart', key = opts.key, ignoreOrder = !!opts.ignoreOrder;
    var byText = !!opts.numbersByText, rawA = opts.rawA, rawB = opts.rawB;
    var smartLimit = opts.smartLimit || 2000;
    var changes = [], patch = [], notes = [], noted = {};
    var counts = { added: 0, removed: 0, changed: 0 };
    var view = opts.view ? { L: [], R: [], kind: [], ci: [], marks: [], unit: opts.view.indent === '\t' ? '\t' : new Array((+opts.view.indent || 2) + 1).join(' ') } : null;

    function note(text) { if (!noted[text]) { noted[text] = true; notes.push(text); } }
    function record(op, pa, pb, before, after) {
      changes.push({ op: op, pathA: pa, pathB: pb, before: before, after: after });
      if (op === 'add') counts.added++; else if (op === 'remove') counts.removed++; else counts.changed++;
      return changes.length - 1;
    }

    // ---- The view: rows of left and right lines ----
    function row(l, r, kind, ci) {
      view.L.push(l); view.R.push(r); view.kind.push(kind); view.ci.push(ci);
      return view.kind.length - 1;
    }
    function ind(depth) { return new Array(depth + 1).join(view.unit); }
    function scalarText(v, raw) { return raw !== undefined ? raw : JSON.stringify(v); }
    function lines(v, depth, prefix, comma) {
      var t = v !== null && typeof v === 'object' ? JSON.stringify(v, null, view.unit) : JSON.stringify(v);
      var ls = t.split('\n'), pad = ind(depth);
      for (var i = 0; i < ls.length; i++) ls[i] = (i ? pad : pad + prefix) + ls[i];
      ls[ls.length - 1] += comma ? ',' : '';
      return ls;
    }
    function pairRows(left, right, kind, ci) {
      var first = -1;
      for (var i = 0; i < Math.max(left.length, right.length); i++) {
        var r = row(i < left.length ? left[i] : null, i < right.length ? right[i] : null, kind, ci);
        if (first < 0) first = r;
      }
      return first;
    }

    function rawOf(map, ptr) { return map ? map.get(ptr) : undefined; }

    // x, y: the values; hasX, hasY: whether each side has one. live: the JSON Pointer of
    // this value in the document while the patch is being applied.
    function node(x, y, hasX, hasY, prefix, depth, commaX, commaY, pa, pb, ptrA, ptrB, live, patchRemove) {
      var ci;
      if (!hasY) {
        ci = record('remove', pa, null, x);
        if (patchRemove) patch.push({ op: 'remove', path: live });
        if (view) pairRows(lines(x, depth, prefix, commaX), [], DIFF_DEL, ci);
        return;
      }
      if (!hasX) {
        ci = record('add', null, pb, undefined, y);
        patch.push({ op: 'add', path: live, value: y });
        if (view) pairRows([], lines(y, depth, prefix, commaY), DIFF_ADD, ci);
        return;
      }
      var tx = jsonType(x), ty = jsonType(y);
      if (tx !== ty) {
        ci = record('type', pa, pb, x, y);
        patch.push({ op: 'replace', path: live, value: y });
        if (view) pairRows(lines(x, depth, prefix, commaX), lines(y, depth, prefix, commaY), DIFF_MOD, ci);
        return;
      }
      if (tx === 'object' || tx === 'array') {
        var empty = tx === 'object' ? !Object.keys(x).length && !Object.keys(y).length : !x.length && !y.length;
        if (empty) {
          if (view) row(ind(depth) + prefix + (tx === 'object' ? '{}' : '[]') + (commaX ? ',' : ''),
            ind(depth) + prefix + (tx === 'object' ? '{}' : '[]') + (commaY ? ',' : ''), DIFF_SAME, -1);
          return;
        }
        if (view) row(ind(depth) + prefix + (tx === 'object' ? '{' : '['), ind(depth) + prefix + (tx === 'object' ? '{' : '['), DIFF_SAME, -1);
        if (tx === 'object') walkObject(x, y, depth + 1, pa, pb, ptrA, ptrB, live);
        else walkArray(x, y, depth + 1, pa, pb, ptrA, ptrB, live);
        if (view) row(ind(depth) + (tx === 'object' ? '}' : ']') + (commaX ? ',' : ''), ind(depth) + (tx === 'object' ? '}' : ']') + (commaY ? ',' : ''), DIFF_SAME, -1);
        return;
      }
      var rx = byText ? rawOf(rawA, ptrA) : undefined, ry = byText ? rawOf(rawB, ptrB) : undefined;
      var same = x === y && !(byText && tx === 'number' && rx !== undefined && ry !== undefined && rx !== ry);
      var lx = view ? ind(depth) + prefix + scalarText(x, rx) + (commaX ? ',' : '') : null;
      var ly = view ? ind(depth) + prefix + scalarText(y, ry) + (commaY ? ',' : '') : null;
      if (same) { if (view) row(lx, ly, DIFF_SAME, -1); return; }
      ci = record('change', pa, pb, x, y);
      patch.push({ op: 'replace', path: live, value: y });
      if (!view) return;
      var r = row(lx, ly, DIFF_MOD, ci);
      if (tx === 'string') {
        // Character-level marks inside the changed string.
        var base = (ind(depth) + prefix).length, segs = textDiff(x, y), ia = 0, ib = 0;
        for (var s = 0; s < segs.length; s++) {
          var len = segs[s].text.length;
          if (segs[s].op === '-') view.marks.push(r, 0, base + jsonStringOffset(x, ia), base + jsonStringOffset(x, ia + len));
          if (segs[s].op === '+') view.marks.push(r, 1, base + jsonStringOffset(y, ib), base + jsonStringOffset(y, ib + len));
          if (segs[s].op !== '+') ia += len;
          if (segs[s].op !== '-') ib += len;
        }
      }
    }

    // Object members: the original's keys in order, then the keys only in the changed one
    // (both sides are shown in this order, so they line up).
    function walkObject(x, y, depth, pa, pb, ptrA, ptrB, live) {
      var keys = Object.keys(x), extra = Object.keys(y).filter(function (k) { return !hasOwn(x, k); });
      var all = keys.concat(extra), lastX = keys.length - 1, lastY = -1;
      for (var i = all.length - 1; i >= 0; i--) if (hasOwn(y, all[i])) { lastY = i; break; }
      for (var k = 0; k < all.length; k++) {
        var name = all[k], tok = '/' + pointerToken(name), hx = k < keys.length, hy = hasOwn(y, name);
        node(hx ? x[name] : undefined, hy ? y[name] : undefined, hx, hy, JSON.stringify(name) + ': ', depth,
          k < lastX, k < lastY, pa.concat([name]), pb.concat([name]), ptrA + tok, ptrB + tok, live + tok, true);
      }
    }

    // Which items of two arrays are "the same item" ([[i, j], ...]) and whether those pairs
    // keep their order.
    function matchItems(x, y, pa) {
      var n = x.length, m = y.length, pairs = [], i, j;
      var mm = mode;
      if (mm === 'key') {
        var hasKey = function (v) { return v !== null && typeof v === 'object' && !Array.isArray(v) && hasOwn(v, key); };
        if (!key || !x.every(hasKey) || !y.every(hasKey)) {
          note(key ? 'Some arrays have items without "' + key + '", so they were compared smartly.' : 'No key was given, so arrays were compared smartly.');
          mm = 'smart';
        } else {
          // Items with the same key value (duplicates) are matched in the order they come.
          var seen = new Map();
          for (i = 0; i < n; i++) { var kx = canonicalJson(x[i][key]); if (!seen.has(kx)) seen.set(kx, []); seen.get(kx).push(i); }
          for (j = 0; j < m; j++) {
            var list = seen.get(canonicalJson(y[j][key]));
            if (list && list.length) pairs.push([list.shift(), j]);
          }
          if (!ignoreOrder) pairs = longestIncreasing(pairs);
          return { pairs: pairs, ordered: !ignoreOrder };
        }
      }
      if (mm === 'smart') {
        var ids = new Map(), next = 0, A = new Int32Array(n), B = new Int32Array(m);
        var id = function (v) { var c = canonicalJson(v), got = ids.get(c); if (got === undefined) { got = next++; ids.set(c, got); } return got; };
        for (i = 0; i < n; i++) A[i] = id(x[i]);
        for (j = 0; j < m; j++) B[j] = id(y[j]);
        var matched;
        if (ignoreOrder) {
          var queues = new Map();
          for (i = 0; i < n; i++) { if (!queues.has(A[i])) queues.set(A[i], []); queues.get(A[i]).push(i); }
          matched = [];
          for (j = 0; j < m; j++) { var q = queues.get(B[j]); if (q && q.length) matched.push([q.shift(), j]); }
        } else {
          matched = lcsPairs(A, B, smartLimit);
          if (matched === null) {
            note('The array at ' + (formatPath(pa, 'js') || 'the root') + ' has too many differences to match items smartly, so it was compared by position.');
            mm = 'position';
          }
        }
        if (mm === 'smart') {
          // Items left over between matches are paired up in order: changed items.
          var inA = new Uint8Array(n), inB = new Uint8Array(m);
          for (var p = 0; p < matched.length; p++) { inA[matched[p][0]] = 1; inB[matched[p][1]] = 1; }
          if (ignoreOrder) {
            var restA = [], restB = [];
            for (i = 0; i < n; i++) if (!inA[i]) restA.push(i);
            for (j = 0; j < m; j++) if (!inB[j]) restB.push(j);
            for (p = 0; p < Math.min(restA.length, restB.length); p++) matched.push([restA[p], restB[p]]);
            return { pairs: matched, ordered: false };
          }
          var ia = 0, jb = 0;
          for (p = 0; p <= matched.length; p++) {
            var ei = p < matched.length ? matched[p][0] : n, ej = p < matched.length ? matched[p][1] : m;
            alignGap(x, y, ia, ei, jb, ej, pairs);
            if (p < matched.length) pairs.push(matched[p]);
            ia = ei + 1;
            jb = ej + 1;
          }
          return { pairs: pairs, ordered: true };
        }
      }
      for (i = 0; i < Math.min(n, m); i++) pairs.push([i, i]);
      return { pairs: pairs, ordered: true };
    }

    function walkArray(x, y, depth, pa, pb, ptrA, ptrB, live) {
      var n = x.length, m = y.length, match = matchItems(x, y, pa), pairs = match.pairs, i, j, p;
      var ofA = new Int32Array(n).fill(-1), ofB = new Int32Array(m).fill(-1);
      for (p = 0; p < pairs.length; p++) { ofA[pairs[p][0]] = pairs[p][1]; ofB[pairs[p][1]] = pairs[p][0]; }
      // Patch: remove what goes, from the end so the indexes stay right.
      for (i = n - 1; i >= 0; i--) if (ofA[i] < 0) patch.push({ op: 'remove', path: live + '/' + i });
      // The order shown: removals where they were (in order) or at the end (order ignored).
      var entries = [];
      if (match.ordered) {
        var ia = 0, jb = 0;
        for (j = 0; j <= m; j++) {
          if (j < m && ofB[j] < 0) continue;
          var stop = j < m ? ofB[j] : n;
          for (; ia < stop; ia++) if (ofA[ia] < 0) entries.push([ia, -1]);
          for (; jb < j; jb++) entries.push([-1, jb]);
          if (j < m) { entries.push([ofB[j], j]); ia = ofB[j] + 1; jb = j + 1; }
        }
      } else {
        for (j = 0; j < m; j++) entries.push([ofB[j], j]);
        for (i = 0; i < n; i++) if (ofA[i] < 0) entries.push([i, -1]);
      }
      var lastX = -1, lastY = -1;
      for (p = entries.length - 1; p >= 0; p--) { if (lastX < 0 && entries[p][0] >= 0) lastX = p; if (lastY < 0 && entries[p][1] >= 0) lastY = p; }
      var cur = null;
      if (!match.ordered) { cur = []; for (i = 0; i < n; i++) if (ofA[i] >= 0) cur.push(i); }
      for (p = 0; p < entries.length; p++) {
        i = entries[p][0];
        j = entries[p][1];
        if (cur && j >= 0) {
          // Order ignored: move the matched item into place (not shown as a change).
          if (i >= 0) {
            var pos = cur.indexOf(i, j);
            if (pos !== j) {
              patch.push({ op: 'move', from: live + '/' + pos, path: live + '/' + j });
              cur.splice(pos, 1);
              cur.splice(j, 0, i);
            }
          } else cur.splice(j, 0, -1);
        }
        node(i >= 0 ? x[i] : undefined, j >= 0 ? y[j] : undefined, i >= 0, j >= 0, '', depth, p < lastX, p < lastY,
          i >= 0 ? pa.concat([i]) : null, j >= 0 ? pb.concat([j]) : null, i >= 0 ? ptrA + '/' + i : null, j >= 0 ? ptrB + '/' + j : null,
          live + '/' + (j >= 0 ? j : i), false);
      }
    }

    node(a, b, true, true, '', 0, false, false, [], [], '', '', '', true);
    if (view) {
      view.kind = Uint8Array.from(view.kind);
      view.ci = Int32Array.from(view.ci);
    }
    return { changes: changes, patch: patch, counts: counts, notes: notes, equal: !changes.length, view: view };
  }

  // How alike two array items are, from 0 to 1: for objects, the share of keys with equal
  // values; other values of the same type count as half alike (so they pair up in order).
  function itemLikeness(a, b) {
    var ta = jsonType(a), tb = jsonType(b);
    if (ta !== tb) return 0;
    if (ta !== 'object') return 0.5;
    var ka = Object.keys(a), kb = Object.keys(b), union = ka.length, same = 0;
    for (var i = 0; i < kb.length; i++) if (!hasOwn(a, kb[i])) union++;
    for (i = 0; i < ka.length; i++) if (hasOwn(b, ka[i]) && canonicalJson(a[ka[i]]) === canonicalJson(b[ka[i]])) same++;
    return union ? same / union : 1;
  }
  // Items left between two matches (x[i0..i1) removed, y[j0..j1) added): pair the ones
  // that are alike as "changed" items, in order (best total likeness). One on each side
  // always pair up; big gaps are paired in order.
  function alignGap(x, y, i0, i1, j0, j1, pairs) {
    var n = i1 - i0, m = j1 - j0, i, j;
    if (!n || !m) return;
    if (n === 1 && m === 1) { pairs.push([i0, j0]); return; }
    if (n * m > 2500) { for (i = 0; i < Math.min(n, m); i++) pairs.push([i0 + i, j0 + i]); return; }
    var score = [], sim = [];
    for (i = 0; i <= n; i++) { score.push(new Float64Array(m + 1)); sim.push(new Float64Array(m + 1)); }
    for (i = 1; i <= n; i++) {
      for (j = 1; j <= m; j++) {
        var s = itemLikeness(x[i0 + i - 1], y[j0 + j - 1]);
        sim[i][j] = s;
        var best = Math.max(score[i - 1][j], score[i][j - 1]);
        if (s >= 0.5) best = Math.max(best, score[i - 1][j - 1] + s);
        score[i][j] = best;
      }
    }
    var out = [];
    for (i = n, j = m; i > 0 && j > 0;) {
      if (sim[i][j] >= 0.5 && score[i][j] === score[i - 1][j - 1] + sim[i][j]) { out.push([i0 + i - 1, j0 + j - 1]); i--; j--; }
      else if (score[i][j] === score[i - 1][j]) i--;
      else j--;
    }
    for (i = out.length - 1; i >= 0; i--) pairs.push(out[i]);
  }

  // The longest run of pairs (sorted by j) whose i also increases: the matched items that
  // keep their order.
  function longestIncreasing(pairs) {
    var tails = [], prev = new Int32Array(pairs.length), tailIdx = [];
    for (var p = 0; p < pairs.length; p++) {
      var v = pairs[p][0], lo = 0, hi = tails.length;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (tails[mid] < v) lo = mid + 1; else hi = mid; }
      tails[lo] = v;
      tailIdx[lo] = p;
      prev[p] = lo ? tailIdx[lo - 1] : -1;
    }
    var out = [], at = tails.length ? tailIdx[tails.length - 1] : -1;
    while (at >= 0) { out.push(pairs[at]); at = prev[at]; }
    return out.reverse();
  }

  /*
   * The side-by-side view as two texts, rows lined up. context: show only the changed rows
   * and this many rows around them (unchanged parts become one "gap" row); null or
   * undefined: everything. Returns { left, right, rows, kind (Uint8Array: 0 same, 1 added,
   * 2 removed, 3 changed, 4 gap), ci (change index per row, -1), ln, rn (line numbers on
   * each side, 0 for none), gap (hidden lines per gap row), marks: { left, right } ([{ start,
   * end, cls: 'dx-del' | 'dx-add' }] in text offsets), changeRow (first row of each change) }.
   */
  function diffViewText(view, context, changeCount) {
    var n = view.kind.length, keep = new Uint8Array(n), r, k;
    if (context === null || context === undefined) keep.fill(1);
    else {
      for (r = 0; r < n; r++) {
        if (view.kind[r] !== DIFF_SAME) {
          for (k = Math.max(0, r - context); k <= Math.min(n - 1, r + context); k++) keep[k] = 1;
        }
      }
    }
    var left = [], right = [], kind = [], ci = [], ln = [], rn = [], gap = [], rowOf = new Int32Array(n).fill(-1);
    var nl = 0, nr = 0, offL = 0, offR = 0, startL = [], startR = [];
    var push = function (l, rr, kd, c, gl, gr, hidden) {
      startL.push(offL); startR.push(offR);
      left.push(l); right.push(rr); kind.push(kd); ci.push(c); ln.push(gl); rn.push(gr); gap.push(hidden);
      offL += l.length + 1; offR += rr.length + 1;
    };
    for (r = 0; r < n; r++) {
      var L = view.L[r], R = view.R[r];
      if (L !== null) nl++;
      if (R !== null) nr++;
      if (keep[r]) {
        rowOf[r] = kind.length;
        push(L === null ? '' : L, R === null ? '' : R, view.kind[r], view.ci[r], L === null ? 0 : nl, R === null ? 0 : nr, 0);
        continue;
      }
      var hidden = 0;
      for (k = r; k < n && !keep[k]; k++) hidden++;
      for (k = r; k < r + hidden; k++) { if (view.L[k] !== null && k > r) nl++; if (view.R[k] !== null && k > r) nr++; }
      var label = '\u22ef ' + hidden + ' unchanged ' + (hidden === 1 ? 'line' : 'lines');
      push(label, label, DIFF_GAP, -1, 0, 0, hidden);
      r += hidden - 1;
    }
    var marks = { left: [], right: [] };
    for (k = 0; k < view.marks.length; k += 4) {
      var at = rowOf[view.marks[k]];
      if (at < 0) continue;
      if (view.marks[k + 1] === 0) marks.left.push({ start: startL[at] + view.marks[k + 2], end: startL[at] + view.marks[k + 3], cls: 'dx-del', i: -1 });
      else marks.right.push({ start: startR[at] + view.marks[k + 2], end: startR[at] + view.marks[k + 3], cls: 'dx-add', i: -1 });
    }
    var changeRow = new Int32Array(changeCount || 0).fill(-1);
    for (r = 0; r < ci.length; r++) if (ci[r] >= 0 && changeRow[ci[r]] < 0) changeRow[ci[r]] = r;
    return {
      left: left.join('\n'), right: right.join('\n'), rows: kind.length, kind: Uint8Array.from(kind), ci: Int32Array.from(ci),
      ln: Uint32Array.from(ln), rn: Uint32Array.from(rn), gap: Uint32Array.from(gap), marks: marks, changeRow: changeRow
    };
  }

  // "3 added \u00b7 2 removed \u00b7 5 changed"
  function diffSummary(counts) {
    return counts.added + ' added \u00b7 ' + counts.removed + ' removed \u00b7 ' + counts.changed + ' changed';
  }

  // A short, one-line view of a value for the list of changes.
  function previewValue(v, max) {
    var t = v === undefined ? '' : JSON.stringify(v);
    max = max || 80;
    if (t.length <= max) return t;
    var cut = max - 1, c = t.charCodeAt(cut - 1);
    if (c >= 0xd800 && c <= 0xdbff) cut--;
    return t.slice(0, cut) + '\u2026';
  }

  // The changes as readable text, one per line, with paths in the given format.
  function diffAsText(diff, pathFormat) {
    var out = [diffSummary(diff.counts)], fmt = pathFormat || 'js';
    for (var k = 0; k < diff.changes.length; k++) {
      var c = diff.changes[k], path = formatPath(c.pathB || c.pathA, fmt) || (fmt === 'jq' ? '.' : '(root)');
      if (c.op === 'add') out.push('+ ' + path + ': ' + JSON.stringify(c.after));
      else if (c.op === 'remove') out.push('- ' + path + ': ' + JSON.stringify(c.before));
      else out.push('~ ' + path + ': ' + JSON.stringify(c.before) + ' \u2192 ' + JSON.stringify(c.after) +
        (c.op === 'type' ? ' (' + jsonType(c.before) + ' \u2192 ' + jsonType(c.after) + ')' : ''));
    }
    return out.join('\n') + '\n';
  }

  // The list of changes for the page: op, both paths and short previews (no full values).
  function diffList(diff) {
    return diff.changes.map(function (c) {
      return { op: c.op, pathA: c.pathA, pathB: c.pathB, before: c.op === 'add' ? null : previewValue(c.before), after: c.op === 'remove' ? null : previewValue(c.after),
        typeA: c.op === 'add' ? null : jsonType(c.before), typeB: c.op === 'remove' ? null : jsonType(c.after) };
    });
  }

  /*
   * Compares two texts: parses both (errors are reported per side), compares and builds the
   * view. opts: diffJson's options plus indent, context (see diffViewText) and numbersEqual
   * (false: 1 and 1.0 differ). Returns { status: 'ok', diff, list, counts, notes, view }
   * or { status: 'invalid', errors: { a, b } } (each null or { message, pos, line, col })
   * or { status: 'failed', message, deep, tooBig }.
   */
  function runDiff(textA, textB, opts) {
    return diffParsed(parseSide(textA), parseSide(textB), textA, textB, opts);
  }
  function parseSide(text) { return /\S/.test(text) ? parseInput(text) : { status: 'empty' }; }
  // runDiff after parsing (the worker keeps parsed sides between option changes).
  function diffParsed(pa, pb, textA, textB, opts) {
    var o = opts || {};
    if (pa.status === 'failed') return pa;
    if (pb.status === 'failed') return pb;
    if (pa.status !== 'ok' || pb.status !== 'ok') {
      return { status: pa.status === 'empty' || pb.status === 'empty' ? 'empty' : 'invalid',
        errors: { a: pa.status === 'invalid' ? pa.error : null, b: pb.status === 'invalid' ? pb.error : null },
        empty: { a: pa.status === 'empty', b: pb.status === 'empty' } };
    }
    try {
      var byText = o.numbersEqual === false;
      var diff = diffJson(pa.value, pb.value, {
        arrays: o.arrays, key: o.key, ignoreOrder: o.ignoreOrder, smartLimit: o.smartLimit,
        numbersByText: byText, rawA: byText ? numberTexts(textA) : null, rawB: byText ? numberTexts(textB) : null,
        view: { indent: o.indent }
      });
      return { status: 'ok', diff: diff, list: diffList(diff), counts: diff.counts, notes: diff.notes, equal: diff.equal,
        view: diffViewText(diff.view, o.context, diff.changes.length) };
    } catch (e) {
      return failure(e);
    }
  }

  // ---- Generating a JSON Schema from data ----
  // Uses the type inference of the TypeScript converter (tsInfer): keys present in every
  // object of an array are required, the others optional; mixed values allow several types;
  // shapes that repeat become $defs (built from all their occurrences); "integer" when
  // every number seen was whole; and an enum only when a few short strings clearly repeat.

  function generateSchema(value) {
    var root = tsInfer(value), memo = new Map();
    var shapes = new Map();   // signature -> { count, objs: [obj types] }
    var objSig = function (obj) { return tsSignature({ prims: [], obj: obj, arr: null }, memo); };
    (function count(t) {
      if (t.obj && t.obj.props.size) {
        var sig = objSig(t.obj), sh = shapes.get(sig);
        if (!sh) shapes.set(sig, sh = { count: 0, objs: [], name: null, built: false });
        sh.count++;
        sh.objs.push(t.obj);
        t.obj.props.forEach(function (p) { count(p.t); });
      }
      if (t.arr) count(t.arr.item);
    })(root);

    var defs = {}, used = new Set(), hasDefs = false;
    function defName(hint, parent) {
      var base = tsPascal(hint) || 'Item', name = base;
      if (used.has(name)) name = parent + base;
      for (var n = 2; used.has(name); n++) name = parent + base + n;
      used.add(name);
      return name;
    }
    function enumOf(t) {
      var s = t.strs;
      if (!s || s.over || !s.values || s.values.size < 2 || s.values.size > 6 || s.total < 4 || s.values.size * 2 > s.total) return null;
      return Array.from(s.values.keys());
    }
    function objectSchema(obj, hint, parent, top) {
      if (!obj.props.size) return { type: 'object' };
      var sig = objSig(obj), sh = shapes.get(sig);
      if (!top && sh && sh.count > 1) {
        if (!sh.name) {
          sh.name = defName(hint, parent);
          hasDefs = true;
          // One definition for every occurrence: their types merged.
          var merged = { prims: [], obj: sh.objs[0], arr: null };
          for (var i = 1; i < sh.objs.length; i++) merged = tsMerge(merged, { prims: [], obj: sh.objs[i], arr: null });
          defs[sh.name] = {};
          defs[sh.name] = buildObject(merged.obj, sh.name);
        }
        return { $ref: '#/$defs/' + pointerToken(sh.name) };
      }
      return buildObject(obj, parent);
    }
    function buildObject(obj, name) {
      var out = { type: 'object', properties: {} }, required = [];
      obj.props.forEach(function (p, k) {
        setKey(out.properties, k, build(p.t, k, name));
        if (p.count === obj.count) required.push(k);
      });
      if (required.length) out.required = required;
      return out;
    }
    function build(t, hint, parent, top) {
      var options = [], prims = [];
      t.prims.forEach(function (p) { prims.push(p === 'number' ? (t.frac ? 'number' : 'integer') : p); });
      if (t.obj) options.push(objectSchema(t.obj, hint, parent, top));
      if (t.arr) {
        var single = tsSingular(hint);
        var item = t.arr.item.prims.length || t.arr.item.obj || t.arr.item.arr ? build(t.arr.item, single === hint ? hint + 'Item' : single, parent) : null;
        options.push(item ? { type: 'array', items: item } : { type: 'array' });
      }
      if (prims.length) {
        var ps = { type: prims.length === 1 ? prims[0] : prims };
        var en = prims.length === 1 && prims[0] === 'string' ? enumOf(t) : null;
        if (en) ps['enum'] = en;
        options.push(ps);
      }
      if (!options.length) return {};
      if (options.length === 1) return options[0];
      // Simple types together become one "type" list; objects and arrays need anyOf.
      if (options.every(function (o) { return typeof o.type === 'string' && Object.keys(o).length === 1 || Array.isArray(o.type) && Object.keys(o).length === 1; })) {
        return { type: options.reduce(function (all, o) { return all.concat(o.type); }, []) };
      }
      return { anyOf: options };
    }
    var body = build(root, 'root', 'Root', true), schema = { $schema: 'https://json-schema.org/draft/2020-12/schema' };
    for (var k in body) if (hasOwn(body, k)) setKey(schema, k, body[k]);
    if (hasDefs) schema.$defs = defs;
    return schema;
  }

  // ---- JSON Schema ----
  // A validator for draft 2020-12 and draft-07, as plain code (no eval, no generated code).
  // References are resolved only inside the schema (and documents the caller passes in
  // options.schemas); nothing is ever downloaded.

  var SCHEMA_DRAFTS = {
    'json-schema.org/draft/2020-12/schema': '2020-12',
    'json-schema.org/draft/2019-09/schema': '2019-09',
    'json-schema.org/draft-07/schema': '07',
    'json-schema.org/draft-06/schema': '06',
    'json-schema.org/draft-04/schema': '04'
  };
  // The draft a $schema URI names: '2020-12', '2019-09', '07', '06', '04' or null.
  function draftOfUri(uri) {
    if (typeof uri !== 'string') return null;
    var key = uri.replace(/^https?:\/\//, '').replace(/#$/, '');
    return SCHEMA_DRAFTS[key] || null;
  }
  // Which rules to check a schema with: { draft: '2020-12' | '07', named: the $schema
  // value or null, note: a sentence when it differs from what was named, or null }.
  function schemaDialect(schema, fallback) {
    var named = schema !== null && typeof schema === 'object' && typeof schema.$schema === 'string' ? schema.$schema : null;
    var d = draftOfUri(named), def = fallback === '07' ? '07' : '2020-12';
    if (!named) return { draft: def, named: null, note: null };
    if (d === '2020-12' || d === '07') return { draft: d, named: named, note: null };
    if (d === '2019-09') return { draft: '2020-12', named: named, note: 'Draft 2019-09 is checked with the draft 2020-12 rules.' };
    if (d === '06' || d === '04') return { draft: '07', named: named, note: 'Draft-' + d + ' is checked with the draft-07 rules.' };
    return { draft: def, named: named, note: 'The $schema "' + named + '" isn\u2019t a known draft, so the draft ' + def + ' rules are used.' };
  }

  var SCHEMA_BASE = 'json-prettify:schema';
  function stripFragment(u) { var i = u.indexOf('#'); return i < 0 ? u : u.slice(0, i); }
  function resolveUri(base, ref) {
    if (ref.charAt(0) === '#') return stripFragment(base) + ref;
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) return ref;   // urn:, tag: and the like
    try { return new URL(ref, base).href; } catch (e) {}
    return ref;
  }
  function normalUri(u) {
    var r = resolveUri(SCHEMA_BASE, u);
    return /#$/.test(r) ? r.slice(0, -1) : r;
  }

  // A problem with the schema itself (bad pattern, missing reference...).
  function SchemaProblem(message) { this.schemaError = message; }
  var TIMED_OUT = { timeout: true };

  // Keywords whose values are schemas, by shape.
  var SUB_MAP = ['$defs', 'definitions', 'properties', 'patternProperties', 'dependentSchemas'];
  var SUB_ONE = ['additionalProperties', 'additionalItems', 'contains', 'propertyNames', 'not', 'if', 'then', 'else', 'unevaluatedProperties', 'unevaluatedItems', 'items'];
  var SUB_LIST = ['allOf', 'anyOf', 'oneOf', 'prefixItems', 'items'];

  // Indexes schema documents: resources by base URI, anchors, dynamic anchors, and the
  // base URI of every schema object.
  function schemaRegistry(draft) {
    var reg = { draft: draft, resources: new Map(), anchors: new Map(), dynamic: new Map(), base: new Map(), unevaluated: false };
    reg.add = function (doc, base) {
      reg.resources.set(base, doc);   // the address it was given under, and its own $id
      if (doc !== null && typeof doc === 'object' && typeof doc.$id === 'string' && !(draft === '07' && hasOwn(doc, '$ref')) && doc.$id.charAt(0) !== '#') {
        base = stripFragment(resolveUri(base, doc.$id));
      }
      reg.resources.set(base, doc);
      walk(doc, base);
    };
    function walk(node, base) {
      if (node === null || typeof node !== 'object' || Array.isArray(node) || reg.base.has(node)) return;
      var id = node.$id;
      if (typeof id === 'string' && !(draft === '07' && hasOwn(node, '$ref'))) {
        if (id.charAt(0) === '#') {
          if (draft === '07') reg.anchors.set(stripFragment(base) + id, node);
        } else {
          var abs = resolveUri(base, id), frag = abs.indexOf('#') >= 0 ? abs.slice(abs.indexOf('#') + 1) : '';
          base = stripFragment(abs);
          reg.resources.set(base, node);
          if (draft === '07' && frag && frag.charAt(0) !== '/') reg.anchors.set(base + '#' + frag, node);
        }
      }
      reg.base.set(node, base);
      if (draft === '2020-12') {
        if (typeof node.$anchor === 'string') reg.anchors.set(base + '#' + node.$anchor, node);
        if (typeof node.$dynamicAnchor === 'string') {
          reg.anchors.set(base + '#' + node.$dynamicAnchor, node);
          if (!reg.dynamic.has(base)) reg.dynamic.set(base, new Map());
          reg.dynamic.get(base).set(node.$dynamicAnchor, node);
        }
        if (hasOwn(node, 'unevaluatedProperties') || hasOwn(node, 'unevaluatedItems')) reg.unevaluated = true;
      }
      var k, i, v;
      for (k = 0; k < SUB_MAP.length; k++) {
        v = node[SUB_MAP[k]];
        if (v !== null && typeof v === 'object' && !Array.isArray(v) && hasOwn(node, SUB_MAP[k])) for (var key in v) if (hasOwn(v, key)) walk(v[key], base);
      }
      for (k = 0; k < SUB_ONE.length; k++) if (hasOwn(node, SUB_ONE[k])) walk(node[SUB_ONE[k]], base);
      for (k = 0; k < SUB_LIST.length; k++) {
        v = node[SUB_LIST[k]];
        if (Array.isArray(v) && hasOwn(node, SUB_LIST[k])) for (i = 0; i < v.length; i++) walk(v[i], base);
      }
      if (draft === '07' && node.dependencies !== null && typeof node.dependencies === 'object') {
        for (k in node.dependencies) if (hasOwn(node.dependencies, k) && !Array.isArray(node.dependencies[k])) walk(node.dependencies[k], base);
      }
    }
    // Where a reference leads: { node, base }. Throws SchemaProblem when it leads outside.
    reg.resolve = function (ref, from) {
      var abs = resolveUri(reg.base.get(from) || SCHEMA_BASE, ref), hash = abs.indexOf('#');
      var doc = hash < 0 ? abs : abs.slice(0, hash), frag = hash < 0 ? '' : abs.slice(hash + 1);
      try { frag = decodeURIComponent(frag); } catch (e) {}
      if (frag === '' || frag.charAt(0) === '/') {
        var res = reg.resources.get(doc);
        if (res === undefined) throw new SchemaProblem('The reference "' + ref + '" points outside this schema. External references aren\u2019t supported, so nothing is downloaded.');
        var node = res, base = reg.base.get(res) || doc;
        if (frag) {
          var tokens = frag.slice(1).split('/');
          for (var t = 0; t < tokens.length; t++) {
            var tok = tokens[t].replace(/~1/g, '/').replace(/~0/g, '~');
            if (Array.isArray(node) && /^(0|[1-9]\d*)$/.test(tok) && +tok < node.length) node = node[+tok];
            else if (node !== null && typeof node === 'object' && !Array.isArray(node) && hasOwn(node, tok)) node = node[tok];
            else throw new SchemaProblem('The reference "' + ref + '" points to nothing in this schema.');
            if (node !== null && typeof node === 'object' && reg.base.has(node)) base = reg.base.get(node);
          }
        }
        if (node !== null && typeof node === 'object' && !reg.base.has(node)) walk(node, base);
        return { node: node, base: base };
      }
      var anchored = reg.anchors.get(doc + '#' + frag);
      if (anchored === undefined) {
        throw new SchemaProblem(reg.resources.has(doc) ? 'The reference "' + ref + '" names an anchor that isn\u2019t in this schema.' :
          'The reference "' + ref + '" points outside this schema. External references aren\u2019t supported, so nothing is downloaded.');
      }
      return { node: anchored, base: reg.base.get(anchored) };
    };
    return reg;
  }

  // ---- Values and messages ----
  function jsonEqual(a, b) {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    return canonicalJson(a) === canonicalJson(b);
  }
  function codePointLength(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) i++;
      n++;
    }
    return n;
  }
  // Exact decimal check for multipleOf: 0.3 is a multiple of 0.1, as written.
  function decimalParts(x) {
    var m = /^(-?)(\d+)(?:\.(\d+))?(?:e([-+]?\d+))?$/i.exec(String(x));
    if (!m) return null;
    var digits = (m[2] + (m[3] || '')).replace(/^0+(?=\d)/, ''), exp = (m[4] ? +m[4] : 0) - (m[3] ? m[3].length : 0);
    return { digits: BigInt(digits), exp: exp };
  }
  function isMultipleOf(v, m) {
    if (!isFinite(v) || !isFinite(m) || m <= 0) return false;
    var a = decimalParts(Math.abs(v)), b = decimalParts(m);
    if (!a || !b) return Math.abs(v / m - Math.round(v / m)) < 1e-9;
    if (a.digits === BigInt(0)) return true;
    var e = Math.min(a.exp, b.exp);
    var A = a.digits * BigInt(10) ** BigInt(a.exp - e), B = b.digits * BigInt(10) ** BigInt(b.exp - e);
    return A % B === BigInt(0);
  }
  function typeName(v) {
    var t = jsonType(v);
    return t === 'number' && Number.isInteger(v) ? 'integer' : t;
  }
  var A_TYPE = { string: 'a string', number: 'a number', integer: 'an integer', boolean: 'a boolean', object: 'an object', array: 'an array', null: 'null' };
  function describeTypes(list) {
    var words = list.map(function (t) { return A_TYPE[t] || t; });
    return words.length <= 1 ? words.join('') : words.slice(0, -1).join(', ') + ' or ' + words[words.length - 1];
  }
  function gotText(v) {
    var t = jsonType(v);
    if (t === 'number') return Number.isInteger(v) ? 'a number (' + v + ')' : 'a number with a fraction (' + v + ')';
    return A_TYPE[t];
  }
  function shortJson(v) { return previewValue(v, 40); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  var FORMAT_NAMES = { 'date-time': 'date and time (RFC 3339)', date: 'date (YYYY-MM-DD)', time: 'time (RFC 3339)', email: 'email address', uri: 'URI',
    uuid: 'UUID', ipv4: 'IPv4 address', ipv6: 'IPv6 address', hostname: 'host name', regex: 'regular expression' };

  // ---- format (checked only when asked: by default it is a note, as the spec says) ----
  function daysIn(y, m) { return [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]; }
  function validDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    return !!m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= daysIn(+m[1], +m[2]);
  }
  function validTime(s) {
    var m = /^(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/.exec(s);
    if (!m) return false;
    var h = +m[1], mi = +m[2], sec = +m[3];
    if (h > 23 || mi > 59 || sec > 60) return false;
    if (!m[4] && (+m[6] > 23 || +m[7] > 59)) return false;
    if (sec === 60) {
      // A leap second is only 23:59:60 in UTC.
      var off = m[4] ? 0 : (m[5] === '+' ? 1 : -1) * (+m[6] * 60 + +m[7]);
      var utc = ((h * 60 + mi - off) % 1440 + 1440) % 1440;
      if (utc !== 23 * 60 + 59) return false;
    }
    return true;
  }
  function validIpv4(s) {
    var parts = s.split('.');
    return parts.length === 4 && parts.every(function (p) { return /^(0|[1-9]\d{0,2})$/.test(p) && +p <= 255; });
  }
  function validIpv6(s) {
    var tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (tail) {
      if (!validIpv4(tail[2])) return false;
      s = tail[1] + '0:0';   // an IPv4 address at the end counts as two groups
    }
    if (!/^[0-9a-fA-F:]+$/.test(s)) return false;
    var hex = /^[0-9a-fA-F]{1,4}$/, halves = s.split('::');
    var groups = function (x) { return x === '' ? [] : x.split(':'); };
    if (halves.length > 2) return false;
    if (halves.length === 2) {
      var l = groups(halves[0]), r = groups(halves[1]);
      return l.concat(r).every(function (g) { return hex.test(g); }) && l.length + r.length <= 7;
    }
    var all = s.split(':');
    return all.length === 8 && all.every(function (g) { return hex.test(g); });
  }
  function validHostname(s) {
    if (!s || s.length > 253) return false;
    var labels = s.split('.');
    return labels.every(function (l) { return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(l) && !/^..--/.test(l) || /^xn--[A-Za-z0-9-]{1,59}$/.test(l); });
  }
  function validEmail(s) {
    var at = s.lastIndexOf('@');
    if (at < 1) return false;
    var local = s.slice(0, at), domain = s.slice(at + 1);
    var atom = /^[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+)*$/;
    var quoted = /^"(?:[\x20\x21\x23-\x5b\x5d-\x7e]|\\[\x20-\x7e])*"$/;
    if (!atom.test(local) && !quoted.test(local)) return false;
    var lit = /^\[(.*)\]$/.exec(domain);
    if (lit) return /^IPv6:/i.test(lit[1]) ? validIpv6(lit[1].slice(5)) : validIpv4(lit[1]);
    return validHostname(domain);
  }
  var URI_RE = /^[A-Za-z][A-Za-z0-9+.-]*:(?:\/\/(?:(?:[A-Za-z0-9\-._~!$&'()*+,;=:]|%[0-9A-Fa-f]{2})*@)?(?:\[[0-9A-Fa-f:.]+\]|(?:[A-Za-z0-9\-._~!$&'()*+,;=]|%[0-9A-Fa-f]{2})*)(?::\d*)?(?:\/(?:[A-Za-z0-9\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})*)*|(?:\/?(?:[A-Za-z0-9\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})+(?:\/(?:[A-Za-z0-9\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})*)*)?|\/)(?:\?(?:[A-Za-z0-9\-._~!$&'()*+,;=:@\/?]|%[0-9A-Fa-f]{2})*)?(?:#(?:[A-Za-z0-9\-._~!$&'()*+,;=:@\/?]|%[0-9A-Fa-f]{2})*)?$/;
  function validUri(s) {
    if (!URI_RE.test(s)) return false;
    var auth = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^@\/?#]*@)?(\[[^\]]*\])/.exec(s);
    return !auth || validIpv6(auth[1].slice(1, -1));
  }
  var FORMAT_CHECKS = {
    'date-time': function (s) { var m = /^(\d{4}-\d{2}-\d{2})[Tt](.*)$/.exec(s); return !!m && validDate(m[1]) && validTime(m[2]); },
    date: validDate,
    time: validTime,
    email: validEmail,
    uri: validUri,
    uuid: function (s) { return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s); },
    ipv4: validIpv4,
    ipv6: validIpv6,
    hostname: validHostname,
    regex: function (s) { try { new RegExp(s, 'u'); return true; } catch (e) { return false; } }
  };

  /*
   * Validates a value against a schema. options:
   *   formats: true to check the common formats (date-time, date, time, email, uri, uuid,
   *     ipv4, ipv6, hostname, regex); otherwise "format" is only a note
   *   draft: '2020-12' (default) or '07', used when the schema has no $schema
   *   schemas: { uri: schema } more documents that references may point to (in memory)
   *   deadline: a Date.now() time to stop at (the result then has timedOut)
   *   maxErrors: most errors to collect (default 1000)
   * Returns { valid, errors: [{ path, keyword, schemaPath, message }], truncated, draft,
   * named, note } or { schemaError } when the schema itself is broken (or { timedOut }).
   * Errors in anyOf / oneOf show the closest option's errors rather than every option's.
   */
  function validateSchema(value, schema, options) {
    var o = options || {};
    if (schema !== true && schema !== false && (schema === null || typeof schema !== 'object' || Array.isArray(schema))) {
      return { schemaError: 'A schema must be an object (or true or false).' };
    }
    var dialect = schemaDialect(schema, o.draft), draft = dialect.draft, is07 = draft === '07';
    var reg = schemaRegistry(draft);
    try {
      if (o.schemas) for (var uri in o.schemas) if (hasOwn(o.schemas, uri)) reg.add(o.schemas[uri], normalUri(uri));
      reg.add(schema, SCHEMA_BASE);
    } catch (e) { return { schemaError: e.schemaError || String(e && e.message || e) }; }
    var formats = !!o.formats, deadline = o.deadline || 0, maxErrors = o.maxErrors || 1000;
    var calls = 0, truncated = false, scope = [], regexes = new Map(), keepAll = reg.unevaluated;

    function regex(src, where) {
      var re = regexes.get(src);
      if (re === undefined) {
        try { re = new RegExp(src, 'u'); } catch (e) { throw new SchemaProblem('The pattern ' + JSON.stringify(src) + ' at ' + where + ' isn\u2019t a valid regular expression.'); }
        regexes.set(src, re);
      }
      return re;
    }
    function pathOf(p) { var out = []; for (; p; p = p.up) out.push(p.key); return out.reverse(); }
    function depthOf(p) { var n = 0; for (; p; p = p.up) n++; return n; }
    function err(p, keyword, kp, message) { return { path: p, keyword: keyword, schemaPath: kp + '/' + pointerToken(keyword), message: message }; }
    function child(p, key) { return { up: p, key: key }; }
    function addAll(list, more) {
      for (var i = 0; i < more.length; i++) {
        if (list.length >= maxErrors) { truncated = true; return; }
        list.push(more[i]);
      }
    }
    function mergeSet(a, b) {
      if (a === true || b === true) return true;
      if (!b) return a;
      if (!a) return new Set(b);
      b.forEach(function (x) { a.add(x); });
      return a;
    }

    // Checks value v (at path p) against schema node (at schema location kp).
    // Returns { ok, errs, props, items }: props and items are what this schema evaluated
    // (for unevaluatedProperties / unevaluatedItems): null, a Set, or true for all.
    function check(node, v, p, kp) {
      if ((++calls & 1023) === 0 && deadline && Date.now() > deadline) throw TIMED_OUT;
      if (node === true) return { ok: true, errs: [], props: null, items: null };
      if (node === false) return { ok: false, errs: [err(p, 'false', kp.replace(/\/[^/]*$/, ''), 'No value is allowed here')], props: null, items: null };
      if (node === null || typeof node !== 'object' || Array.isArray(node)) return { ok: true, errs: [], props: null, items: null };
      var base = reg.base.get(node), pushed = false;
      if (base !== undefined && base !== scope[scope.length - 1]) { scope.push(base); pushed = true; }
      try { return keywords(node, v, p, kp); } finally { if (pushed) scope.pop(); }
    }

    // Applies a subschema. Only subschemas applied to this same value (in place: $ref, allOf,
    // if/then, dependentSchemas...) add to what it evaluated; child values have their own.
    function sub(node, v, p, kp, out, child) {
      var r = check(node, v, p, kp);
      if (!r.ok) { out.ok = false; addAll(out.errs, r.errs); }
      else if (!child) { out.props = mergeSet(out.props, r.props); out.items = mergeSet(out.items, r.items); }
      return r;
    }

    function keywords(s, v, p, kp) {
      var out = { ok: true, errs: [], props: null, items: null }, k, i, r;
      var fail = function (keyword, message, at) { out.ok = false; addAll(out.errs, [err(at || p, keyword, kp, message)]); };
      var t = jsonType(v);

      if (hasOwn(s, '$ref')) {
        var target = reg.resolve(s.$ref, s);
        sub(target.node, v, p, kp + '/$ref', out);
        if (is07) return out;   // draft-07: $ref replaces the rest of the schema
      }
      if (!is07 && hasOwn(s, '$dynamicRef')) {
        var dref = s.$dynamicRef, first = reg.resolve(dref, s), node = first.node;
        var name = dref.indexOf('#') >= 0 ? dref.slice(dref.indexOf('#') + 1) : '';
        if (name && !/^\//.test(name) && node && typeof node === 'object' && node.$dynamicAnchor === name) {
          for (i = 0; i < scope.length; i++) {
            var dyn = reg.dynamic.get(scope[i]);
            if (dyn && dyn.has(name)) { node = dyn.get(name); break; }
          }
        }
        sub(node, v, p, kp + '/$dynamicRef', out);
      }

      // Any type
      if (hasOwn(s, 'type')) {
        var types = Array.isArray(s.type) ? s.type : [s.type], tn = typeName(v), okType = false;
        for (i = 0; i < types.length; i++) if (types[i] === t || (types[i] === 'number' && t === 'number') || (types[i] === 'integer' && tn === 'integer')) okType = true;
        if (!okType) fail('type', 'Expected ' + describeTypes(types) + ', got ' + gotText(v));
      }
      if (hasOwn(s, 'enum') && Array.isArray(s.enum)) {
        var found = false;
        for (i = 0; i < s.enum.length && !found; i++) found = jsonEqual(v, s.enum[i]);
        if (!found) fail('enum', s.enum.length <= 6 ? 'Must be one of: ' + s.enum.map(shortJson).join(', ') : 'Must be one of the ' + s.enum.length + ' allowed values');
      }
      if (hasOwn(s, 'const') && !jsonEqual(v, s.const)) fail('const', 'Must be exactly ' + shortJson(s.const));

      // Numbers
      if (t === 'number') {
        if (typeof s.multipleOf === 'number' && !isMultipleOf(v, s.multipleOf)) fail('multipleOf', 'Must be a multiple of ' + s.multipleOf);
        if (typeof s.maximum === 'number' && v > s.maximum) fail('maximum', 'Must be at most ' + s.maximum);
        if (typeof s.exclusiveMaximum === 'number' && v >= s.exclusiveMaximum) fail('exclusiveMaximum', 'Must be less than ' + s.exclusiveMaximum);
        if (typeof s.minimum === 'number' && v < s.minimum) fail('minimum', 'Must be at least ' + s.minimum);
        if (typeof s.exclusiveMinimum === 'number' && v <= s.exclusiveMinimum) fail('exclusiveMinimum', 'Must be greater than ' + s.exclusiveMinimum);
      }

      // Strings
      if (t === 'string') {
        if (typeof s.maxLength === 'number' || typeof s.minLength === 'number') {
          var len = codePointLength(v);
          if (typeof s.maxLength === 'number' && len > s.maxLength) fail('maxLength', 'Must have at most ' + plural(s.maxLength, 'character', 'characters') + ' (has ' + len + ')');
          if (typeof s.minLength === 'number' && len < s.minLength) fail('minLength', 'Must have at least ' + plural(s.minLength, 'character', 'characters') + ' (has ' + len + ')');
        }
        if (typeof s.pattern === 'string' && !regex(s.pattern, kp + '/pattern').test(v)) fail('pattern', 'Must match the pattern ' + s.pattern);
        if (formats && typeof s.format === 'string' && FORMAT_CHECKS[s.format] && !FORMAT_CHECKS[s.format](v)) {
          fail('format', 'Must be a valid ' + FORMAT_NAMES[s.format]);
        }
      }

      // Arrays
      if (t === 'array') {
        var n = v.length, prefix = 0;
        if (!is07 && Array.isArray(s.prefixItems)) {
          prefix = Math.min(n, s.prefixItems.length);
          for (i = 0; i < prefix; i++) sub(s.prefixItems[i], v[i], child(p, i), kp + '/prefixItems/' + i, out, true);
          if (prefix) out.items = mergeSet(out.items, new Set(range(prefix)));
          prefix = s.prefixItems.length;
        }
        var itemsKw = hasOwn(s, 'items') ? s.items : undefined;
        if (is07 && Array.isArray(itemsKw)) {
          var m2 = Math.min(n, itemsKw.length);
          for (i = 0; i < m2; i++) sub(itemsKw[i], v[i], child(p, i), kp + '/items/' + i, out, true);
          if (hasOwn(s, 'additionalItems')) {
            for (i = itemsKw.length; i < n; i++) {
              if (s.additionalItems === false) { fail('additionalItems', 'No more than ' + plural(itemsKw.length, 'item is', 'items are') + ' allowed', child(p, i)); break; }
              sub(s.additionalItems, v[i], child(p, i), kp + '/additionalItems', out, true);
            }
          }
        } else if (itemsKw !== undefined) {
          for (i = prefix; i < n; i++) {
            if (itemsKw === false) { fail('items', prefix ? 'No more than ' + plural(prefix, 'item is', 'items are') + ' allowed' : 'Must be empty', child(p, i)); break; }
            sub(itemsKw, v[i], child(p, i), kp + '/items', out, true);
          }
          if (n > prefix) out.items = true;
        }
        if (hasOwn(s, 'contains')) {
          var matched = new Set();
          for (i = 0; i < n; i++) if (check(s.contains, v[i], child(p, i), kp + '/contains').ok) matched.add(i);
          var minC = !is07 && typeof s.minContains === 'number' ? s.minContains : 1;
          var maxC = !is07 && typeof s.maxContains === 'number' ? s.maxContains : Infinity;
          if (matched.size < minC) fail(minC === 1 && !hasOwn(s, 'minContains') ? 'contains' : 'minContains',
            'Must contain at least ' + plural(minC, 'item', 'items') + ' matching the "contains" schema (has ' + matched.size + ')');
          if (matched.size > maxC) fail('maxContains', 'Must contain at most ' + plural(maxC, 'item', 'items') + ' matching the "contains" schema (has ' + matched.size + ')');
          if (!is07) out.items = mergeSet(out.items, matched);
        }
        if (typeof s.maxItems === 'number' && n > s.maxItems) fail('maxItems', 'Must have at most ' + plural(s.maxItems, 'item', 'items') + ' (has ' + n + ')');
        if (typeof s.minItems === 'number' && n < s.minItems) fail('minItems', 'Must have at least ' + plural(s.minItems, 'item', 'items') + ' (has ' + n + ')');
        if (s.uniqueItems === true) {
          var seen = new Map();
          for (i = 0; i < n; i++) {
            var c = canonicalJson(v[i]);
            if (seen.has(c)) { fail('uniqueItems', 'Items must be unique; items ' + seen.get(c) + ' and ' + i + ' are the same'); break; }
            seen.set(c, i);
          }
        }
      }

      // Objects
      if (t === 'object') {
        var keys = Object.keys(v), props = s.properties, pats = s.patternProperties, covered = new Set();
        if (props !== null && typeof props === 'object' && hasOwn(s, 'properties')) {
          for (i = 0; i < keys.length; i++) if (hasOwn(props, keys[i])) { covered.add(keys[i]); sub(props[keys[i]], v[keys[i]], child(p, keys[i]), kp + '/properties/' + pointerToken(keys[i]), out, true); }
        }
        if (pats !== null && typeof pats === 'object' && hasOwn(s, 'patternProperties')) {
          for (k in pats) {
            if (!hasOwn(pats, k)) continue;
            var re = regex(k, kp + '/patternProperties');
            for (i = 0; i < keys.length; i++) if (re.test(keys[i])) { covered.add(keys[i]); sub(pats[k], v[keys[i]], child(p, keys[i]), kp + '/patternProperties/' + pointerToken(k), out, true); }
          }
        }
        if (hasOwn(s, 'additionalProperties')) {
          for (i = 0; i < keys.length; i++) {
            if (covered.has(keys[i])) continue;
            if (s.additionalProperties === false) fail('additionalProperties', 'Key ' + JSON.stringify(keys[i]) + ' is not allowed', child(p, keys[i]));
            else sub(s.additionalProperties, v[keys[i]], child(p, keys[i]), kp + '/additionalProperties', out, true);
            covered.add(keys[i]);
          }
        }
        if (covered.size) out.props = mergeSet(out.props, covered);
        if (hasOwn(s, 'propertyNames')) {
          for (i = 0; i < keys.length; i++) {
            r = check(s.propertyNames, keys[i], p, kp + '/propertyNames');
            if (!r.ok) {
              out.ok = false;
              addAll(out.errs, r.errs.map(function (e) { return { path: p, keyword: e.keyword, schemaPath: e.schemaPath, message: 'Key ' + JSON.stringify(keys[i]) + ': ' + e.message.charAt(0).toLowerCase() + e.message.slice(1) }; }));
            }
          }
        }
        if (Array.isArray(s.required)) {
          for (i = 0; i < s.required.length; i++) if (!hasOwn(v, s.required[i])) fail('required', 'Missing required key ' + s.required[i]);
        }
        if (typeof s.maxProperties === 'number' && keys.length > s.maxProperties) fail('maxProperties', 'Must have at most ' + plural(s.maxProperties, 'key', 'keys') + ' (has ' + keys.length + ')');
        if (typeof s.minProperties === 'number' && keys.length < s.minProperties) fail('minProperties', 'Must have at least ' + plural(s.minProperties, 'key', 'keys') + ' (has ' + keys.length + ')');
        var depReq = !is07 ? s.dependentRequired : null, depSch = !is07 ? s.dependentSchemas : null;
        if (is07 && s.dependencies !== null && typeof s.dependencies === 'object') {
          depReq = {}; depSch = {};
          for (k in s.dependencies) if (hasOwn(s.dependencies, k)) { if (Array.isArray(s.dependencies[k])) depReq[k] = s.dependencies[k]; else depSch[k] = s.dependencies[k]; }
        }
        if (depReq !== null && typeof depReq === 'object') {
          for (k in depReq) {
            if (!hasOwn(depReq, k) || !hasOwn(v, k) || !Array.isArray(depReq[k])) continue;
            for (i = 0; i < depReq[k].length; i++) if (!hasOwn(v, depReq[k][i])) fail(is07 ? 'dependencies' : 'dependentRequired', 'Key ' + k + ' requires key ' + depReq[k][i]);
          }
        }
        if (depSch !== null && typeof depSch === 'object') {
          for (k in depSch) if (hasOwn(depSch, k) && hasOwn(v, k)) sub(depSch[k], v, p, kp + (is07 ? '/dependencies/' : '/dependentSchemas/') + pointerToken(k), out);
        }
      }

      // Combining schemas
      if (Array.isArray(s.allOf)) for (i = 0; i < s.allOf.length; i++) sub(s.allOf[i], v, p, kp + '/allOf/' + i, out);
      if (Array.isArray(s.anyOf)) {
        var results = [], any = false;
        for (i = 0; i < s.anyOf.length; i++) {
          r = check(s.anyOf[i], v, p, kp + '/anyOf/' + i);
          results.push(r);
          if (r.ok) { any = true; out.props = mergeSet(out.props, r.props); out.items = mergeSet(out.items, r.items); if (!keepAll) break; }
        }
        if (!any) { out.ok = false; addAll(out.errs, closest('anyOf', results, p, kp, v)); }
      }
      if (Array.isArray(s.oneOf)) {
        var oneResults = [], passing = [];
        for (i = 0; i < s.oneOf.length; i++) {
          r = check(s.oneOf[i], v, p, kp + '/oneOf/' + i);
          oneResults.push(r);
          if (r.ok) passing.push(i);
        }
        if (passing.length === 1) { out.props = mergeSet(out.props, oneResults[passing[0]].props); out.items = mergeSet(out.items, oneResults[passing[0]].items); }
        else if (!passing.length) { out.ok = false; addAll(out.errs, closest('oneOf', oneResults, p, kp, v)); }
        else fail('oneOf', 'Must match exactly one option of "oneOf", but matches options ' + passing.slice(0, -1).map(function (x) { return x + 1; }).join(', ') + ' and ' + (passing[passing.length - 1] + 1));
      }
      if (hasOwn(s, 'not') && check(s.not, v, p, kp + '/not').ok) fail('not', 'Must not match the schema in "not"');
      if (hasOwn(s, 'if')) {
        r = check(s['if'], v, p, kp + '/if');
        if (r.ok) {
          out.props = mergeSet(out.props, r.props); out.items = mergeSet(out.items, r.items);
          if (hasOwn(s, 'then')) sub(s.then, v, p, kp + '/then', out);
        } else if (hasOwn(s, 'else')) sub(s['else'], v, p, kp + '/else', out);
      }

      // Unevaluated (after everything else, which says what was evaluated)
      if (!is07 && t === 'array' && hasOwn(s, 'unevaluatedItems')) {
        if (out.items !== true) {
          for (i = 0; i < v.length; i++) {
            if (out.items && out.items.has(i)) continue;
            if (s.unevaluatedItems === false) { fail('unevaluatedItems', 'Item ' + i + ' is not allowed (no part of the schema covers it)', child(p, i)); continue; }
            sub(s.unevaluatedItems, v[i], child(p, i), kp + '/unevaluatedItems', out, true);
          }
        }
        out.items = true;
      }
      if (!is07 && t === 'object' && hasOwn(s, 'unevaluatedProperties')) {
        if (out.props !== true) {
          var ks = Object.keys(v);
          for (i = 0; i < ks.length; i++) {
            if (out.props && out.props.has(ks[i])) continue;
            if (s.unevaluatedProperties === false) { fail('unevaluatedProperties', 'Key ' + JSON.stringify(ks[i]) + ' is not allowed (no part of the schema covers it)', child(p, ks[i])); continue; }
            sub(s.unevaluatedProperties, v[ks[i]], child(p, ks[i]), kp + '/unevaluatedProperties', out, true);
          }
        }
        out.props = true;
      }
      return out;
    }

    // anyOf / oneOf with no matching option: the errors of the option the value most likely
    // meant (no wrong type at this level, then the fewest problems), not of every option.
    function closest(keyword, results, p, kp, v) {
      var depth = depthOf(p), best = -1, bestScore = Infinity, shallowOnly = true, types = [];
      for (var i = 0; i < results.length; i++) {
        var errs = results[i].errs, shallow = 0;
        for (var k = 0; k < errs.length; k++) {
          var d = depthOf(errs[k].path), kw = errs[k].keyword;
          if ((d === depth && (kw === 'type' || kw === 'false' || kw === 'const' || kw === 'enum')) || (d === depth + 1 && (kw === 'const' || kw === 'enum'))) shallow++;
        }
        if (!(errs.length === 1 && errs[0].keyword === 'type' && depthOf(errs[0].path) === depth)) shallowOnly = false;
        else types.push(errs[0].message.replace(/^Expected (.*), got .*$/, '$1'));
        var score = shallow * 1000 + errs.length;
        if (score < bestScore) { bestScore = score; best = i; }
      }
      if (shallowOnly && types.length) {
        return [{ path: p, keyword: keyword, schemaPath: kp + '/' + keyword, message: 'Expected ' + types.join(' or ') + ', got ' + gotText(v) }];
      }
      var summary = { path: p, keyword: keyword, schemaPath: kp + '/' + keyword,
        message: 'Doesn\u2019t match any option of "' + keyword + '"; the closest is option ' + (best + 1) + (results[best].errs.length ? ':' : '') };
      return [summary].concat(results[best].errs.map(function (e) { return { path: e.path, keyword: e.keyword, schemaPath: e.schemaPath, message: e.message, within: keyword + ' option ' + (best + 1) }; }));
    }

    try {
      var res = check(schema, value, null, '#');
      return {
        valid: res.ok, truncated: truncated, draft: draft, named: dialect.named, note: dialect.note,
        errors: res.errs.map(function (e) { var x = { path: pathOf(e.path), keyword: e.keyword, schemaPath: e.schemaPath, message: e.message }; if (e.within) x.within = e.within; return x; })
      };
    } catch (e) {
      if (e === TIMED_OUT) return { timedOut: true };
      if (e instanceof SchemaProblem) return { schemaError: e.schemaError };
      if (e instanceof RangeError && !isTooBig(e)) return { schemaError: 'The schema refers to itself without end (or the data is nested too deeply) to check.' };
      throw e;
    }
  }
  function range(n) { var out = []; for (var i = 0; i < n; i++) out.push(i); return out; }

  // Groups errors that are the same problem in different places (same keyword, schema
  // location and message): [{ message, keyword, schemaPath, within, count, paths (first
  // 50), first (index into errors) }], in the order they first appear.
  function groupSchemaErrors(errors) {
    var groups = [], byKey = new Map();
    for (var i = 0; i < errors.length; i++) {
      var e = errors[i], key = e.keyword + '\u0000' + e.schemaPath + '\u0000' + e.message + '\u0000' + (e.within || '');
      var g = byKey.get(key);
      if (!g) {
        g = { message: e.message, keyword: e.keyword, schemaPath: e.schemaPath, within: e.within || null, count: 0, paths: [], first: i };
        byKey.set(key, g);
        groups.push(g);
      }
      g.count++;
      if (g.paths.length < 50) g.paths.push(e.path);
    }
    return groups;
  }

  // Line numbers (1-based) in valid JSON text for a list of paths (null where not found).
  function linesOfPaths(text, paths) {
    var want = new Map(), out = new Array(paths.length).fill(null), left = 0;
    for (var i = 0; i < paths.length; i++) {
      var ptr = formatPath(paths[i], 'pointer');
      if (!want.has(ptr)) { want.set(ptr, []); left++; }
      want.get(ptr).push(i);
    }
    if (!left) return out;
    var offsets = [];
    try {
      walkJsonValues(text, function (parts, from, end, start) {
        var list = want.get(formatPath(parts, 'pointer'));
        if (list) { offsets.push([from, list]); want.delete(formatPath(parts, 'pointer')); left--; }
        return left === 0;
      });
    } catch (e) { return out; }
    offsets.sort(function (a, b) { return a[0] - b[0]; });
    var line = 1, pos = 0;
    for (var k = 0; k < offsets.length; k++) {
      var at = offsets[k][0];
      for (var nl = text.indexOf('\n', pos); nl !== -1 && nl < at; nl = text.indexOf('\n', nl + 1)) line++;
      pos = at;
      // walkJsonValues reports a member from its key; the line of "from" is the line shown
      for (var j = 0; j < offsets[k][1].length; j++) out[offsets[k][1][j]] = line;
    }
    return out;
  }

  /*
   * Checks JSON text against schema text, both parsed here. Returns { status: 'ok', valid,
   * errors (each with line), groups, truncated, draft, named, note, dataSchema } where
   * dataSchema describes the data's own "$schema" key (if any), or { status: 'invalid',
   * side: 'data' | 'schema', error } or { status: 'schema-error', message } or
   * { status: 'timeout' }.
   */
  function runSchemaCheck(dataText, schemaText, opts, parsedData) {
    var o = opts || {};
    var ps = parseInput(schemaText);
    if (ps.status !== 'ok') return ps.status === 'invalid' ? { status: 'invalid', side: 'schema', error: ps.error } : { status: 'schema-error', message: ps.message };
    var pd = parsedData || parseInput(dataText);
    if (pd.status !== 'ok') return pd.status === 'invalid' ? { status: 'invalid', side: 'data', error: pd.error } : { status: 'schema-error', message: pd.message };
    var r = validateSchema(pd.value, ps.value, { formats: o.formats, deadline: o.deadline, maxErrors: o.maxErrors || 5000, draft: o.draft });
    if (r.timedOut) return { status: 'timeout' };
    if (r.schemaError) return { status: 'schema-error', message: r.schemaError };
    var v = pd.value, named = v !== null && typeof v === 'object' && !Array.isArray(v) && typeof v.$schema === 'string' ? v.$schema : null;
    var lines = r.errors.length ? linesOfPaths(dataText, r.errors.slice(0, 2000).map(function (e) { return e.path; })) : [];
    for (var i = 0; i < r.errors.length; i++) r.errors[i].line = i < lines.length ? lines[i] : null;
    return { status: 'ok', valid: r.valid, errors: r.errors, groups: groupSchemaErrors(r.errors), truncated: r.truncated, draft: r.draft, named: r.named, note: r.note,
      dataSchema: named ? { uri: named, draft: draftOfUri(named) } : null };
  }

  // ---- Big texts: rows and virtual scrolling ----
  // The Code view draws only the rows on screen. A row is a line of the text, and lines
  // longer than ROW_CHARS are split into several rows so no row is too wide to draw.

  var ROW_CHARS = 2000;

  // Rows of a text: one per line (ended by \n, \r\n or a lone \r), long lines split. The rows
  // cover the text exactly: row r is text.slice(starts[r], starts[r + 1]), line ending
  // included. Returns { starts (Uint32Array, rows + 1 entries), rows, lineStarts
  // (Uint32Array, lines + 1 entries, or null when every line is one row), lines, maxRowLength }.
  function rowIndex(text, rowChars) {
    var max = rowChars || ROW_CHARS, n = text.length;
    var starts = new Uint32Array(1024), rows = 0, lineStarts = new Uint32Array(1024), lines = 0, split = false, maxLen = 0;
    var grow = function (a) { var b = new Uint32Array(a.length * 2); b.set(a); return b; };
    var nextLf = text.indexOf('\n'), nextCr = text.indexOf('\r'), pos = 0;
    for (;;) {
      if (nextLf !== -1 && nextLf < pos) nextLf = text.indexOf('\n', pos);
      if (nextCr !== -1 && nextCr < pos) nextCr = text.indexOf('\r', pos);
      var end = nextLf === -1 ? nextCr : nextCr === -1 ? nextLf : Math.min(nextLf, nextCr);
      var next = end === -1 ? -1 : end + (text.charCodeAt(end) === 13 && text.charCodeAt(end + 1) === 10 ? 2 : 1);
      if (end === -1) end = n;
      if (lines === lineStarts.length) lineStarts = grow(lineStarts);
      lineStarts[lines++] = pos;
      if (rows === starts.length) starts = grow(starts);
      starts[rows++] = pos;
      var len = end - pos;
      if (len > max) {
        split = true;
        for (var prev = pos, b = pos + max; b < end; prev = b, b += max) {
          var c = text.charCodeAt(b - 1);
          if (c >= 0xd800 && c <= 0xdbff) b += b - 1 > prev ? -1 : 1;   // never split a surrogate pair
          if (b >= end) break;
          if (rows === starts.length) starts = grow(starts);
          starts[rows++] = b;
        }
        len = max;
      }
      if (len > maxLen) maxLen = len;
      if (next === -1) break;
      pos = next;
    }
    var outStarts = new Uint32Array(rows + 1);
    outStarts.set(starts.subarray(0, rows));
    outStarts[rows] = n;
    var outLines = null;
    if (split) {
      outLines = new Uint32Array(lines + 1);
      outLines.set(lineStarts.subarray(0, lines));
      outLines[lines] = n;
    }
    return { starts: outStarts, rows: rows, lineStarts: outLines, lines: lines, maxRowLength: maxLen };
  }

  // The last entry r (r < count) with starts[r] <= offset (binary search).
  function lastAtOrBefore(starts, count, offset) {
    var lo = 0, hi = count - 1;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo;
  }
  function rowOfOffset(index, offset) { return lastAtOrBefore(index.starts, index.rows, offset); }
  // Line (0-based) that row r belongs to, and the first row of a line.
  function lineOfRow(index, r) {
    return index.lineStarts ? lastAtOrBefore(index.lineStarts, index.lines, index.starts[r]) : r;
  }
  function rowOfLine(index, line) {
    return index.lineStarts ? rowOfOffset(index, index.lineStarts[Math.min(line, index.lines - 1)]) : Math.min(line, index.rows - 1);
  }
  // True for the second and later rows of a split line (the gutter shows no number there).
  function isContinuation(index, r) {
    return !!index.lineStarts && index.lineStarts[lineOfRow(index, r)] !== index.starts[r];
  }

  // Which rows to draw at a scroll position. Browsers limit how tall an element can be, so
  // above maxHeight the scroll range is scaled down: the scrollbar still covers every row,
  // and one pixel of scrolling moves more than one pixel of text. Returns { height (of the
  // scroll content), top (the position in unscaled pixels), shift (add to an unscaled
  // position to place it in the scroll content), first and last (the rows in view), scaled }.
  function virtualWindow(scrollTop, viewHeight, rows, rowHeight, pad, maxHeight) {
    var full = rows * rowHeight + 2 * pad, height = Math.min(full, maxHeight);
    var maxScroll = Math.max(0, height - viewHeight), fullScroll = Math.max(0, full - viewHeight);
    var s = Math.min(Math.max(0, scrollTop), maxScroll);
    var top = full > maxHeight && maxScroll > 0 ? s / maxScroll * fullScroll : s;
    var first = Math.min(Math.max(0, rows - 1), Math.max(0, Math.floor((top - pad) / rowHeight)));
    var last = Math.min(Math.max(0, rows - 1), Math.max(first, Math.ceil((top + viewHeight - pad) / rowHeight) - 1));
    return { height: height, top: top, shift: s - top, first: first, last: last, scaled: full > maxHeight };
  }
  // The scroll position that puts unscaled position y at the top of the view.
  function virtualScrollTop(y, viewHeight, rows, rowHeight, pad, maxHeight) {
    var full = rows * rowHeight + 2 * pad, height = Math.min(full, maxHeight);
    var maxScroll = Math.max(0, height - viewHeight), fullScroll = Math.max(0, full - viewHeight);
    var top = Math.min(Math.max(0, y), fullScroll);
    return full > maxHeight && fullScroll > 0 ? top / fullScroll * maxScroll : top;
  }

  // ---- Highlighting part of a text ----
  // A scanner finds the syntax tokens of one format from a restart point:
  // scan(text, from, to, state, emit, onLine) calls emit(start, end, cls) for each token that
  // starts before `to` (a token may end after it). state is the scanner's state at `from`;
  // the start of a text has state 0, except CSV (1: the header record). Scanners that keep
  // state per line call onLine(start, state) where a line or record starts.
  // For each row, rowRestarts finds where to start scanning so its tokens come out exactly as
  // when scanning the whole text: before a token that runs into the row, at the start of
  // the line for YAML, with the state there.

  // JSON written by JSON.stringify: strings (keys when a colon follows), numbers, true,
  // false and null. Any token edge is a restart point.
  var JSON_NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  function jsonStringEnd(text, i) {
    var n = text.length, j = i + 1;
    for (;;) {
      var q = text.indexOf('"', j);
      if (q === -1) return n;
      var b = q - 1;
      while (text.charCodeAt(b) === 92) b--;
      if ((q - 1 - b) % 2 === 0) return q + 1;
      j = q + 1;
    }
  }
  function isWordCode(c) { return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95; }
  function scanJson(text, from, to, state, emit) {
    var i = from, n = text.length;
    while (i < to) {
      var c = text.charCodeAt(i);
      if (c === 34) {
        var j = jsonStringEnd(text, i), k = j;
        while (k < n) { var w = text.charCodeAt(k); if (w === 32 || w === 9 || w === 10 || w === 13) k++; else break; }
        emit(i, j, text.charCodeAt(k) === 58 ? 'k' : 's');
        i = j;
      } else if (c === 45 || (c >= 48 && c <= 57)) {
        JSON_NUMBER.lastIndex = i;
        var m = JSON_NUMBER.exec(text);
        if (m) { emit(i, i + m[0].length, 'n'); i += m[0].length; } else i++;
      } else if ((c === 116 || c === 102 || c === 110) && !isWordCode(text.charCodeAt(i - 1))) {
        var word = c === 116 ? 'true' : c === 102 ? 'false' : 'null';
        if (text.substr(i, word.length) === word && !isWordCode(text.charCodeAt(i + word.length))) {
          emit(i, i + word.length, c === 110 ? 'z' : 'b');
          i += word.length;
        } else i++;
      } else i++;
    }
  }

  // The scanner for an output format (null: no highlighting). lineRestart: scanning has to
  // start at a line start. multiline: tokens can run over a line ending.
  function scannerFor(format, options) {
    if (format === 'json') return { scan: scanJson, initial: 0 };
    if (format === 'yaml') return { scan: scanYaml, initial: 0, lineRestart: true };
    if (format === 'csv') return { scan: csvScanner(options && options.delimiter), initial: 1, multiline: true };
    if (format === 'ts') return { scan: scanTs, initial: 0 };
    return null;
  }

  function collectTokens(scan, text, state) {
    var tokens = [];
    scan(text, 0, text.length, state, function (s, e, cls) { tokens.push({ start: s, end: e, cls: cls }); });
    return tokens;
  }

  // Restart points for the rows that cannot simply start scanning at their own start with
  // state 0: { rows, at, state } (sorted by row; Uint32Array, Uint32Array, Int32Array).
  function rowRestarts(scanner, text, index) {
    var outRows = [], outAt = [], outState = [];
    if (!scanner) return packRestarts(outRows, outAt, outState);
    var starts = index.starts, rows = index.rows;
    var record = function (r, at, st) {
      if (at !== starts[r] || st !== 0) { outRows.push(r); outAt.push(at); outState.push(st); }
    };
    if (!scanner.multiline && !scanner.lineRestart) {
      // Tokens never cross a line ending: only rows that continue a split line can start
      // inside a token. Scan just those lines.
      if (!index.lineStarts) return packRestarts(outRows, outAt, outState);
      var ls = index.lineStarts, r = 0;
      for (var line = 0; line < index.lines; line++) {
        var a = ls[line], z = ls[line + 1];
        while (r < rows && starts[r] < a) r++;           // r: the line's first row
        if (r + 1 >= rows || starts[r + 1] >= z) continue;   // one row only
        r++;
        scanner.scan(text, a, z, scanner.initial, function (s, e) {
          while (r < rows && starts[r] < z && starts[r] <= s) r++;
          while (r < rows && starts[r] < z && starts[r] < e) { record(r, s, 0); r++; }
        });
      }
      return packRestarts(outRows, outAt, outState);
    }
    // Scan the whole text once, following the line state.
    var next = 0, markAt = 0, markState = scanner.initial;
    var settle = function (upTo) {   // rows starting before upTo and not inside a token
      while (next < rows && starts[next] < upTo) { record(next, scanner.lineRestart ? markAt : starts[next], markState); next++; }
    };
    scanner.scan(text, 0, text.length, scanner.initial, function (s, e) {
      settle(s + 1);
      while (next < rows && starts[next] < e) { record(next, scanner.lineRestart ? markAt : s, markState); next++; }
    }, function (at, st) {
      settle(at);
      markAt = at;
      markState = st;
    });
    settle(Infinity);
    return packRestarts(outRows, outAt, outState);
  }
  function packRestarts(rows, at, state) {
    return { rows: Uint32Array.from(rows), at: Uint32Array.from(at), state: Int32Array.from(state) };
  }
  function restartOf(restarts, index, r) {
    var list = restarts && restarts.rows, count = list ? list.length : 0;
    if (count && list[0] <= r) {
      var k = lastAtOrBefore(list, count, r);
      if (list[k] === r) return { at: restarts.at[k], state: restarts.state[k] };
    }
    return { at: index.starts[r], state: 0 };
  }

  // HTML for row r: its text with syntax tokens (when there is a scanner) and search marks
  // (ranges: [{ start, end, i }] in text offsets, sorted; those that touch the row are used).
  function renderRow(text, index, restarts, scanner, r, ranges) {
    var s = index.starts[r], e = index.starts[r + 1], tokens = [], marks = [];
    if (scanner) {
      var from = restartOf(restarts, index, r);
      scanner.scan(text, from.at, e, from.state, function (a, b, cls) {
        if (b > s && a < e) tokens.push({ start: Math.max(a, s) - s, end: Math.min(b, e) - s, cls: cls });
      });
    }
    if (ranges && ranges.length) {
      var k = firstRangeEndingAfter(ranges, s);
      for (; k < ranges.length && ranges[k].start < e; k++) {
        var g = ranges[k];
        if (g.end > s) marks.push({ start: Math.max(g.start, s) - s, end: Math.min(g.end, e) - s, i: g.i, cls: g.cls });
      }
    }
    return renderTokens(text.slice(s, e), tokens, marks);
  }
  // Index of the first range (sorted by start, not overlapping) that ends after offset.
  function firstRangeEndingAfter(ranges, offset) {
    var lo = 0, hi = ranges.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (ranges[mid].end <= offset) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  // ---- Parsing in slices ----
  // Parses valid JSON a little at a time, so a big document can be read on the main thread
  // without freezing the page. Runs of members up to `chunk` characters go to JSON.parse
  // together; bigger objects and arrays are walked member by member, with their own stack.
  // The value equals JSON.parse(text), or sortKeys(JSON.parse(text)) when sort is set.
  // Usage: var p = createParser(text, { sort }); while (!p.step(10)) {} then p.value or p.error.
  function createParser(text, options) {
    var opts = options || {}, chunk = opts.chunk || 65536, sort = !!opts.sort, n = text.length;
    var stack = [], self = { done: false, value: undefined, error: null, step: step, progress: progress };
    var reached = 0, started = false;
    var now = typeof performance !== 'undefined' && performance.now ? function () { return performance.now(); } : Date.now;

    function ws(i) {
      while (i < n) { var c = text.charCodeAt(i); if (c === 32 || c === 9 || c === 10 || c === 13) i++; else break; }
      return i;
    }
    // End of the value starting at i, or -1 when a container runs past `limit` (or is not closed).
    function valueEnd(i, limit) {
      var c = text.charCodeAt(i);
      if (c === 34) return jsonStringEnd(text, i);
      if (c !== 123 && c !== 91) {
        while (i < n) { c = text.charCodeAt(i); if (c === 44 || c === 93 || c === 125 || c === 58 || c === 32 || c === 9 || c === 10 || c === 13) break; i++; }
        return i;
      }
      var depth = 0;
      while (i < n) {
        if (i > limit) return -1;
        c = text.charCodeAt(i);
        if (c === 34) { i = jsonStringEnd(text, i); continue; }
        if (c === 123 || c === 91) depth++;
        else if ((c === 125 || c === 93) && --depth === 0) return i + 1;
        i++;
      }
      return -1;
    }
    function fail(msg) { throw new SyntaxError(msg || 'Invalid JSON'); }
    function finishValue(v) { return sort ? sortKeys(v) : v; }
    function sortedObject(o) {
      var keys = Object.keys(o).sort(function (a, b) { return a < b ? -1 : a > b ? 1 : 0; }), out = {};
      for (var i = 0; i < keys.length; i++) setKey(out, keys[i], o[keys[i]]);
      return out;
    }
    function deliver(v) {
      var parent = stack[stack.length - 1];
      if (!parent) { self.value = v; self.done = true; return; }
      if (parent.obj) setKey(parent.container, parent.key, v);
      else parent.container.push(v);
    }
    function open(i) {   // a container too big for one piece: walk its members
      var obj = text.charCodeAt(i) === 123;
      stack.push({ obj: obj, container: obj ? {} : [], pos: i + 1, key: null });
    }
    function begin() {
      var i = ws(0);
      if (i >= n) fail('Unexpected end of JSON input');
      var c = text.charCodeAt(i);
      if (c === 123 || c === 91) {
        var e = valueEnd(i, i + chunk);
        if (e === -1) { open(i); return; }
        if (ws(e) !== n) fail();
        reached = e;
        deliver(finishValue(JSON.parse(text.slice(i, e))));
        return;
      }
      reached = n;
      deliver(JSON.parse(text));
    }
    // One unit of work on the innermost open container: close it, or parse the next run of
    // members (or open a member that is too big).
    function work() {
      var f = stack[stack.length - 1], p = ws(f.pos), c = text.charCodeAt(p);
      if (p >= n) fail('Unexpected end of JSON input');
      if (c === (f.obj ? 125 : 93)) {
        stack.pop();
        reached = p + 1;
        if (!stack.length && ws(p + 1) !== n) fail();
        deliver(f.obj && sort ? sortedObject(f.container) : f.container);
        if (stack.length) stack[stack.length - 1].pos = p + 1;
        return;
      }
      if (c === 44) {
        if (f.started) p = ws(p + 1); else fail();
      } else if (f.started) fail();
      f.started = true;
      var runStart = p, runEnd = p, q = p;
      for (;;) {
        var keyStart = q, v = q;
        if (f.obj) {
          if (text.charCodeAt(q) !== 34) fail();
          var ke = jsonStringEnd(text, q);
          v = ws(ke);
          if (text.charCodeAt(v) !== 58) fail();
          v = ws(v + 1);
        }
        var e = valueEnd(v, runStart + chunk);
        if (e !== -1 && e <= v) fail();   // a missing value
        if (e === -1 || (e - runStart > chunk && runEnd > runStart)) {
          if (runEnd > runStart) break;   // parse the run so far; this member starts the next one
          if (e === -1) {                 // a single member too big for one piece
            if (f.obj) f.key = JSON.parse(text.slice(keyStart, ke));
            f.pos = v;
            reached = v;
            open(v);
            return;
          }
        }
        runEnd = e;
        q = ws(e);
        if (text.charCodeAt(q) !== 44 || runEnd - runStart >= chunk) break;
        q = ws(q + 1);
        if (text.charCodeAt(q) === (f.obj ? 125 : 93)) fail();
      }
      var piece = JSON.parse((f.obj ? '{' : '[') + text.slice(runStart, runEnd) + (f.obj ? '}' : ']'));
      if (f.obj) {
        var keys = Object.keys(piece);
        for (var k = 0; k < keys.length; k++) setKey(f.container, keys[k], finishValue(piece[keys[k]]));
      } else {
        for (var j = 0; j < piece.length; j++) f.container.push(finishValue(piece[j]));
      }
      f.pos = runEnd;
      reached = runEnd;
    }
    // Works for about `ms` milliseconds; returns true when done (see .value and .error).
    function step(ms) {
      if (self.done) return true;
      var t0 = now();
      try {
        if (!started) { started = true; begin(); }
        while (!self.done && stack.length) {
          work();
          if (now() - t0 >= (ms || 10)) break;
        }
      } catch (e) {
        self.error = e;
        self.done = true;
      }
      return self.done;
    }
    function progress() { return n ? Math.min(1, reached / n) : 1; }
    return self;
  }

  // ---- Jobs ----
  // Everything the page does with the input, as plain functions: the same code runs in the
  // worker, and on the main thread for small inputs (or when workers are not available).
  // opts: { mode: 'format' | 'minify', indent: 2 | 4 | '\t', sort, format: 'json' | 'yaml' |
  // 'csv' | 'ts', csv: { delimiter, protect }, ts: { style, rootName }, rowChars }

  function isTooDeep(e) {
    return (e && e.name === 'RangeError' && !isTooBig(e)) || /recursion|call stack|nest/i.test(String(e && e.message));
  }
  function isTooBig(e) {
    return /invalid string length|allocation failed|out of memory|array buffer/i.test(String(e && e.message));
  }
  function failure(e, value) {
    var out = { status: 'failed', deep: isTooDeep(e), tooBig: isTooBig(e), message: String(e && e.message || e || 'Unknown error'), depth: null };
    if (value !== undefined) { try { out.depth = measure(value).depth; } catch (e2) {} }
    return out;
  }

  // Parses the input: { status: 'ok', value } | { status: 'invalid', error } | failed.
  function parseInput(text) {
    try { return { status: 'ok', value: JSON.parse(text) }; }
    catch (e) {
      // Syntax errors get a location; anything else (such as Firefox's "too much recursion"
      // on very deep input) is a failure to process valid-looking JSON.
      if (e instanceof SyntaxError) return { status: 'invalid', error: describeError(e, text) };
      return failure(e);
    }
  }

  function jobIndent(opts) {
    return opts.indent === '\t' || opts.indent === 'tab' ? '\t' : (+opts.indent || 2);
  }

  // Formats or converts a parsed value (already sorted when Sort keys is on). Returns
  // { status: 'ok', output, ... } or { status: 'unsupported', message, ... } or failed.
  function formatParsed(value, opts) {
    var indent = jobIndent(opts), format = opts.format || 'json', output;
    try {
      if (format === 'json') {
        output = opts.mode === 'minify' ? JSON.stringify(value) : JSON.stringify(value, null, indent);
      } else {
        var c = format === 'yaml' ? { text: toYaml(value, indent) } : format === 'csv' ? toCsv(value, opts.csv || {}) :
          toTypeScript(value, { style: opts.ts && opts.ts.style, rootName: opts.ts && opts.ts.rootName, indent: indent });
        if (c.error) return { status: 'unsupported', message: c.error, kind: kindOf(value), stats: measure(value) };
        output = c.text;
      }
      var scanner = scannerFor(format, opts.csv);
      var index = rowIndex(output, opts.rowChars);
      return {
        status: 'ok', output: output, outBytes: byteLen(output), kind: kindOf(value), stats: measure(value),
        index: index, restarts: rowRestarts(scanner, output, index)
      };
    } catch (e) {
      return failure(e, value);
    }
  }

  // The whole job on one thread: parse, sort, format, index the rows.
  function runJob(text, opts) {
    var info = { inBytes: byteLen(text), inLines: countLines(text) };
    var parsed = parseInput(text), out;
    if (parsed.status !== 'ok') out = parsed;
    else {
      var value = parsed.value;
      try { if (opts.sort) value = sortKeys(value); } catch (e) { out = failure(e, value); }
      if (!out) { out = formatParsed(value, opts); out.value = value; }
    }
    out.inBytes = info.inBytes;
    out.inLines = info.inLines;
    return out;
  }

  // Keeps track of the newest job, so results of older ones can be ignored.
  function createJobTracker() {
    var latest = 0;
    return {
      start: function () { return ++latest; },
      isCurrent: function (id) { return id === latest; },
      cancel: function () { latest++; },
      latest: function () { return latest; }
    };
  }

  // A job result as a message: the typed arrays go in the transfer list, the value stays.
  function resultMessage(id, out) {
    var msg = { type: 'result', id: id }, transfer = [];
    for (var k in out) if (k !== 'value' && k !== 'index' && k !== 'restarts') msg[k] = out[k];
    if (out.index) {
      msg.index = out.index;
      transfer.push(out.index.starts.buffer);
      if (out.index.lineStarts) transfer.push(out.index.lineStarts.buffer);
    }
    if (out.restarts) {
      msg.restarts = out.restarts;
      transfer.push(out.restarts.rows.buffer, out.restarts.at.buffer, out.restarts.state.buffer);
    }
    return { msg: msg, transfer: transfer };
  }

  /*
   * The worker's side of the messages. post(message, transfer) sends a reply. Requests:
   *   { type: 'job', id, version, text?, opts }  text is left out when the worker already
   *       has this version; replies { type: 'progress', id, phase } and { type: 'result', id, ... }
   *       ({ type: 'need-text', id } when it does not have the text)
   *   { type: 'search', id, query, opts }        -> { type: 'search', id, matches, ranges, truncated, error }
   *   { type: 'pathAt', id, offset }             -> { type: 'pathAt', id, path }
   *   { type: 'rangeOf', id, parts }             -> { type: 'rangeOf', id, range }
   *   { type: 'copyValue', id, parts, indent }   -> { type: 'copyValue', id, text }
   *   { type: 'repair', id, text }               -> { type: 'repair', id, result }
   *   { type: 'cancel', id }                     (sliced mode: stop that job)
   * Errors reply { type: 'error', id, message, tooBig }. The parsed value (and its sorted
   * copy) is kept, so changing an option does not parse the input again.
   * options.sliced: run on the main thread instead (when workers are not available):
   * parse in slices and pause between steps, so the page can still draw and respond.
   */
  function createWorkerHandler(post, options) {
    var sliced = !!(options && options.sliced);
    var cur = { version: null, text: null, parsed: null, sorted: null, info: null, output: null, format: null, value: undefined };
    var cancelled = {};
    var later = sliced ? function (f) { setTimeout(f, 0); } : function (f) { f(); };

    function parseSliced(id, text, done) {
      var p = createParser(text);
      (function next() {
        if (cancelled[id]) return;
        if (!p.step(12)) { later(next); return; }
        done(p.error ? parseInput(text) : { status: 'ok', value: p.value });
      })();
    }

    function job(msg) {
      var id = msg.id, opts = msg.opts || {};
      if (msg.text != null) cur = { version: msg.version, text: msg.text, parsed: null, sorted: null, info: null, output: null, format: null, value: undefined };
      else if (cur.version !== msg.version) { post({ type: 'need-text', id: id }); return; }
      var steps = [
        function (next) {
          if (cur.parsed) { next(); return; }
          post({ type: 'progress', id: id, phase: 'parse' });
          cur.info = { inBytes: byteLen(cur.text), inLines: countLines(cur.text) };
          var store = function (r) {
            cur.parsed = r;
            if (r.status === 'ok') cur.text = null;   // the value is enough from here on
            next();
          };
          if (sliced) parseSliced(id, cur.text, store); else store(parseInput(cur.text));
        },
        function (next) {
          var p = cur.parsed, out;
          if (p.status !== 'ok') {
            out = {};
            for (var k in p) if (k !== 'value') out[k] = p[k];
          } else {
            var value = p.value;
            if (opts.sort) {
              post({ type: 'progress', id: id, phase: 'sort' });
              try { value = cur.sorted || (cur.sorted = sortKeys(value)); } catch (e) { out = failure(e, value); }
            }
            if (!out) {
              post({ type: 'progress', id: id, phase: opts.format && opts.format !== 'json' ? 'convert' : 'format' });
              out = formatParsed(value, opts);
              cur.output = out.status === 'ok' ? out.output : null;
              cur.format = opts.format || 'json';
              cur.value = value;
              cur.indent = jobIndent(opts);
            }
          }
          out.inBytes = cur.info.inBytes;
          out.inLines = cur.info.inLines;
          var m = resultMessage(id, out);
          post(m.msg, m.transfer);
          next();
        }
      ];
      var i = 0;
      (function run() {
        if (cancelled[id] || i >= steps.length) return;
        var s = steps[i++];
        s(function () { later(run); });
      })();
    }

    function search(msg) {
      var opts = msg.opts || {};
      if (cur.format === 'json') {
        var s = createSearch(cur.value, msg.query, opts);
        while (!s.step(100000)) { /* run to the end */ }
        post({ type: 'search', id: msg.id, matches: s.matches, ranges: s.matches.length ? locateMatches(cur.output, s.matches) : [],
          truncated: s.truncated, error: s.error || null });
      } else {
        var r = searchText(cur.output || '', msg.query, opts);
        post({ type: 'search', id: msg.id, matches: r.matches, ranges: null, truncated: r.truncated, error: r.error || null });
      }
    }

    // Compare mode: both sides parsed and kept by version; the last diff is kept for the
    // view (with or without unchanged parts) and for exports.
    var cmp = { va: null, vb: null, a: null, b: null, ta: null, tb: null, result: null };
    function diffMessage(r) {
      var msg = { type: 'diff', id: null, status: r.status }, transfer = [];
      if (r.status === 'ok') {
        msg.list = r.list; msg.counts = r.counts; msg.notes = r.notes; msg.equal = r.equal; msg.view = r.view;
        var v = r.view;
        transfer.push(v.kind.buffer, v.ci.buffer, v.ln.buffer, v.rn.buffer, v.gap.buffer, v.changeRow.buffer);
      } else {
        for (var k in r) if (k !== 'diff') msg[k] = r[k];
      }
      return { msg: msg, transfer: transfer };
    }
    function diff(msg) {
      if (msg.a != null) { cmp.va = msg.va; cmp.ta = msg.a; cmp.a = null; }
      if (msg.b != null) { cmp.vb = msg.vb; cmp.tb = msg.b; cmp.b = null; }
      if (cmp.va !== msg.va || cmp.vb !== msg.vb) { post({ type: 'need-text', id: msg.id }); return; }
      post({ type: 'progress', id: msg.id, phase: 'parse' });
      if (!cmp.a) cmp.a = parseSide(cmp.ta);
      if (!cmp.b) cmp.b = parseSide(cmp.tb);
      post({ type: 'progress', id: msg.id, phase: 'compare' });
      var r = diffParsed(cmp.a, cmp.b, cmp.ta, cmp.tb, msg.opts);
      cmp.result = r.status === 'ok' ? r.diff : null;
      var m = diffMessage(r);
      m.msg.id = msg.id;
      post(m.msg, m.transfer);
    }

    // Schema checks: the data and the schema kept by version (texts are sent only when they
    // changed). A deadline stops long checks; the page also ends the worker if a single
    // slow pattern runs past the time limit.
    var val = { dv: null, data: null, parsed: null, sv: null, schema: null };
    function validate(msg) {
      if (msg.data != null) { val.dv = msg.dv; val.data = msg.data; val.parsed = null; }
      if (msg.schema != null) { val.sv = msg.sv; val.schema = msg.schema; }
      if (val.dv !== msg.dv || val.sv !== msg.sv) { post({ type: 'need-text', id: msg.id }); return; }
      if (!val.parsed) val.parsed = parseInput(val.data);
      var o = msg.opts || {};
      var r = runSchemaCheck(val.data, val.schema, { formats: o.formats, maxErrors: o.maxErrors, deadline: o.limitMs ? Date.now() + o.limitMs : 0 }, val.parsed);
      post({ type: 'validate', id: msg.id, result: r });
    }

    return function handle(msg) {
      try {
        switch (msg.type) {
          case 'validate': validate(msg); break;
          case 'generateSchema': post({ type: 'generateSchema', id: msg.id, schema: generateSchema(JSON.parse(msg.text)) }); break;
          case 'diff': diff(msg); break;
          case 'diffView': {
            var dv = diffViewText(cmp.result.view, msg.context, cmp.result.changes.length);
            post({ type: 'diffView', id: msg.id, view: dv }, [dv.kind.buffer, dv.ci.buffer, dv.ln.buffer, dv.rn.buffer, dv.gap.buffer, dv.changeRow.buffer]);
            break;
          }
          case 'diffExport':
            post({ type: 'diffExport', id: msg.id, text: msg.kind === 'patch' ? JSON.stringify(cmp.result.patch, null, 2) + '\n' : diffAsText(cmp.result, msg.pathFormat) });
            break;
          case 'job': job(msg); break;
          case 'cancel': cancelled[msg.id] = true; break;
          case 'search': search(msg); break;
          case 'pathAt': post({ type: 'pathAt', id: msg.id, path: pathAtOffset(cur.output || '', msg.offset) }); break;
          case 'rangeOf': post({ type: 'rangeOf', id: msg.id, range: rangeOfPath(cur.output || '', msg.parts) }); break;
          case 'copyValue': {
            var v = valueAtPath(cur.value, msg.parts);
            post({ type: 'copyValue', id: msg.id, text: v === undefined ? null : copyValueText(v, msg.indent) });
            break;
          }
          case 'repair': post({ type: 'repair', id: msg.id, result: repairJson(msg.text) }); break;
        }
      } catch (e) {
        post({ type: 'error', id: msg.id, message: String(e && e.message || e), tooBig: isTooBig(e), deep: isTooDeep(e) });
      }
    };
  }

  // The worker's start-up code. It runs inside the worker, after this whole file.
  function workerMain(self) {
    var handle = self.JsonTools.createWorkerHandler(function (msg, transfer) { self.postMessage(msg, transfer || []); });
    self.onmessage = function (e) { handle(e.data); };
  }
  // Source of the worker script: this file and the start-up code, for a Blob URL. Workers
  // made from a Blob URL also start when the page is opened from disk (file://), where
  // Chrome and Edge block loading a worker script file.
  function workerSource() {
    return '(' + jsonTools + ')(self);\n(' + workerMain + ')(self);\n';
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
    formatPath: formatPath,
    pathLabels: pathLabels,
    valueAtPath: valueAtPath,
    copyValueText: copyValueText,
    pathAtOffset: pathAtOffset,
    rangeOfPath: rangeOfPath,
    renderTokens: renderTokens,
    searchText: searchText,
    yamlPlain: yamlPlain,
    toYaml: toYaml,
    yamlTokens: yamlTokens,
    toCsv: toCsv,
    csvTokens: csvTokens,
    toTypeScript: toTypeScript,
    tsTokens: tsTokens,
    downloadName: downloadName,
    crc32: crc32,
    base64urlEncode: base64urlEncode,
    base64urlDecode: base64urlDecode,
    canCompress: canCompress,
    encodeShare: encodeShare,
    encodeCompareShare: encodeCompareShare,
    decodeShare: decodeShare,
    parseShareSettings: parseShareSettings,
    shareLinkCheck: shareLinkCheck,
    SHARE_WARN_LENGTH: SHARE_WARN_LENGTH,
    SHARE_MAX_LENGTH: SHARE_MAX_LENGTH,
    createSearch: createSearch,
    searchJson: searchJson,
    jsonStringOffset: jsonStringOffset,
    locateMatches: locateMatches,
    highlightMarked: highlightMarked,
    displayKey: displayKey,
    scalarView: scalarView,
    countLines: countLines,
    lineNumbers: lineNumbers,
    gutterDigits: gutterDigits,
    highlight: highlight,
    ROW_CHARS: ROW_CHARS,
    rowIndex: rowIndex,
    rowOfOffset: rowOfOffset,
    lineOfRow: lineOfRow,
    rowOfLine: rowOfLine,
    isContinuation: isContinuation,
    virtualWindow: virtualWindow,
    virtualScrollTop: virtualScrollTop,
    scannerFor: scannerFor,
    rowRestarts: rowRestarts,
    restartOf: restartOf,
    renderRow: renderRow,
    createParser: createParser,
    isTooDeep: isTooDeep,
    isTooBig: isTooBig,
    parseInput: parseInput,
    formatParsed: formatParsed,
    runJob: runJob,
    createJobTracker: createJobTracker,
    createWorkerHandler: createWorkerHandler,
    workerSource: workerSource,
    canonicalJson: canonicalJson,
    lcsPairs: lcsPairs,
    textDiff: textDiff,
    numberTexts: numberTexts,
    diffJson: diffJson,
    diffViewText: diffViewText,
    diffSummary: diffSummary,
    diffAsText: diffAsText,
    diffList: diffList,
    runDiff: runDiff,
    schemaDialect: schemaDialect,
    draftOfUri: draftOfUri,
    validateSchema: validateSchema,
    groupSchemaErrors: groupSchemaErrors,
    linesOfPaths: linesOfPaths,
    runSchemaCheck: runSchemaCheck,
    generateSchema: generateSchema,
    isMultipleOf: isMultipleOf,
    codePointLength: codePointLength
  };

  // Also loadable from Node for the unit tests (no effect in the browser).
  if (typeof module !== 'undefined' && module.exports) module.exports = global.JsonTools;
})(typeof window !== 'undefined' ? window : globalThis);
