/*
 * UI wiring for JSON Prettify: reads the input, renders the result and
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
  var inGutter = $('inGutter'), inTrack = $('inGutterTrack'), inMark = $('inGutterMark');
  var outGutter = $('outGutter'), outTrack = $('outGutterTrack');

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
    treeView.hidden = true;
    pathBar.hidden = true;
    outEmpty.hidden = false;
    outEmpty.setAttribute('data-kind', kind);
    outEmptyTitle.textContent = title;
    outEmptyText.textContent = text;
    outMeta.innerHTML = '';
    btnCopy.disabled = true;
    btnUse.disabled = true;
  }

  // Does all the formatting work before anything is drawn, so a failure (for example
  // JSON.stringify running out of stack on very deep input) leaves nothing half-rendered.
  function formatValue(value, inBytes) {
    if (sortBox.checked) value = sortKeys(value);
    var indent = indentSel.value === 'tab' ? '\t' : +indentSel.value;
    var result = mode === 'minify' ? JSON.stringify(value) : JSON.stringify(value, null, indent);
    var html = result.length <= HIGHLIGHT_LIMIT ? highlight(result) : null;
    var outBytes = byteLen(result);
    var meta = [fmtBytes(outBytes)];
    if (mode === 'minify' && inBytes > 0) {
      var saved = Math.round((1 - outBytes / inBytes) * 100);
      meta = [fmtBytes(inBytes) + ' \u2192 ' + fmtBytes(outBytes)];
      if (saved > 0) meta.push('\u2212' + saved + '%');
    }
    return { value: value, result: result, html: html, meta: meta, stats: measure(value) };
  }

  function isTooDeep(e) {
    return (e && e.name === 'RangeError') || /recursion|call stack|nest/i.test(String(e && e.message));
  }

  function showFailure(e, value) {
    var deep = isTooDeep(e);
    var depth = null;
    if (value !== undefined) {
      try { depth = measure(value).depth; } catch (e2) {}
    }
    setStatus('invalid', 'Error',
      deep ? 'This JSON is nested too deeply to format.' : 'Something went wrong while formatting this JSON.',
      depth !== null ? ['depth ' + depth.toLocaleString('en-US')] : null);
    showEmpty('error', 'Can\u2019t show a result', deep
      ? 'The browser can\u2019t format JSON nested this deeply. Try formatting a smaller part of it.'
      : (e && e.message ? e.message : 'Unknown error') + '.');
  }

  // ---- Line-number gutters ----
  // The numbers are one string in a data attribute, shown with CSS generated content.
  // It is rebuilt only when the line count changes, never on every keystroke.
  var gutterCount = { input: 0, output: 0 };

  function setGutterLines(which, gutter, track, count) {
    if (gutterCount[which] === count) return;
    gutterCount[which] = count;
    track.setAttribute('data-lines', T.lineNumbers(count));
    gutter.style.setProperty('--digits', T.gutterDigits(count));
  }

  // The textarea scrolls by itself (wheel, keys, touch, paste, caret moves); the gutter
  // track follows its scrollTop.
  function syncInputGutter() {
    inTrack.style.transform = 'translateY(' + (-input.scrollTop) + 'px)';
  }

  function refreshInputGutter() {
    setGutterLines('input', inGutter, inTrack, T.countLines(input.value));
    syncInputGutter();
  }

  // Highlights the number of the line with a syntax error (null clears it).
  function markErrorLine(line) {
    if (line) {
      inMark.textContent = line;
      inMark.style.setProperty('--mark-line', line);
      inMark.hidden = false;
    } else {
      inMark.hidden = true;
    }
  }

  function update() {
    var text = input.value;
    var bytes = byteLen(text);
    refreshInputGutter();
    markErrorLine(null);
    inMeta.innerHTML = text.length ? badges([fmtBytes(bytes), plural(T.countLines(text), 'line', 'lines')]) : '';
    outTitle.textContent = mode === 'minify' ? 'Minified' : 'Formatted';
    var view;

    if (!text.trim()) {
      view = 'empty';
      setStatus('empty', 'Ready', 'Paste or type JSON to begin.');
      showEmpty('empty', 'Nothing to format yet', 'Paste JSON into the input, open a file, or load the sample.');
    } else {
      var value, err = null, failure = null;
      try {
        value = JSON.parse(text);
      } catch (e) {
        // Syntax errors get a location; anything else (such as Firefox's "too much
        // recursion" on very deep input) is a failure to process valid-looking JSON.
        if (e instanceof SyntaxError) err = describeError(e, text);
        else failure = e;
      }

      var formatted = null;
      if (!err && !failure) {
        try {
          formatted = formatValue(value, bytes);
        } catch (e) {
          failure = e;
        }
      }

      if (failure) {
        view = 'failed';
        showFailure(failure, value);
      } else if (err) {
        view = 'invalid';
        markErrorLine(err.line);
        setStatus('invalid', 'Invalid', esc(err.message) + '.' +
          (fixFailure ? ' <span class="fix-note">Couldn\u2019t fix this automatically: ' + esc(fixFailure) + '.</span>' : ''),
          err.line ? [{ text: 'Line ' + err.line + ', col ' + err.col, code: true }] : null);
        var actions = document.createElement('span');
        actions.className = 'status-actions';
        if (!fixFailure) actions.appendChild(statusButton('btnFix', 'Fix JSON', applyFix, true));
        if (err.pos !== null) actions.appendChild(statusButton('btnGoError', 'Go to error', function () { jumpTo(err); }));
        statusEl.appendChild(actions);
        showEmpty('error', 'No result yet', 'Fix the error in the input and the result appears here.');
      } else {
        view = 'valid-' + mode;
        lastOutput = formatted.result;
        // The tree is rebuilt only when the data could have changed (input text or Sort keys).
        var source = text + '|' + sortBox.checked;
        if (source !== treeSource) { treeSource = source; treeValue = formatted.value; treeDirty = true; }
        if (formatted.html !== null) outCode.innerHTML = formatted.html;
        else outCode.textContent = formatted.result;
        outCode.classList.toggle('hl', formatted.html !== null);
        setGutterLines('output', outGutter, outTrack, T.countLines(formatted.result));
        showResult();
        outMeta.innerHTML = badges(formatted.meta);
        btnCopy.disabled = false;
        btnUse.disabled = false;

        setStatus('valid', 'Valid', fixNotice ? esc(fixNotice) : 'Valid JSON', [
          kindOf(formatted.value),
          plural(formatted.stats.keys, 'key', 'keys') + ' in total',
          'depth ' + formatted.stats.depth
        ]);
        if (fixNotice && fixUndo !== null) {
          var undoWrap = document.createElement('span');
          undoWrap.className = 'status-actions';
          undoWrap.appendChild(statusButton('btnUndoFix', 'Undo fix', undoFix));
          statusEl.appendChild(undoWrap);
        }
      }
    }

    // Fade in only when what is shown changes, not on every keystroke.
    if (view !== lastView) {
      reveal(statusEl);
      reveal(!outEmpty.hidden ? outEmpty : outView === 'tree' ? treeView : output);
      lastView = view;
    }
  }

  function statusButton(id, label, onClick, primary) {
    var b = document.createElement('button');
    b.type = 'button';
    b.id = id;
    b.textContent = label;
    if (primary) b.className = 'primary';
    b.addEventListener('click', onClick);
    return b;
  }

  // ---- Fix JSON ----
  // The fix only ever runs when the user asks for it (button or shortcut).
  var fixNotice = null;   // summary shown after a successful fix, until the next edit
  var fixFailure = null;  // why the last fix attempt failed, until the next edit
  var fixUndo = null;     // previous text, only when the browser's own undo could not be kept
  var applyingFix = false;

  function applyFix() {
    var before = input.value;
    var r = T.repairJson(before);
    if (!r.ok || !r.changed) {
      fixFailure = r.ok ? 'it is already valid' : r.error;
      update();
      var go = $('btnGoError');
      if (go) go.focus();
      return;
    }
    // Replace the text through the editing pipeline so Ctrl+Z / Cmd+Z can undo the fix.
    applyingFix = true;
    input.focus();
    input.setSelectionRange(0, before.length);
    var kept = false;
    try { kept = document.execCommand('insertText', false, r.text); } catch (e) {}
    if (!kept || input.value !== r.text) {
      input.value = r.text;   // fallback: no browser undo, so offer an "Undo fix" button
      fixUndo = before;
    } else {
      fixUndo = null;
    }
    applyingFix = false;
    fixNotice = r.summary;
    treeResetNext = true;
    fixFailure = null;
    clearTimeout(timer);
    update();
    input.setSelectionRange(0, 0);
    input.scrollTop = 0;
  }

  function undoFix() {
    if (fixUndo === null) return;
    input.value = fixUndo;
    fixUndo = null;
    fixNotice = null;
    update();
    input.focus();
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
    var b = $('btnGoError') || $('btnFix');
    if (b) b.focus();
  });
  // Indent choice is remembered like the theme (wrapped in try/catch for private modes).
  var INDENT_KEY = 'json-formatter-indent';
  try {
    var savedIndent = localStorage.getItem(INDENT_KEY);
    if (savedIndent === '2' || savedIndent === '4' || savedIndent === 'tab') indentSel.value = savedIndent;
  } catch (e) {}
  indentSel.addEventListener('change', function () {
    try { localStorage.setItem(INDENT_KEY, indentSel.value); } catch (e) {}
    setMode('format');
  });
  sortBox.addEventListener('change', function () { update(); });

  var timer = null;
  input.addEventListener('input', function () {
    refreshInputGutter(); // immediately, so numbers keep up with fast typing and pastes
    if (!applyingFix) {
      // Any edit (including Ctrl+Z undoing a fix) clears the fix summary and failure note.
      fixNotice = null;
      fixFailure = null;
      fixUndo = null;
    }
    clearTimeout(timer);
    timer = setTimeout(update, 160);
  });
  input.addEventListener('scroll', syncInputGutter, { passive: true });
  input.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'Enter') { e.preventDefault(); setMode('format'); }
  });
  // Ctrl/Cmd + Shift + Enter: Fix JSON (only when the input is invalid).
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(timer);
      update();
      if (statusEl.getAttribute('data-state') === 'invalid' && $('btnFix')) applyFix();
    }
  });

  $('btnSample').addEventListener('click', function () { treeResetNext = true; input.value = SAMPLE; setMode('format'); });
  $('btnClear').addEventListener('click', function () { treeResetNext = true; input.value = ''; update(); input.focus(); });

  btnUse.addEventListener('click', function () {
    if (!lastOutput) return;
    treeResetNext = true;
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
    reader.onload = function () { treeResetNext = true; input.value = String(reader.result || ''); setMode('format'); };
    reader.readAsText(f);
    e.target.value = '';
  });

  // ---- Output view: Code or Tree ----
  var VIEW_KEY = 'json-formatter-view';
  var treeView = $('outTreeView'), treeEl = $('outTree'), treeNote = $('treeNote');
  var btnViewCode = $('btnViewCode'), btnViewTree = $('btnViewTree');
  var outView = 'code';
  try {
    var savedView = localStorage.getItem(VIEW_KEY);
    if (savedView === 'code' || savedView === 'tree') outView = savedView;
  } catch (e) {}

  // Shows the current result in the chosen view (only called when there is a result).
  function showResult() {
    outEmpty.hidden = true;
    pathBar.hidden = false;
    // Keep the selected path while it still exists in the (possibly edited) data.
    if (T.valueAtPath(treeValue, selectedParts) === undefined) selectedParts = [];
    renderCrumbs();
    output.hidden = outView !== 'code';
    treeView.hidden = outView !== 'tree';
    if (outView === 'tree' && treeDirty) buildTree();
  }

  function setOutView(view, save) {
    outView = view;
    btnViewCode.classList.toggle('active', view === 'code');
    btnViewTree.classList.toggle('active', view === 'tree');
    btnViewCode.setAttribute('aria-pressed', String(view === 'code'));
    btnViewTree.setAttribute('aria-pressed', String(view === 'tree'));
    if (save) { try { localStorage.setItem(VIEW_KEY, view); } catch (e) {} }
    if (lastOutput) { showResult(); reveal(view === 'tree' ? treeView : output); }
  }
  btnViewCode.addEventListener('click', function () { setOutView('code', true); });
  btnViewTree.addEventListener('click', function () { setOutView('tree', true); });

  // ---- Tree view ----
  // A flat list of role="treeitem" rows with aria-level (grouped in blocks, see below). A node's child rows are built only
  // when it is opened, 100 at a time; bigger jobs run in short slices so the page never
  // freezes. Each row keeps its data in row._d and its path (data.users[2].email) in
  // data-path, ready for copying paths later.
  var TREE_PAGE = 100, TREE_SLICE_MS = 30, STRING_PREVIEW = 80, DEFAULT_TREE_LEVEL = 2, EXPAND_LIMIT = 50000;
  var treeValue, treeSource = null, treeDirty = false, treeResetNext = true;
  var treeGen = 0, activeRow = null, busyJobs = 0;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function setBusy(delta) {
    busyJobs = Math.max(0, busyJobs + delta);
    treeEl.setAttribute('aria-busy', String(busyJobs > 0));
  }

  // Builds one row. entry is { key, isIndex, value } from listChildren, or null for the root.
  // parent is the parent row's data (null for the root).
  function makeRow(entry, level, parent, posinset, setsize) {
    var value = entry ? entry.value : treeValue;
    var info = T.containerInfo(value);
    var path = entry ? T.childPath(parent.path, entry.key, entry.isIndex) : '';
    var parts = entry ? parent.parts.concat(entry.key) : [];
    var row = el('div', 'tree-row');
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', level);
    if (setsize) { row.setAttribute('aria-setsize', setsize); row.setAttribute('aria-posinset', posinset); }
    row.setAttribute('data-path', path);
    row.tabIndex = -1;
    row.style.setProperty('--lvl', level - 1);
    var d = row._d = { level: level, path: path, parts: parts, value: value, info: info, container: !!(info && info.count), expanded: false, shown: 0 };

    // The chevron is the row's ::before and the ": " after a key is generated by CSS,
    // which keeps each row to a few elements.
    if (entry) {
      if (entry.isIndex) row.appendChild(el('span', 'tree-index', String(entry.key)));
      else row.appendChild(el('span', 'tree-key k', T.displayKey(entry.key)));
    }
    if (info) {
      if (d.container) {
        row.setAttribute('aria-expanded', 'false');
        row.appendChild(el('span', 'tree-brief', info.brief));
        row.appendChild(el('span', 'tree-count', info.label));
      } else {
        row.appendChild(el('span', 'tree-brief', info.empty));
      }
    } else {
      var view = T.scalarView(value, STRING_PREVIEW);
      var span = row.appendChild(el('span', 'tree-val ' + view.cls, view.text));
      if (view.truncated) {
        d.short = view.text;
        d.full = view.full;
        d.pinned = false;
        span.title = view.full.length > 10000 ? view.full.slice(0, 10000) + '\u2026' : view.full;
        row.appendChild(el('span', 'tree-str-toggle', 'more'));
      }
    }
    return row;
  }

  function makeMoreRow(parent, kind, label) {
    var row = el('div', 'tree-row tree-more');
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', parent._d.level + 1);
    row.tabIndex = -1;
    row.style.setProperty('--lvl', parent._d.level);
    row.appendChild(el('span', 'tree-more-btn', label));
    row._d = { level: parent._d.level + 1, more: kind, parent: parent };
    return row;
  }

  // Rows for children from..to-1 of parent, in a fragment.
  function childFragment(parent, from, to) {
    var d = parent._d, frag = document.createDocumentFragment(), rows = [];
    var entries = T.listChildren(d.value, from, to, d.info.keys);
    for (var i = 0; i < entries.length; i++) {
      rows.push(frag.appendChild(makeRow(entries[i], d.level + 1, d, from + i + 1, d.info.count)));
    }
    d.shown = from + entries.length;
    return { frag: frag, rows: rows };
  }

  // "Show 100 more" / "Show all" rows for children not built yet.
  function moreFragment(parent) {
    var d = parent._d, left = d.info.count - d.shown, frag = document.createDocumentFragment();
    if (left <= 0) return frag;
    frag.appendChild(makeMoreRow(parent, 'page', 'Show ' + T.groupDigits(Math.min(left, TREE_PAGE)) + ' more'));
    if (left > TREE_PAGE) frag.appendChild(makeMoreRow(parent, 'all', 'Show all (' + T.groupDigits(left) + ' more)'));
    return frag;
  }

  // ---- Rows are kept in blocks of up to BLOCK_MAX ----
  // The rows form one flat list in document order, split across <div role="none"> blocks.
  // Blocks carry content-visibility: auto, so the browser skips whole blocks that are off
  // screen and an insert only dirties one block: the cost of a frame no longer grows with
  // the number of rows. These helpers step through rows across block boundaries.
  var BLOCK_MAX = 256;

  function makeBlock() {
    var b = el('div', 'tree-block');
    b.setAttribute('role', 'none');
    return b;
  }
  function nonEmpty(b, forward) {
    while (b && !b.firstElementChild) b = forward ? b.nextElementSibling : b.previousElementSibling;
    return b;
  }
  function nextRow(row) {
    if (row.nextElementSibling) return row.nextElementSibling;
    var b = nonEmpty(row.parentNode.nextElementSibling, true);
    return b ? b.firstElementChild : null;
  }
  function prevRow(row) {
    if (row.previousElementSibling) return row.previousElementSibling;
    var b = nonEmpty(row.parentNode.previousElementSibling, false);
    return b ? b.lastElementChild : null;
  }
  function firstRow() {
    var b = nonEmpty(treeEl.firstElementChild, true);
    return b ? b.firstElementChild : null;
  }
  function lastRow() {
    var b = nonEmpty(treeEl.lastElementChild, false);
    return b ? b.lastElementChild : null;
  }
  function removeRow(row) {
    var b = row.parentNode;
    row.remove();
    if (!b.firstElementChild) b.remove();
  }

  // Inserts a fragment of rows right after row, keeping blocks small. Big fragments get
  // blocks of their own; small ones go into row's block, which is halved first if full.
  function insertRowsAfter(row, frag) {
    var block = row.parentNode, n = frag.childElementCount;
    if (!n) return;
    var range = document.createRange();
    if (n >= BLOCK_MAX / 4) {
      var place = block;
      if (row.nextElementSibling) {                     // move rows after row to a new block
        var tail = makeBlock();
        range.setStartAfter(row);
        range.setEndAfter(block.lastElementChild);
        tail.appendChild(range.extractContents());
        block.after(tail);
      }
      while (frag.firstElementChild) {
        var nb = makeBlock();
        for (var k = 0; k < BLOCK_MAX && frag.firstElementChild; k++) nb.appendChild(frag.firstElementChild);
        place.after(nb);
        place = nb;
      }
      return;
    }
    if (block.childElementCount + n > BLOCK_MAX) {      // split the full block in half
      var second = makeBlock();
      range.setStartBefore(block.children[block.childElementCount >> 1]);
      range.setEndAfter(block.lastElementChild);
      second.appendChild(range.extractContents());
      block.after(second);
    }
    row.after(frag);
  }

  // The first row after row's descendants (or null at the end).
  function afterDescendants(row) {
    var n = nextRow(row), level = row._d.level;
    while (n && n._d.level > level) n = nextRow(n);
    return n;
  }

  function parentRow(row) {
    var p = prevRow(row), level = row._d.level;
    while (p && p._d.level >= level) p = prevRow(p);
    return p;
  }

  // The direct child rows of an open row that are themselves openable.
  function childContainers(row) {
    var out = [], level = row._d.level, n = nextRow(row);
    for (; n && n._d.level > level; n = nextRow(n)) {
      if (n._d.level === level + 1 && n._d.container) out.push(n);
    }
    return out;
  }

  // Opens a row and builds its first page of children; returns the new child rows.
  function expandRow(row) {
    var d = row._d;
    if (!d.container || d.expanded) return [];
    d.expanded = true;
    row.setAttribute('aria-expanded', 'true');
    var c = childFragment(row, 0, TREE_PAGE);
    c.frag.appendChild(moreFragment(row));
    insertRowsAfter(row, c.frag);
    return c.rows;
  }

  // Closes a row and removes everything inside it, so nothing inside stays open.
  function collapseRow(row) {
    var d = row._d;
    if (!d.expanded) return;
    var hadFocus = treeEl.contains(document.activeElement);
    var end = afterDescendants(row);
    if (row === firstRow() && !end) {
      treeEl.textContent = '';          // closing the root: clear everything in one step
      treeEl.appendChild(makeBlock()).appendChild(row);
    } else if (nextRow(row) && nextRow(row) !== end) {
      // A range from after row to before end removes the rows between, across blocks.
      var range = document.createRange();
      range.setStartAfter(row);
      if (end) range.setEndBefore(end); else range.setEndAfter(treeEl.lastElementChild);
      range.deleteContents();
      var b = row.parentNode.nextElementSibling;       // drop blocks the range emptied
      var stop = end ? end.parentNode : null;
      while (b && b !== stop) { var nb = b.nextElementSibling; if (!b.firstElementChild) b.remove(); b = nb; }
    }
    d.expanded = false;
    d.shown = 0;
    d.token = (d.token || 0) + 1; // stops a "Show all" still running for this row
    row.setAttribute('aria-expanded', 'false');
    if (activeRow && !activeRow.isConnected) setActive(row, hadFocus);
  }

  // Opens rows breadth-first, in slices of a few milliseconds. shouldOpen(d) decides which.
  // Starting another job (or collapsing everything) cancels the previous one.
  // With a limit, it stops after building that many new rows and says so in the tree bar:
  // every row is laid out on each frame, so tens of thousands would make the page sluggish.
  function expandTree(rows, shouldOpen, done, limit) {
    var gen = ++treeGen, queue = rows.slice(), qi = 0, created = 0;
    setTreeNote('');
    setBusy(1);
    (function step() {
      if (gen !== treeGen) { setBusy(-1); return; }
      var t0 = performance.now();
      while (qi < queue.length && performance.now() - t0 < TREE_SLICE_MS) {
        if (limit && created >= limit) {
          qi = queue.length;
          setTreeNote('Stopped after opening ' + T.groupDigits(created) + ' rows to keep the page responsive. Open nodes one at a time to see more.');
          break;
        }
        var row = queue[qi++];
        if (!row.isConnected || !row._d.container || !shouldOpen(row._d)) continue;
        var opening = !row._d.expanded;
        var kids = opening ? expandRow(row) : childContainers(row);
        if (opening) created += row._d.shown;
        for (var k = 0; k < kids.length; k++) if (kids[k]._d.container) queue.push(kids[k]);
      }
      if (qi < queue.length) { setTimeout(step, 0); return; }
      setBusy(-1);
      if (done) done();
    })();
  }

  function setTreeNote(text) {
    treeNote.textContent = text;
    treeNote.hidden = !text;
  }

  // Builds the next page (or all) of a node's children, replacing its "Show more" rows.
  function showMore(moreRow) {
    var parent = moreRow._d.parent, d = parent._d, all = moreRow._d.more === 'all';
    var hadFocus = treeEl.contains(document.activeElement);
    var first = moreRow;
    while (prevRow(first) && prevRow(first)._d.parent === parent) first = prevRow(first);
    var after = prevRow(first);                        // the last row shown for parent
    for (var r = first; r && r._d.parent === parent;) { var following = nextRow(r); removeRow(r); r = following; }
    var target = all ? d.info.count : Math.min(d.info.count, d.shown + TREE_PAGE);
    var token = d.token = (d.token || 0) + 1, firstNew = null;
    setBusy(1);
    (function step() {
      if (d.token !== token || !parent.isConnected) { setBusy(-1); return; }
      if (!after.isConnected) { var end = afterDescendants(parent); after = end ? prevRow(end) : lastRow(); }
      var t0 = performance.now();
      while (d.shown < target && performance.now() - t0 < TREE_SLICE_MS) {
        var c = childFragment(parent, d.shown, Math.min(target, d.shown + 250));
        var last = c.rows[c.rows.length - 1];
        insertRowsAfter(after, c.frag);
        after = last;
        if (!firstNew) {
          firstNew = c.rows[0];
          if (hadFocus || !activeRow || !activeRow.isConnected) setActive(firstNew, hadFocus);
        }
      }
      if (d.shown < target) { setTimeout(step, 0); return; }
      insertRowsAfter(after, moreFragment(parent));
      setBusy(-1);
    })();
  }

  // Shows a long string in full (while focused, or pinned with "more") or cut short.
  function showFullString(row, on) {
    var d = row._d, span = row.querySelector('.tree-val');
    span.textContent = on ? d.full : d.short;
    span.classList.toggle('full', on);
  }
  function pinString(row) {
    var d = row._d;
    d.pinned = !d.pinned;
    row.querySelector('.tree-str-toggle').textContent = d.pinned ? 'less' : 'more';
    showFullString(row, d.pinned || document.activeElement === row);
  }

  // Roving tabindex: only the active row can be reached with Tab.
  function setActive(row, focus) {
    if (activeRow && activeRow !== row && activeRow.isConnected) activeRow.tabIndex = -1;
    activeRow = row;
    row.tabIndex = 0;
    if (focus) row.focus();
  }

  function toggleRow(row, deep) {
    var d = row._d;
    if (!d.container) return;
    if (d.expanded) collapseRow(row);
    else if (deep) expandTree([row], function () { return true; }, null, EXPAND_LIMIT);
    else expandRow(row);
  }

  function activate(row, deep) {
    var d = row._d;
    if (d.more) showMore(row);
    else if (d.full) pinString(row);
    else toggleRow(row, deep);
  }

  function rootRow() { return firstRow(); }

  // Opens containers down to the given aria-level (1 = only the root).
  function openToLevel(level) {
    var root = rootRow();
    if (!root) return;
    treeGen++;
    collapseRow(root);
    expandTree([root], function (d) { return d.level <= level; }, null, EXPAND_LIMIT);
  }

  // Rebuilds the tree for treeValue. While the user is typing, rows that were open stay
  // open; after loading new data, the first two levels open.
  function buildTree() {
    var keep = null, activePath = null;
    if (!treeResetNext && rootRow()) {
      keep = {};
      var open = treeEl.querySelectorAll('[aria-expanded="true"]');
      for (var i = 0; i < open.length; i++) keep[open[i]._d.path] = true;
      if (activeRow && activeRow.isConnected && activeRow._d.path !== undefined) activePath = activeRow._d.path;
    }
    treeResetNext = false;
    treeDirty = false;
    treeGen++;
    treeEl.textContent = '';
    activeRow = null;
    var root = makeRow(null, 1, null);
    treeEl.appendChild(makeBlock()).appendChild(root);
    setActive(root, false);
    if (keep) {
      // If none of the previously open nodes (below the root) exist any more, this is new
      // data rather than an edit, so open the default levels instead.
      var matched = 0;
      expandTree([root], function (d) {
        var hit = keep[d.path] === true;
        if (hit && d.path !== '') matched++;
        return hit;
      }, function () {
        if (!matched) { expandTree([root], function (d) { return d.level <= DEFAULT_TREE_LEVEL; }); return; }
        if (activePath === null) return;
        var match = treeEl.querySelector('[data-path="' + (window.CSS && CSS.escape ? CSS.escape(activePath) : activePath) + '"]');
        if (match) setActive(match, false);
      });
    } else {
      expandTree([root], function (d) { return d.level <= DEFAULT_TREE_LEVEL; });
    }
  }

  treeEl.addEventListener('mousedown', function (e) {
    // Shift or Alt + click opens a whole branch; don't let it select text instead.
    var row = e.target.closest('.tree-row');
    if (row && row._d.container && (e.shiftKey || e.altKey)) e.preventDefault();
    // The copy icon is not a tab stop: keep focus on the row instead of moving it there.
    if (e.target.closest('.tree-copy')) e.preventDefault();
  });

  treeEl.addEventListener('click', function (e) {
    var row = e.target.closest('.tree-row');
    if (!row) return;
    setActive(row, true);
    if (!row._d.more && (e.target.closest('.tree-copy') || e.target.closest('.tree-key, .tree-index'))) {
      copyPath(row._d.parts);   // clicking a key (or the copy icon) copies the path
      return;
    }
    if (row._d.more) showMore(row);
    else if (e.target.closest('.tree-str-toggle')) pinString(row);
    else if (row._d.container) toggleRow(row, e.shiftKey || e.altKey);
  });

  treeEl.addEventListener('focusin', function (e) {
    var row = e.target.closest('.tree-row');
    if (!row) return;
    if (row !== activeRow) setActive(row, false);
    if (row._d.full && !row._d.pinned) showFullString(row, true);
    if (row._d.parts) { selectPath(row._d.parts); placeRowCopy(row); }
  });
  treeEl.addEventListener('focusout', function (e) {
    var row = e.target.closest && e.target.closest('.tree-row');
    if (row && row._d.full && !row._d.pinned && row.isConnected) showFullString(row, false);
  });

  // WAI-ARIA tree keyboard pattern.
  treeEl.addEventListener('keydown', function (e) {
    var row = e.target.closest('.tree-row');
    if (!row || e.ctrlKey || e.metaKey || e.altKey) return;
    var d = row._d, next = null;
    switch (e.key) {
      case 'ArrowDown': next = nextRow(row); break;
      case 'ArrowUp': next = prevRow(row); break;
      case 'Home': next = firstRow(); break;
      case 'End': next = lastRow(); break;
      case 'ArrowRight':
        if (d.container && !d.expanded) expandRow(row);
        else if (d.expanded && nextRow(row) && nextRow(row)._d.level > d.level) next = nextRow(row);
        break;
      case 'ArrowLeft':
        if (d.expanded) collapseRow(row);
        else next = parentRow(row);
        break;
      case 'Enter':
      case ' ':
        activate(row, e.shiftKey);
        break;
      case 'c':
      case 'C':
        if (!d.parts) return;
        if (e.shiftKey) copyValue(d.parts); else copyPath(d.parts);
        break;
      default:
        return;
    }
    e.preventDefault();
    if (next) setActive(next, true);
  });

  $('btnTreeExpand').addEventListener('click', function () {
    if (rootRow()) expandTree([rootRow()], function () { return true; }, null, EXPAND_LIMIT);
  });
  $('btnTreeCollapse').addEventListener('click', function () { openToLevel(0); });
  var levelButtons = treeView.querySelectorAll('[data-level]');
  for (var lb = 0; lb < levelButtons.length; lb++) {
    levelButtons[lb].addEventListener('click', function () { openToLevel(+this.getAttribute('data-level')); });
  }

  // ---- Paths: path bar, Copy path / Copy value, Code view lookup ----
  var PATH_FORMAT_KEY = 'json-formatter-path-format';
  var PATH_FORMATS = ['js', 'jsonpath', 'jq', 'pointer'];
  var pathBar = $('pathBar'), crumbs = $('crumbs'), pathFormatSel = $('pathFormat'), copyToast = $('copyToast');
  var selectedParts = [], toastTimer = null;
  try {
    var savedFormat = localStorage.getItem(PATH_FORMAT_KEY);
    if (PATH_FORMATS.indexOf(savedFormat) !== -1) pathFormatSel.value = savedFormat;
  } catch (e) {}
  pathFormatSel.addEventListener('change', function () {
    try { localStorage.setItem(PATH_FORMAT_KEY, pathFormatSel.value); } catch (e) {}
    renderCrumbs();
  });

  function pathText(parts) { return T.formatPath(parts, pathFormatSel.value); }

  function selectPath(parts) {
    selectedParts = parts;
    renderCrumbs();
  }

  // Breadcrumb: root > data > users > [2] > email. Each part is a button that jumps there.
  function renderCrumbs() {
    var labels = T.pathLabels(selectedParts);
    crumbs.textContent = '';
    for (var k = 0; k < labels.length; k++) {
      if (k) crumbs.appendChild(el('span', 'crumb-sep', '\u203a')).setAttribute('aria-hidden', 'true');
      var b = crumbs.appendChild(el('button', 'crumb', labels[k]));
      b.type = 'button';
      b.setAttribute('data-depth', k);
      if (k === labels.length - 1) b.setAttribute('aria-current', 'location');
    }
    crumbs.title = pathText(selectedParts) || '(root)';
    // Scroll to the end of a long path in the next frame: reading sizes now would force an
    // extra layout of the whole output (slow for big files).
    requestAnimationFrame(function () { crumbs.scrollLeft = crumbs.scrollWidth; });
  }
  crumbs.addEventListener('click', function (e) {
    var b = e.target.closest('.crumb');
    if (b) jumpToPath(selectedParts.slice(0, +b.getAttribute('data-depth')));
  });

  function jumpToPath(parts) {
    selectPath(parts);
    if (outView === 'tree') revealInTree(parts);
    else selectInCode(parts);
  }

  // Opens the nodes along a path and focuses the deepest row that is shown.
  function findRow(parts) {
    var p = T.formatPath(parts, 'js');
    return treeEl.querySelector('[data-path="' + (window.CSS && CSS.escape ? CSS.escape(p) : p) + '"]');
  }
  function revealInTree(parts) {
    var row = rootRow();
    if (!row) return;
    for (var k = 1; k <= parts.length; k++) {
      if (row._d.container && !row._d.expanded) expandRow(row);
      var child = findRow(parts.slice(0, k));
      if (!child) break;            // beyond the children shown so far ("Show more")
      row = child;
    }
    setActive(row, true);
  }

  // Code view: map between character offsets in the output text and DOM positions.
  function codeOffset() {
    var sel = window.getSelection();
    if (!sel.rangeCount || !outCode.contains(sel.focusNode)) return null;
    var r = document.createRange();
    r.setStart(outCode, 0);
    r.setEnd(sel.focusNode, sel.focusOffset);
    return r.toString().length;
  }
  function domPoint(offset) {
    var walker = document.createTreeWalker(outCode, NodeFilter.SHOW_TEXT), node, pos = 0;
    while ((node = walker.nextNode())) {
      if (pos + node.length >= offset) return { node: node, offset: offset - pos };
      pos += node.length;
    }
    return null;
  }
  output.addEventListener('click', function () {
    var offset = codeOffset();
    if (offset === null || !lastOutput) return;
    try { selectPath(T.pathAtOffset(lastOutput, offset)); } catch (e) {}
  });
  // Selects a value's text in the Code view and scrolls it into view.
  function selectInCode(parts) {
    var range = null;
    try { range = T.rangeOfPath(lastOutput, parts); } catch (e) {}
    if (!range) return;
    var a = domPoint(range.start), b = domPoint(range.end);
    if (!a || !b) return;
    var r = document.createRange();
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    var rect = r.getClientRects()[0] || r.getBoundingClientRect(), box = output.getBoundingClientRect();
    output.scrollTop += rect.top - box.top - box.height / 3;
    output.scrollLeft = Math.max(0, output.scrollLeft + rect.left - box.left - 80);
  }

  // Copying, with a short "Copied" message that is also announced to screen readers.
  function showToast(message) {
    clearTimeout(toastTimer);
    copyToast.classList.remove('show');
    copyToast.textContent = '';
    requestAnimationFrame(function () {
      copyToast.textContent = message;
      copyToast.classList.add('show');
      toastTimer = setTimeout(function () {
        copyToast.classList.remove('show');
        toastTimer = setTimeout(function () { copyToast.textContent = ''; }, 400);
      }, 1800);
    });
  }
  function copyText(text, message) {
    var fallback = function () {
      var ta = el('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.className = 'sr-only';
      document.body.appendChild(ta);
      var prev = document.activeElement, ok = false;
      ta.select();
      try { ok = document.execCommand('copy'); } catch (e) {}
      ta.remove();
      if (prev && prev.focus) prev.focus({ preventScroll: true });
      showToast(ok ? message : 'Couldn\u2019t copy: the browser blocked the clipboard');
    };
    try {
      navigator.clipboard.writeText(text).then(function () { showToast(message); }, fallback);
    } catch (e) { fallback(); }
  }
  function copyPath(parts) {
    var p = pathText(parts);
    copyText(p, 'Copied ' + (p || '(root)'));
  }
  function copyValue(parts) {
    var v = T.valueAtPath(treeValue, parts), text;
    if (v === undefined) return;
    try { text = T.copyValueText(v, indentSel.value === 'tab' ? '\t' : +indentSel.value); }
    catch (e) { showToast('Couldn\u2019t copy: this value is nested too deeply'); return; }
    copyText(text, 'Copied value of ' + (pathText(parts) || 'the root'));
  }
  $('btnCopyPath').addEventListener('click', function () { copyPath(selectedParts); });
  $('btnCopyValue').addEventListener('click', function () { copyValue(selectedParts); });

  // One small copy button, moved to the hovered or focused row (no extra element per row).
  var rowCopy = el('button', 'tree-copy');
  rowCopy.type = 'button';
  rowCopy.tabIndex = -1;
  rowCopy.title = 'Copy path';
  rowCopy.setAttribute('aria-hidden', 'true');
  rowCopy.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';
  function placeRowCopy(row) {
    if (row._d.parts && rowCopy.parentNode !== row) row.appendChild(rowCopy);
  }
  treeEl.addEventListener('mouseover', function (e) {
    var row = e.target.closest('.tree-row');
    if (row) placeRowCopy(row);
  });

  setOutView(outView, false);

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
