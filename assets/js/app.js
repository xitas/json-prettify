/*
 * UI wiring for the JSON Formatter: reads the input, renders the result and
 * status line, and handles toolbar actions. Pure helpers live in json-tools.js.
 */
(function () {
  'use strict';

  var T = window.JsonTools;
  var fmtBytes = T.fmtBytes, byteLen = T.byteLen, esc = T.esc, describeError = T.describeError;
  var sortKeys = T.sortKeys, measure = T.measure, kindOf = T.kindOf, highlight = T.highlight;

  var $ = function (id) { return document.getElementById(id); };
  var input = $('input'), outCode = $('outCode'), outTitle = $('outTitle'), outMeta = $('outMeta'), inMeta = $('inMeta');
  var statusEl = $('status'), indentSel = $('indent'), sortBox = $('sortKeys');
  var btnFormat = $('btnFormat'), btnMinify = $('btnMinify'), btnCopy = $('btnCopy'), btnUse = $('btnUse');

  var mode = 'format';
  var lastOutput = '';
  var HIGHLIGHT_LIMIT = 400000;

  var SAMPLE = '{"order":{"id":"ORD-20481","placedAt":"2026-11-04T09:42:17Z","status":"shipped","customer":{"name":"Amina Rauf","email":"amina@example.com","vip":true},"items":[{"sku":"KB-104","name":"Mechanical keyboard","qty":1,"price":89.5},{"sku":"MS-220","name":"Wireless mouse","qty":2,"price":24.99}],"shipping":{"method":"express","trackingNumber":null,"address":{"city":"Lahore","country":"PK","postalCode":"54000"}},"total":139.48,"notes":"Leave with reception \\"Block B\\""}}';

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

  // Theme toggle. The inline script in index.html sets data-theme before first paint;
  // this keeps the button, color-scheme meta and saved choice in sync.
  var THEME_KEY = 'json-formatter-theme';
  var root = document.documentElement;
  var themeBtn = $('themeToggle');
  var themeIcon = themeBtn.querySelector('.icon');
  var colorMeta = document.querySelector('meta[name="color-scheme"]');
  var mq = function (q) { return window.matchMedia ? window.matchMedia(q) : null; };
  var reduceMotion = mq('(prefers-reduced-motion: reduce)');
  var systemDark = mq('(prefers-color-scheme: dark)');
  var fadeTimer = null;

  function savedTheme() {
    try {
      var t = localStorage.getItem(THEME_KEY);
      return t === 'light' || t === 'dark' ? t : null;
    } catch (e) { return null; }
  }

  function applyTheme(theme, animate) {
    if (animate && !(reduceMotion && reduceMotion.matches)) {
      root.classList.add('theme-switching');
      clearTimeout(fadeTimer);
      fadeTimer = setTimeout(function () { root.classList.remove('theme-switching'); }, 300);
    }
    root.setAttribute('data-theme', theme);
    if (colorMeta) colorMeta.setAttribute('content', theme);
    var label = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    themeBtn.setAttribute('aria-label', label);
    themeBtn.title = label;
    themeIcon.textContent = theme === 'dark' ? '☀︎' : '☾︎';
  }

  themeBtn.addEventListener('click', function () {
    var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next, true);
    try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
  });

  // Until the user picks a theme, keep following the system setting.
  if (systemDark) {
    var onSystemChange = function () {
      if (!savedTheme()) applyTheme(systemDark.matches ? 'dark' : 'light', true);
    };
    if (systemDark.addEventListener) systemDark.addEventListener('change', onSystemChange);
    else if (systemDark.addListener) systemDark.addListener(onSystemChange);
  }

  applyTheme(root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light', false);

  input.value = SAMPLE;
  update();
})();
