/*
 * Compare mode: two inputs (Original and Changed), the differences between their data,
 * a list of changes and a side-by-side view with the changed lines lined up.
 * The diff itself is in json-tools.js (runDiff); big inputs are compared in the worker
 * that app.js runs. Uses window.JsonPrettify from app.js for the worker, copying and sharing.
 */
(function () {
  'use strict';

  var T = window.JsonTools, CV = window.CodeView, App = window.JsonPrettify;
  var $ = function (id) { return document.getElementById(id); };
  var SIZES = App.sizes, LIST_MAX = 2000, CONTEXT = 3, PROGRESS_DELAY = 300;

  // ---- Options (remembered) ----
  var OPTS_KEY = 'json-formatter-compare';
  var opts = { arrays: 'smart', key: 'id', ignoreOrder: false, numbersEqual: true, onlyChanges: false };
  try {
    var saved = JSON.parse(localStorage.getItem(OPTS_KEY) || 'null');
    if (saved && typeof saved === 'object') readSettings(saved);
  } catch (e) {}
  function readSettings(s) {
    if (s.arrays === 'position' || s.arrays === 'smart' || s.arrays === 'key') opts.arrays = s.arrays;
    if (typeof s.key === 'string' && s.key.length <= 200) opts.key = s.key;
    if (typeof s.ignoreOrder === 'boolean') opts.ignoreOrder = s.ignoreOrder;
    if (typeof s.numbersEqual === 'boolean') opts.numbersEqual = s.numbersEqual;
    if (typeof s.onlyChanges === 'boolean') opts.onlyChanges = s.onlyChanges;
  }
  function saveOptions() { try { localStorage.setItem(OPTS_KEY, JSON.stringify(opts)); } catch (e) {} }

  var arraysSel = $('cmpArrays'), keyField = $('cmpKeyField'), keyInput = $('cmpKey'), orderBox = $('cmpOrder');
  var numbersBox = $('cmpNumbers'), onlyBox = $('cmpOnlyChanges'), pathSel = $('cmpPathFormat');
  function syncControls() {
    arraysSel.value = opts.arrays;
    keyField.hidden = opts.arrays !== 'key';
    keyInput.value = opts.key;
    orderBox.checked = opts.ignoreOrder;
    orderBox.disabled = opts.arrays === 'position';
    orderBox.closest('label').classList.toggle('is-disabled', opts.arrays === 'position');
    numbersBox.checked = opts.numbersEqual;
    onlyBox.checked = opts.onlyChanges;
  }
  syncControls();

  function badges(items) {
    return items.map(function (t) { return '<span class="badge">' + T.esc(t) + '</span>'; }).join('');
  }
  function plural(n, one, many) { return T.groupDigits(n) + ' ' + (n === 1 ? one : many); }

  var progressHooks = { show: function (l, f, c) { showProgress(l, f, c); }, hide: function () { hideProgress(); } };
  var A = window.DocInput.create('cmp', 'A', 'Original', { progress: progressHooks });
  var B = window.DocInput.create('cmp', 'B', 'Changed', { progress: progressHooks });

  // ---- Progress (reading files, big comparisons), with Cancel ----
  var progress = $('cmpProgress'), progressText = $('cmpProgressText'), progressTime = $('cmpProgressTime'), bar = $('cmpBar');
  var btnCancel = $('btnCmpCancel'), onCancel = null, progressTimer = null, tickTimer = null;
  function showProgress(label, fraction, cancel, time) {
    if (progressText.textContent !== label) progressText.textContent = label;
    progressTime.textContent = time || '';
    if (fraction === null || fraction === undefined) bar.removeAttribute('value'); else bar.value = fraction;
    onCancel = cancel || null;
    btnCancel.hidden = !cancel;
    progress.hidden = false;
  }
  function hideProgress() {
    clearTimeout(progressTimer);
    clearTimeout(tickTimer);
    var hadFocus = progress.contains(document.activeElement);
    progress.hidden = true;
    onCancel = null;
    diffBody.removeAttribute('aria-busy');
    if (hadFocus) btnSwap.focus();
  }
  btnCancel.addEventListener('click', function () { if (onCancel) onCancel(); });

  // ---- Running the comparison ----
  var statusEl = $('cmpStatus'), diffBody = $('diffBody'), diffMeta = $('diffMeta'), listEl = $('diffList'), listNote = $('diffListNote');
  var emptyEl = $('diffEmpty'), emptyTitle = $('diffEmptyTitle'), emptyText = $('diffEmptyText'), sides = $('diffSides'), listWrap = $('diffListWrap');
  var btnPrev = $('btnDiffPrev'), btnNext = $('btnDiffNext'), btnPatch = $('btnCopyPatch'), btnText = $('btnCopyDiffText'), btnShare = $('btnCmpShare');
  var btnSwap = $('btnCmpSwap');
  var seq = 0, timer = null, running = null, result = null, viewData = null, current = -1, started = false, workerHas = { a: null, b: null };
  var shownVersions = null;

  function diffOptions() {
    return { arrays: opts.arrays, key: opts.key, ignoreOrder: opts.ignoreOrder && opts.arrays !== 'position', numbersEqual: opts.numbersEqual,
      indent: 2, context: opts.onlyChanges ? CONTEXT : null };
  }
  function schedule(delay) {
    clearTimeout(timer);
    timer = setTimeout(run, delay === undefined ? 200 : delay);
  }

  function setStatus(state, pill, msg) {
    statusEl.setAttribute('data-state', state);
    statusEl.innerHTML = '<span class="pill">' + pill + '</span><span class="msg">' + msg + '</span>';
  }

  function cancelRunning(silent) {
    if (!running) return;
    running = null;
    App.stopWorker();
    workerHas = { a: null, b: null };
    hideProgress();
    if (!silent) {
      seq++;
      setStatus('empty', 'Stopped', 'The comparison was stopped. Change an input or an option to compare again.');
      showEmptyState('stopped', 'Stopped', 'The comparison was stopped before it finished.');
    }
  }

  function run() {
    clearTimeout(timer);
    var ta = A.text(), tb = B.text(), my = ++seq, o = diffOptions();
    var versions = A.version + '|' + B.version;
    if (ta.length + tb.length <= SIZES.SYNC_CHARS) {
      cancelRunning(true);
      var r = T.runDiff(ta, tb, o);
      r.local = true;
      show(r, versions);
      return;
    }
    // Big inputs: in the worker. A newer run makes the reply of an older one stale.
    cancelRunning(true);
    running = { id: my };
    diffBody.setAttribute('aria-busy', 'true');
    var t0 = Date.now(), phase = 'Comparing';
    var size = T.fmtBytes((A.big !== null ? A.bytes : ta.length) + (B.big !== null ? B.bytes : tb.length));
    var tick = function () {
      if (!running || running.id !== my) return;
      var secs = Math.floor((Date.now() - t0) / 1000);
      showProgress(phase + ' ' + size + '\u2026', null, function () { cancelRunning(false); }, secs ? secs + ' s' : '');
      tickTimer = setTimeout(tick, 500);
    };
    progressTimer = setTimeout(function () {
      setStatus('empty', 'Working', 'Comparing the two documents\u2026');
      tick();
    }, PROGRESS_DELAY);
    var send = function (withTexts) {
      var msg = { type: 'diff', va: A.version, vb: B.version, opts: o };
      if (withTexts || workerHas.a !== A.version) msg.a = ta;
      if (withTexts || workerHas.b !== B.version) msg.b = tb;
      App.request(msg, function (m) {
        if (!running || running.id !== my || my !== seq) return;   // stale or stopped
        if (m.type === 'need-text') { send(true); return; }
        running = null;
        hideProgress();
        if (m.type !== 'diff') {
          if (m.cancelled) return;
          show({ status: 'failed', message: m.message, tooBig: m.tooBig, deep: m.deep }, versions);
          return;
        }
        workerHas = { a: A.version, b: B.version };
        show(m, versions);
      });
    };
    send(false);
  }

  function showEmptyState(kind, title, text) {
    emptyEl.hidden = false;
    emptyEl.setAttribute('data-kind', kind);
    emptyTitle.textContent = title;
    emptyText.textContent = text;
    sides.hidden = true;
    listWrap.hidden = true;
    diffMeta.innerHTML = '';
    result = null;
    current = -1;
    left.clear();
    right.clear();
    btnPrev.disabled = btnNext.disabled = btnPatch.disabled = btnText.disabled = true;
  }

  function show(r, versions) {
    A.showError(r.errors ? r.errors.a : null);
    B.showError(r.errors ? r.errors.b : null);
    if (r.status === 'empty') {
      var which = r.empty.a && r.empty.b ? 'two JSON documents' : r.empty.a ? 'the original JSON' : 'the changed JSON';
      setStatus('empty', 'Ready', 'Paste or open ' + which + ' to compare.');
      showEmptyState('empty', 'Nothing to compare yet', 'Paste JSON into Original and Changed, open files, or drop them on the inputs.');
      return;
    }
    if (r.status === 'invalid') {
      var bad = r.errors.a && r.errors.b ? 'Original and Changed' : r.errors.a ? 'Original' : 'Changed';
      setStatus('invalid', 'Invalid', 'Fix the JSON in ' + bad + ' to compare.');
      showEmptyState('error', 'No comparison yet', 'Fix the error' + (r.errors.a && r.errors.b ? 's' : '') + ' in ' + bad + ' and the differences appear here.');
      return;
    }
    if (r.status === 'failed') {
      setStatus('invalid', 'Error', r.tooBig ? 'These documents are too big for the browser to compare.' :
        r.deep ? 'These documents are nested too deeply to compare.' : 'Something went wrong while comparing: ' + T.esc(r.message || 'unknown error') + '.');
      showEmptyState('error', 'Can\u2019t compare these', r.tooBig ? 'Try smaller files.' : 'Try comparing smaller parts.');
      return;
    }
    var keepScroll = shownVersions === versions;
    shownVersions = versions;
    result = r;
    var notes = r.notes && r.notes.length ? ' <span class="fix-note">' + r.notes.map(T.esc).join(' ') + '</span>' : '';
    if (r.equal) {
      setStatus('valid', 'Same', 'No differences: both documents have the same data.' + notes);
      showEmptyState('same', 'No differences', 'Both documents have the same data. Whitespace and the order of keys are not compared.');
      result = r;
      btnPatch.disabled = btnText.disabled = false;
      return;
    }
    setStatus('changed', 'Different', T.esc(T.diffSummary(r.counts)) + notes);
    emptyEl.hidden = true;
    sides.hidden = false;
    listWrap.hidden = false;
    btnPrev.disabled = btnNext.disabled = btnPatch.disabled = btnText.disabled = false;
    if (!keepScroll) current = -1;
    renderList();
    renderView(r.view, keepScroll);
    updateMeta();
  }

  function updateMeta() {
    if (!result || result.equal) { diffMeta.innerHTML = ''; return; }
    var n = result.list.length;
    diffMeta.innerHTML = badges([plural(n, 'change', 'changes')].concat(current >= 0 ? [T.groupDigits(current + 1) + ' of ' + T.groupDigits(n)] : []));
  }

  // ---- The list of changes ----
  var OPS = { add: ['+', 'Added'], remove: ['\u2212', 'Removed'], change: ['~', 'Changed'], type: ['~', 'Type changed'] };
  function pathOf(c) {
    var p = T.formatPath(c.pathB || c.pathA, pathSel.value);
    return p || (pathSel.value === 'jq' ? '.' : pathSel.value === 'jsonpath' ? '$' : '(root)');
  }
  function valuesOf(c) {
    if (c.op === 'add') return c.after;
    if (c.op === 'remove') return c.before;
    return c.before + ' \u2192 ' + c.after + (c.op === 'type' ? ' (' + c.typeA + ' \u2192 ' + c.typeB + ')' : '');
  }
  function renderList() {
    var list = result.list, frag = document.createDocumentFragment(), max = Math.min(list.length, LIST_MAX);
    for (var i = 0; i < max; i++) {
      var c = list[i], li = document.createElement('li'), b = document.createElement('button');
      b.type = 'button';
      b.className = 'diff-item diff-' + c.op;
      b.setAttribute('data-ci', i);
      if (i === current) b.setAttribute('aria-current', 'true');
      b.innerHTML = '<span class="diff-sign" aria-hidden="true">' + OPS[c.op][0] + '</span><span class="sr-only">' + OPS[c.op][1] + ': </span>' +
        '<span class="diff-path">' + T.esc(pathOf(c)) + '</span><span class="diff-vals">' + T.esc(valuesOf(c)) + '</span>';
      li.appendChild(b);
      frag.appendChild(li);
    }
    listEl.textContent = '';
    listEl.appendChild(frag);
    listNote.hidden = list.length <= LIST_MAX;
    listNote.textContent = list.length > LIST_MAX ? 'Showing the first ' + T.groupDigits(LIST_MAX) + ' of ' + T.groupDigits(list.length) +
      ' changes. Next and Previous go through all of them.' : '';
  }
  listEl.addEventListener('click', function (e) {
    var b = e.target.closest('.diff-item');
    if (b) goTo(+b.getAttribute('data-ci'), false);
  });

  // ---- The side-by-side view ----
  function sideView(name) {
    var scroller = $('diff' + name);
    return CV.create({ scroller: scroller, rows: scroller.querySelector('.code-rows'), pre: scroller.querySelector('pre'), code: $('diff' + name + 'Code'),
      gutter: $('diff' + name + 'Gutter'), track: $('diff' + name + 'Track'), onScroll: function () { syncScroll(name); } });
  }
  var left = sideView('Left'), right = sideView('Right');
  var leftEl = $('diffLeft'), rightEl = $('diffRight');
  // Both panes have the same rows, so they scroll together.
  function syncScroll(from) {
    var a = from === 'Left' ? leftEl : rightEl, b = from === 'Left' ? rightEl : leftEl;
    if (Math.abs(b.scrollTop - a.scrollTop) > 0.5) b.scrollTop = a.scrollTop;
  }
  var CLS = ['', 'dx-add', 'dx-del', 'dx-mod', 'dx-gap'];
  function rowClass(side) {
    return function (r) {
      var k = viewData.kind[r], c = CLS[k];
      if (k === 1 && side === 'left') c = 'dx-fill';
      if (k === 2 && side === 'right') c = 'dx-fill';
      if (current >= 0 && viewData.ci[r] === current) c += ' dx-current';
      return c;
    };
  }
  function renderView(v, keepScroll) {
    viewData = v;
    var scan = T.scannerFor('json');
    var li = T.rowIndex(v.left, 1e9), ri = T.rowIndex(v.right, 1e9);
    left.setText(v.left, li, T.rowRestarts(scan, v.left, li), scan, keepScroll, {
      label: function (r) { return v.ln[r] ? String(v.ln[r]) : ''; }, rowClass: rowClass('left'), marks: v.marks.left });
    right.setText(v.right, ri, T.rowRestarts(scan, v.right, ri), scan, keepScroll, {
      label: function (r) { return v.rn[r] ? String(v.rn[r]) : ''; }, rowClass: rowClass('right'), marks: v.marks.right });
    if (keepScroll) syncScroll('Left');
  }

  // A different view of the same comparison (only changes, or everything).
  function reView() {
    if (!result || result.equal) return;
    var o = diffOptions();
    if (result.local) {
      result.view = T.diffViewText(result.diff.view, o.context, result.list.length);
      renderView(result.view, false);
      if (current >= 0) goTo(current, false);
      return;
    }
    App.request({ type: 'diffView', context: o.context }, function (m) {
      if (m.type !== 'diffView' || !result) { if (m.type === 'error' && !m.cancelled) run(); return; }
      result.view = m.view;
      renderView(m.view, false);
      if (current >= 0) goTo(current, false);
    });
  }

  // ---- Going through the changes ----
  function goTo(i, fromKeys) {
    if (!result || result.equal || !result.list.length) return;
    current = i;
    var r = viewData.changeRow[i];
    if (r >= 0) {
      left.revealRow(r, false);
      syncScroll('Left');
    }
    left.refresh();
    right.refresh();
    var items = listEl.querySelectorAll('[aria-current]');
    for (var k = 0; k < items.length; k++) items[k].removeAttribute('aria-current');
    var item = listEl.querySelector('[data-ci="' + i + '"]');
    if (item) {
      item.setAttribute('aria-current', 'true');
      var box = listWrap.getBoundingClientRect(), ib = item.getBoundingClientRect();
      if (ib.top < box.top || ib.bottom > box.bottom) listWrap.scrollTop += ib.top - box.top - box.height / 3;
    }
    updateMeta();
    var c = result.list[i];
    if (fromKeys) App.announce('Change ' + (i + 1) + ' of ' + result.list.length + ': ' + OPS[c.op][1] + ' ' + pathOf(c));
  }
  function step(delta) {
    if (!result || result.equal || !result.list.length) return;
    var n = result.list.length;
    goTo(current < 0 ? (delta > 0 ? 0 : n - 1) : (current + delta + n) % n, true);
  }
  btnNext.addEventListener('click', function () { step(1); });
  btnPrev.addEventListener('click', function () { step(-1); });
  // Clicking a changed line makes it the current change.
  [leftEl, rightEl].forEach(function (el) {
    el.addEventListener('click', function (e) {
      var row = e.target.closest && e.target.closest('.code-row');
      if (!row || !viewData) return;
      var ci = viewData.ci[+row.getAttribute('data-r')];
      if (ci >= 0 && window.getSelection().isCollapsed) goTo(ci, false);
    });
  });
  // Alt + Down / Alt + Up: next and previous change (not inside text fields, where Alt +
  // arrows move the cursor on some systems).
  document.addEventListener('keydown', function (e) {
    if (App.mode() !== 'compare' || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    var a = document.activeElement, tag = a && a.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
    e.preventDefault();
    step(e.key === 'ArrowDown' ? 1 : -1);
  });

  // ---- Exports ----
  function exportText(kind, done) {
    if (!result) return;
    if (result.local) {
      done(kind === 'patch' ? JSON.stringify(result.diff.patch, null, 2) + '\n' : T.diffAsText(result.diff, pathSel.value));
      return;
    }
    App.request({ type: 'diffExport', kind: kind, pathFormat: pathSel.value }, function (m) {
      if (m.type === 'diffExport') done(m.text);
      else if (!m.cancelled) App.showToast('Couldn\u2019t copy the changes');
    });
  }
  btnPatch.addEventListener('click', function () {
    exportText('patch', function (t) {
      var ops = (t.match(/"op":/g) || []).length;
      App.copyText(t, 'Copied JSON Patch (' + plural(ops, 'operation', 'operations') + ')');
    });
  });
  btnText.addEventListener('click', function () {
    exportText('text', function (t) { App.copyText(t, 'Copied the changes as text'); });
  });
  btnShare.addEventListener('click', function () { App.share(); });

  // ---- Options and buttons ----
  arraysSel.addEventListener('change', function () { opts.arrays = arraysSel.value; syncControls(); saveOptions(); run(); if (opts.arrays === 'key') keyInput.focus(); });
  keyInput.addEventListener('input', function () { opts.key = keyInput.value; saveOptions(); schedule(300); });
  orderBox.addEventListener('change', function () { opts.ignoreOrder = orderBox.checked; saveOptions(); run(); });
  numbersBox.addEventListener('change', function () { opts.numbersEqual = numbersBox.checked; saveOptions(); run(); });
  onlyBox.addEventListener('change', function () { opts.onlyChanges = onlyBox.checked; saveOptions(); reView(); });
  // The path format is the same setting as Format mode's path bar.
  pathSel.value = App.pathFormat();
  pathSel.addEventListener('change', function () { App.setPathFormat(pathSel.value); if (result && !result.equal) renderList(); });

  btnSwap.addEventListener('click', function () {
    var ta = A.text(), tb = B.text(), ba = A.big !== null ? A.bytes : undefined, bb = B.big !== null ? B.bytes : undefined;
    A.setText(tb, bb === undefined ? undefined : { bytes: bb });
    B.setText(ta, ba === undefined ? undefined : { bytes: ba });
    A.dirty = B.dirty = true;
    workerHas = { a: null, b: null };
    App.showToast('Swapped Original and Changed');
    run();
  });
  $('btnCmpUseFormat').addEventListener('click', function () {
    A.setText(App.formatInput());
    A.dirty = true;
    App.showToast('Original is now the Format input');
    run();
  });

  var sharedPair = null;
  A.onChange = B.onChange = function () {
    if (sharedPair && (A.text() !== sharedPair[0] || B.text() !== sharedPair[1])) { sharedPair = null; App.clearShareHash(); }
    schedule(A.text().length + B.text().length > SIZES.SYNC_CHARS ? 600 : 200);
  };

  // ---- Hooks for app.js ----
  App.registerCompare({
    shown: function () {
      pathSel.value = App.pathFormat();
      if (!started) { started = true; run(); }
      else if (!result && !running) run();
      else { left.render(false); right.render(false); }
    },
    texts: function () { return { original: A.text(), changed: B.text() }; },
    settings: function () { return { arrays: opts.arrays, key: opts.key, ignoreOrder: opts.ignoreOrder, numbersEqual: opts.numbersEqual, onlyChanges: opts.onlyChanges }; },
    // A shared comparison: both texts (untrusted, only ever used as text) and the settings.
    apply: function (link) {
      readSettings(link.settings || {});
      syncControls();
      saveOptions();
      A.setText(link.original);
      B.setText(link.changed);
      A.dirty = B.dirty = false;
      sharedPair = [link.original, link.changed];
      started = true;
      run();
    },
    dirty: function (link) { return (A.dirty || B.dirty) && (A.text() !== link.original || B.text() !== link.changed); }
  });
})();
