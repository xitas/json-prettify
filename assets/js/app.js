/*
 * UI wiring for the JSON Formatter: reads the input, renders the result and
 * status bar, and handles toolbar actions. Pure helpers live in json-tools.js.
 */
(function () {
  'use strict';

  var T = window.JsonTools;
  var fmtBytes = T.fmtBytes, byteLen = T.byteLen, esc = T.esc, describeError = T.describeError;
  var sortKeys = T.sortKeys, measure = T.measure, kindOf = T.kindOf, highlight = T.highlight;

  var $ = function (id) { return document.getElementById(id); };
  var input = $('input'), output = $('output'), outCode = $('outCode'), outTitle = $('outTitle');
  var outMeta = $('outMeta'), inMeta = $('inMeta');
  var outEmpty = $('outEmpty'), outEmptyTitle = $('outEmptyTitle'), outEmptyText = $('outEmptyText');
  var statusEl = $('status'), indentSel = $('indent'), sortBox = $('sortKeys');
  var btnFormat = $('btnFormat'), btnMinify = $('btnMinify'), btnCopy = $('btnCopy'), btnUse = $('btnUse');
  var copyLabel = btnCopy.querySelector('.label');

  var mode = 'format';
  var lastOutput = '';
  var lastView = '';
  var HIGHLIGHT_LIMIT = 400000;

  var SAMPLE = '{"order":{"id":"ORD-20481","placedAt":"2026-11-04T09:42:17Z","status":"shipped","customer":{"name":"Amina Rauf","email":"amina@example.com","vip":true},"items":[{"sku":"KB-104","name":"Mechanical keyboard","qty":1,"price":89.5},{"sku":"MS-220","name":"Wireless mouse","qty":2,"price":24.99}],"shipping":{"method":"express","trackingNumber":null,"address":{"city":"Lahore","country":"PK","postalCode":"54000"}},"total":139.48,"notes":"Leave with reception \\"Block B\\""}}';

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  // Builds badge markup from a list of plain-text labels (or {text, code} objects).
  function badges(items) {
    return items.map(function (it) {
      var code = typeof it === 'object';
      return '<span class="badge' + (code ? ' code' : '') + '">' + esc(code ? it.text : it) + '</span>';
    }).join('');
  }

  // Replays the fade-in on an element (skipped by CSS when reduced motion is on).
  function reveal(el) {
    el.classList.remove('reveal');
    void el.offsetWidth;
    el.classList.add('reveal');
  }

  function setStatus(state, pill, html, stats) {
    statusEl.setAttribute('data-state', state);
    statusEl.innerHTML = '<span class="pill">' + pill + '</span><span class="msg">' + html + '</span>' +
      (stats && stats.length ? '<span class="badges">' + badges(stats) + '</span>' : '');
  }

  function showEmpty(kind, title, text) {
    lastOutput = '';
    outCode.textContent = '';
    output.hidden = true;
    outEmpty.hidden = false;
    outEmpty.setAttribute('data-kind', kind);
    outEmptyTitle.textContent = title;
    outEmptyText.textContent = text;
    outMeta.innerHTML = '';
    btnCopy.disabled = true;
    btnUse.disabled = true;
  }

  function update() {
    var text = input.value;
    var bytes = byteLen(text);
    inMeta.innerHTML = text.length ? badges([fmtBytes(bytes), plural(text.split('\n').length, 'line', 'lines')]) : '';
    outTitle.textContent = mode === 'minify' ? 'Minified' : 'Formatted';
    var view;

    if (!text.trim()) {
      view = 'empty';
      setStatus('empty', 'Ready', 'Paste or type JSON to begin.');
      showEmpty('empty', 'Nothing to format yet', 'Paste JSON into the input, open a file, or load the sample.');
    } else {
      var value, err = null;
      try {
        value = JSON.parse(text);
      } catch (e) {
        err = describeError(e, text);
      }

      if (err) {
        view = 'invalid';
        setStatus('invalid', 'Invalid', esc(err.message) + '.',
          err.line ? [{ text: 'Line ' + err.line + ', col ' + err.col, code: true }] : null);
        if (err.pos !== null) {
          var b = document.createElement('button');
          b.type = 'button'; b.textContent = 'Go to error';
          b.addEventListener('click', function () { jumpTo(err); });
          statusEl.appendChild(b);
        }
        showEmpty('error', 'No result yet', 'Fix the error in the input and the result appears here.');
      } else {
        view = 'valid-' + mode;
        if (sortBox.checked) value = sortKeys(value);
        var indent = indentSel.value === 'tab' ? '\t' : +indentSel.value;
        var result = mode === 'minify' ? JSON.stringify(value) : JSON.stringify(value, null, indent);
        lastOutput = result;

        outEmpty.hidden = true;
        output.hidden = false;
        if (result.length > HIGHLIGHT_LIMIT) outCode.textContent = result;
        else outCode.innerHTML = highlight(result);

        var stats = measure(value);
        var outBytes = byteLen(result);
        var meta = [fmtBytes(outBytes)];
        if (mode === 'minify' && bytes > 0) {
          var saved = Math.round((1 - outBytes / bytes) * 100);
          meta = [fmtBytes(bytes) + ' → ' + fmtBytes(outBytes)];
          if (saved > 0) meta.push('−' + saved + '%');
        }
        outMeta.innerHTML = badges(meta);
        btnCopy.disabled = false;
        btnUse.disabled = false;

        setStatus('valid', 'Valid', 'Valid JSON', [
          kindOf(value),
          plural(stats.keys, 'key', 'keys') + ' in total',
          'depth ' + stats.depth
        ]);
      }
    }

    // Fade in only when what is shown changes, not on every keystroke.
    if (view !== lastView) {
      reveal(statusEl);
      reveal(output.hidden ? outEmpty : output);
      lastView = view;
    }
  }

  function jumpTo(err) {
    input.focus();
    var end = Math.min(err.pos + 1, input.value.length);
    try { input.setSelectionRange(Math.min(err.pos, input.value.length), end); } catch (e) {}
    var lineH = parseFloat(getComputedStyle(input).lineHeight) || 24;
    input.scrollTop = Math.max(0, (err.line - 4) * lineH);
  }

  function setMode(m) {
    mode = m;
    btnFormat.classList.toggle('active', m === 'format');
    btnMinify.classList.toggle('active', m === 'minify');
    btnFormat.setAttribute('aria-pressed', String(m === 'format'));
    btnMinify.setAttribute('aria-pressed', String(m === 'minify'));
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

  var copyTimer = null;
  function flashCopy(text, ms) {
    copyLabel.textContent = text;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(function () { copyLabel.textContent = 'Copy'; }, ms);
  }
  btnCopy.addEventListener('click', function () {
    if (!lastOutput) return;
    var fallback = function () {
      var r = document.createRange();
      r.selectNodeContents(outCode);
      var sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(r);
      flashCopy('Press Ctrl/Cmd + C', 2500);
    };
    try {
      navigator.clipboard.writeText(lastOutput).then(function () { flashCopy('Copied', 1500); }, fallback);
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
  // this keeps the button label, color-scheme meta and saved choice in sync.
  // The sun/moon icons are swapped by CSS from data-theme.
  var THEME_KEY = 'json-formatter-theme';
  var root = document.documentElement;
  var themeBtn = $('themeToggle');
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
