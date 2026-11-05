
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var input = $('input'), outCode = $('outCode'), outTitle = $('outTitle'), outMeta = $('outMeta'), inMeta = $('inMeta');
  var statusEl = $('status'), indentSel = $('indent'), sortBox = $('sortKeys');
  var btnFormat = $('btnFormat'), btnMinify = $('btnMinify'), btnCopy = $('btnCopy'), btnUse = $('btnUse');

  var mode = 'format';
  var lastOutput = '';
  var HIGHLIGHT_LIMIT = 400000;

  var SAMPLE = '{"order":{"id":"ORD-20481","placedAt":"2026-11-04T09:42:17Z","status":"shipped","customer":{"name":"Amina Rauf","email":"amina@example.com","vip":true},"items":[{"sku":"KB-104","name":"Mechanical keyboard","qty":1,"price":89.5},{"sku":"MS-220","name":"Wireless mouse","qty":2,"price":24.99}],"shipping":{"method":"express","trackingNumber":null,"address":{"city":"Lahore","country":"PK","postalCode":"54000"}},"total":139.48,"notes":"Leave with reception \\"Block B\\""}}';

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }
  function byteLen(s) { try { return new TextEncoder().encode(s).length; } catch (e) { return s.length; } }
  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function offsetFrom(text, line, col) {
    var lines = text.split('\n'), pos = 0, i;
    for (i = 0; i < line - 1 && i < lines.length; i++) pos += lines[i].length + 1;
    return pos + Math.max(0, col - 1);
  }

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

  function setStatus(state, pill, html) {
    statusEl.setAttribute('data-state', state);
    statusEl.innerHTML = '<span class="pill">' + pill + '</span><span class="msg">' + html + '</span>';
  }

  function setOutputPlaceholder(text) {
    lastOutput = '';
    outCode.innerHTML = '<span class="placeholder">' + esc(text) + '</span>';
    outMeta.textContent = '';
    btnCopy.disabled = true;
    btnUse.disabled = true;
  }

  function update(opts) {
    opts = opts || {};
    var text = input.value;
    var bytes = byteLen(text);
    inMeta.textContent = text.length ? fmtBytes(bytes) + ' · ' + (text.split('\n').length) + ' lines' : '';
    outTitle.textContent = mode === 'minify' ? 'Minified' : 'Formatted';

    if (!text.trim()) {
      setStatus('empty', 'Ready', 'Paste JSON on the left to begin.');
      setOutputPlaceholder('The result appears here.');
      return;
    }

    var value;
    try {
      value = JSON.parse(text);
    } catch (e) {
      var err = describeError(e, text);
      var where = err.line ? ' <code>Line ' + err.line + ', column ' + err.col + '</code>' : '';
      setStatus('invalid', 'Invalid', esc(err.message) + '.' + where);
      if (err.pos !== null) {
        var b = document.createElement('button');
        b.type = 'button'; b.textContent = 'Go to error';
        b.addEventListener('click', function () { jumpTo(err); });
        statusEl.appendChild(b);
      }
      setOutputPlaceholder('Fix the error in the input to see the result.');
      return;
    }

    if (sortBox.checked) value = sortKeys(value);
    var indent = indentSel.value === 'tab' ? '\t' : +indentSel.value;
    var result = mode === 'minify' ? JSON.stringify(value) : JSON.stringify(value, null, indent);
    lastOutput = result;

    if (result.length > HIGHLIGHT_LIMIT) outCode.textContent = result;
    else outCode.innerHTML = highlight(result);

    var stats = measure(value);
    var outBytes = byteLen(result);
    var meta = fmtBytes(outBytes);
    if (mode === 'minify' && bytes > 0) {
      var saved = Math.round((1 - outBytes / bytes) * 100);
      meta = fmtBytes(bytes) + ' → ' + fmtBytes(outBytes) + (saved > 0 ? ' (−' + saved + '%)' : '');
    }
    outMeta.textContent = meta;
    btnCopy.disabled = false;
    btnUse.disabled = false;

    var detail = kindOf(value) + ' · ' + stats.keys + (stats.keys === 1 ? ' key' : ' keys') + ' in total · depth ' + stats.depth;
    setStatus('valid', 'Valid', 'Valid JSON: ' + esc(detail) + '.');
  }

  function jumpTo(err) {
    input.focus();
    var end = Math.min(err.pos + 1, input.value.length);
    try { input.setSelectionRange(Math.min(err.pos, input.value.length), end); } catch (e) {}
    input.scrollTop = Math.max(0, (err.line - 4) * 20);
  }

  function setMode(m) {
    mode = m;
    btnFormat.classList.toggle('active', m === 'format');
    btnMinify.classList.toggle('active', m === 'minify');
    update();
  }

  btnFormat.addEventListener('click', function () { setMode('format'); });
  btnMinify.addEventListener('click', function () { setMode('minify'); });
  $('btnValidate').addEventListener('click', function () {
    update();
    var b = statusEl.querySelector('button');
    if (b) b.focus();
  });
  indentSel.addEventListener('change', function () { setMode('format'); });
  sortBox.addEventListener('change', function () { update(); });

  var timer = null;
  input.addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(update, 160);
  });
  input.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); setMode('format'); }
  });

  $('btnSample').addEventListener('click', function () { input.value = SAMPLE; setMode('format'); });
  $('btnClear').addEventListener('click', function () { input.value = ''; update(); input.focus(); });

  btnUse.addEventListener('click', function () {
    if (!lastOutput) return;
    input.value = lastOutput;
    update();
  });

  btnCopy.addEventListener('click', function () {
    if (!lastOutput) return;
    var done = function () {
      btnCopy.textContent = 'Copied';
      setTimeout(function () { btnCopy.textContent = 'Copy'; }, 1500);
    };
    var fallback = function () {
      var r = document.createRange();
      r.selectNodeContents(outCode);
      var sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(r);
      btnCopy.textContent = 'Press Ctrl/Cmd + C';
      setTimeout(function () { btnCopy.textContent = 'Copy'; }, 2500);
    };
    try {
      navigator.clipboard.writeText(lastOutput).then(done, fallback);
    } catch (e) { fallback(); }
  });

  $('fileIn').addEventListener('change', function (e) {
    var f = e.target.files && e.target.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () { input.value = String(reader.result || ''); setMode('format'); };
    reader.readAsText(f);
    e.target.value = '';
  });

  input.value = SAMPLE;
  update();
})();
