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
    btnDownload.disabled = true;
    if (searchOpen) {
      searchGen++;
      setHits([], false, null, input.value.trim() ? 'Fix the input to search it' : '');
    }
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
        lastHtml = formatted.html;
        codeHasMarks = false;
        outCode.classList.toggle('hl', formatted.html !== null);
        setGutterLines('output', outGutter, outTrack, T.countLines(formatted.result));
        showResult();
        if (searchActive()) runSearch(true);   // the data changed: search it again
        outMeta.innerHTML = badges(formatted.meta);
        btnCopy.disabled = false;
        btnUse.disabled = false;
        btnDownload.disabled = false;

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

  $('btnSample').addEventListener('click', function () { treeResetNext = true; loadedFileName = null; input.value = SAMPLE; setMode('format'); });
  $('btnClear').addEventListener('click', function () { treeResetNext = true; loadedFileName = null; input.value = ''; update(); input.focus(); });

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
    reader.onload = function () { treeResetNext = true; loadedFileName = f.name; input.value = String(reader.result || ''); setMode('format'); };
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
    btnFilter.hidden = view !== 'tree';
    if (lastOutput) {
      showResult();
      reveal(view === 'tree' ? treeView : output);
      if (view === 'code' && codeMarksDirty) renderCodeMarks();
      if (searchActive() && current >= 0) showCurrent();
    }
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
    // With the search filter on, rows below a match show all their children.
    d.unfiltered = !treeFilter || (parent ? parent.unfiltered : false) || treeFilter.matched.has(path);

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
        d.cut = view.cut;
        d.pinned = false;
        span.title = view.full.length > 10000 ? view.full.slice(0, 10000) + '\u2026' : view.full;
        row.appendChild(el('span', 'tree-str-toggle', 'more'));
      }
    }
    if (matchIndex && matchIndex.has(path)) paintRow(row);
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
    var entries = d.filtered ? d.filtered.slice(from, to) : T.listChildren(d.value, from, to, d.info.keys);
    for (var i = 0; i < entries.length; i++) {
      rows.push(frag.appendChild(makeRow(entries[i], d.level + 1, d, from + i + 1, childCount(d))));
    }
    d.shown = from + entries.length;
    return { frag: frag, rows: rows };
  }

  // "Show 100 more" / "Show all" rows for children not built yet.
  function moreFragment(parent) {
    var d = parent._d, left = childCount(d) - d.shown, frag = document.createDocumentFragment();
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
    prepareChildren(row);
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
  // grow(row), if given, returns how many children a newly opened row should show; extra
  // pages are added a few hundred rows per slice (used to restore "Show more" pages).
  function expandTree(rows, shouldOpen, done, limit, grow) {
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
        var item = queue[qi++], row = item.row || item, kids;
        if (!row.isConnected || !row._d.container) continue;
        if (item.to) {                                 // the next part of a restored page run
          var before = row._d.shown;
          kids = ensureChildShown(row, Math.min(item.to, before + 500) - 1);
          created += row._d.shown - before;
          if (row._d.shown < item.to && row._d.shown > before) queue.push({ row: row, to: item.to });
        } else {
          if (!shouldOpen(row._d)) continue;
          var opening = !row._d.expanded;
          kids = opening ? expandRow(row) : childContainers(row);
          if (opening) created += row._d.shown;
          var want = opening && grow ? grow(row) : 0;
          if (want > row._d.shown) queue.push({ row: row, to: want });
        }
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
    var target = all ? childCount(d) : Math.min(childCount(d), d.shown + TREE_PAGE);
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
    if (d.painted) paintRow(row);
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
  // The open rows (with how many children each shows) and the active row, so a rebuilt tree
  // can look the same.
  function captureTreeState() {
    var open = new Map(), rows = treeEl.querySelectorAll('[aria-expanded="true"]');
    for (var i = 0; i < rows.length; i++) open.set(rows[i]._d.path, rows[i]._d.shown);
    return { open: open, active: activeRow && activeRow.isConnected && activeRow._d.parts ? activeRow._d.path : null };
  }

  // Rebuilds the tree for treeValue.
  //  - With the search filter on: only matches and the nodes above them, opened.
  //  - With opts.restore (or while the user is typing): the same rows open as before,
  //    including pages added with "Show more".
  //  - After loading new data: the first two levels open.
  var pendingTreeRestore = null;
  function buildTree(opts) {
    opts = opts || {};
    var restore = opts.restore || pendingTreeRestore || null, typing = false;
    pendingTreeRestore = null;
    if (!restore && !treeFilter && !treeResetNext && rootRow()) { restore = captureTreeState(); typing = true; }
    treeResetNext = false;
    treeDirty = false;
    treeGen++;
    treeEl.textContent = '';
    if (useHighlights) { hlAll.clear(); hlCurrent.clear(); }
    activeRow = null;
    var root = makeRow(null, 1, null);
    treeEl.appendChild(makeBlock()).appendChild(root);
    setActive(root, false);
    var openDefault = function () { expandTree([root], function (d) { return d.level <= DEFAULT_TREE_LEVEL; }); };
    if (treeFilter) {
      expandTree([root], function (d) { return treeFilter.ancestors.has(d.path); }, function () {
        if (searchActive() && current >= 0) showCurrent();
      }, EXPAND_LIMIT);
    } else if (restore) {
      // While typing, if none of the open nodes (below the root) exist any more, this is new
      // data rather than an edit, so open the default levels instead.
      var matched = 0;
      expandTree([root], function (d) {
        var hit = restore.open.has(d.path);
        if (hit && d.path !== '') matched++;
        return hit;
      }, function () {
        if (typing && !matched) { openDefault(); return; }
        var match = restore.active !== null && findRowByPath(restore.active);
        if (match) setActive(match, false);
      }, null, function (row) { return restore.open.get(row._d.path) || 0; });
    } else {
      openDefault();
    }
  }

  function findRowByPath(path) {
    return treeEl.querySelector('[data-path="' + (window.CSS && CSS.escape ? CSS.escape(path) : path) + '"]');
  }

  // Children of a row as listed in the tree: all of them, or with the search filter on,
  // only those on the way to a match.
  function childCount(d) { return d.filtered ? d.filtered.length : d.info.count; }
  function prepareChildren(row) {
    var d = row._d;
    if (!treeFilter || d.unfiltered || d.filtered) return;
    var all = T.listChildren(d.value, 0, d.info.count, d.info.keys), keep = [];
    for (var i = 0; i < all.length; i++) {
      if (treeFilter.relevant.has(T.childPath(d.path, all[i].key, all[i].isIndex))) keep.push(all[i]);
    }
    d.filtered = keep;
  }
  function childPosition(d, key) {
    if (d.filtered) {
      for (var i = 0; i < d.filtered.length; i++) if (d.filtered[i].key === key) return i;
      return -1;
    }
    if (typeof key === 'number') return key < d.info.count ? key : -1;
    return d.info.keys ? d.info.keys.indexOf(key) : -1;
  }

  // Builds an open row's children up to (the page containing) child number pos, so a
  // node past the first 100 children can be shown. Returns the new child rows.
  function ensureChildShown(parent, pos) {
    var d = parent._d;
    if (pos < d.shown || pos >= childCount(d)) return [];
    d.token = (d.token || 0) + 1;                      // stops a "Show all" still running
    var end = afterDescendants(parent), last = end ? prevRow(end) : lastRow();
    while (last && last !== parent && last._d.more && last._d.parent === parent) {
      var p = prevRow(last);
      removeRow(last);
      last = p;
    }
    var c = childFragment(parent, d.shown, Math.min(childCount(d), Math.ceil((pos + 1) / TREE_PAGE) * TREE_PAGE));
    c.frag.appendChild(moreFragment(parent));
    insertRowsAfter(last, c.frag);
    return c.rows;
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
    if (outView === 'tree') revealInTree(parts, true);
    else selectInCode(parts);
  }

  // Opens the nodes along a path and focuses the deepest row that is shown.
  function findRow(parts) {
    var p = T.formatPath(parts, 'js');
    return treeEl.querySelector('[data-path="' + (window.CSS && CSS.escape ? CSS.escape(p) : p) + '"]');
  }
  // Opens every node along a path, building child pages as needed (also past the first
  // 100 children), and makes the row active. Returns the row.
  function revealInTree(parts, focus) {
    var row = rootRow();
    if (!row) return null;
    for (var k = 0; k < parts.length; k++) {
      var d = row._d;
      if (!d.container) break;
      if (!d.expanded) expandRow(row);
      var pos = childPosition(d, parts[k]);
      if (pos < 0) break;
      ensureChildShown(row, pos);
      var child = findRow(parts.slice(0, k + 1));
      if (!child) break;
      row = child;
    }
    setActive(row, !!focus);
    return row;
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
  // Says something to screen readers through the same live region, without showing it.
  function announce(text) {
    clearTimeout(toastTimer);
    copyToast.classList.remove('show');
    copyToast.textContent = '';
    requestAnimationFrame(function () { copyToast.textContent = text; });
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

  // ---- Search ----
  // Searches the parsed data (not the page), so it finds matches in rows not built yet.
  // The search runs in short slices; results are shown in both views.
  var SEARCH_KEY = 'json-formatter-search';
  var searchBar = $('searchBar'), searchInput = $('searchInput'), searchCount = $('searchCount'), searchNote = $('searchNote');
  var btnSearch = $('btnSearch'), btnSearchPrev = $('btnSearchPrev'), btnSearchNext = $('btnSearchNext');
  var btnFilter = $('btnSearchFilter'), outputPane = output.closest('.pane');
  var searchOpts = { scope: 'both', caseSensitive: false, wholeWord: false, regex: false };
  try {
    var savedSearch = JSON.parse(localStorage.getItem(SEARCH_KEY) || 'null');
    if (savedSearch && typeof savedSearch === 'object') {
      if (['keys', 'values', 'both'].indexOf(savedSearch.scope) !== -1) searchOpts.scope = savedSearch.scope;
      searchOpts.caseSensitive = savedSearch.caseSensitive === true;
      searchOpts.wholeWord = savedSearch.wholeWord === true;
      searchOpts.regex = savedSearch.regex === true;
    }
  } catch (e) {}
  var searchOpen = false, searchFilter = false, searchReturn = null, searchTimer = null, searchGen = 0, searching = false;
  var hits = [], hitsTruncated = false, hitsError = null, current = -1;
  var matchIndex = null, treeFilter = null, savedTreeState = null;
  var lastHtml = null, codeHasMarks = false, codeMarksDirty = false;

  function searchActive() { return searchOpen && !!searchInput.value && !!lastOutput; }

  function syncSearchOptions() {
    var scopes = searchBar.querySelectorAll('[data-scope]');
    for (var i = 0; i < scopes.length; i++) {
      var on = scopes[i].getAttribute('data-scope') === searchOpts.scope;
      scopes[i].classList.toggle('active', on);
      scopes[i].setAttribute('aria-pressed', String(on));
    }
    $('btnSearchCase').setAttribute('aria-pressed', String(searchOpts.caseSensitive));
    $('btnSearchWord').setAttribute('aria-pressed', String(searchOpts.wholeWord));
    $('btnSearchRegex').setAttribute('aria-pressed', String(searchOpts.regex));
    btnFilter.setAttribute('aria-pressed', String(searchFilter));
  }
  function setSearchOption(name, value) {
    searchOpts[name] = value;
    try { localStorage.setItem(SEARCH_KEY, JSON.stringify(searchOpts)); } catch (e) {}
    syncSearchOptions();
    runSearch(false);
  }

  function openSearch() {
    var a = document.activeElement;
    if (!searchBar.contains(a)) searchReturn = a && a !== document.body ? a : null;
    if (!searchOpen) {
      searchOpen = true;
      searchBar.hidden = false;
      btnSearch.setAttribute('aria-expanded', 'true');
      if (searchInput.value) runSearch(true);
    }
    searchInput.focus();
    searchInput.select();
  }
  function closeSearch() {
    searchOpen = false;
    searchBar.hidden = true;
    btnSearch.setAttribute('aria-expanded', 'false');
    clearTimeout(searchTimer);
    searchTimer = null;
    searchGen++;
    searching = false;
    setHits([], false, null, '');
    var back = searchReturn;
    searchReturn = null;
    if (back && back.isConnected && back.focus) back.focus(); else btnSearch.focus();
  }

  // Runs the search now. keepCurrent keeps the current match if it still exists; then is
  // called when the search is done.
  function runSearch(keepCurrent, then) {
    clearTimeout(searchTimer);
    searchTimer = null;
    var gen = ++searchGen, query = searchInput.value;
    if (!searchOpen || !query || !lastOutput) {
      searching = false;
      setHits([], false, null, query && searchOpen && !lastOutput && input.value.trim() ? 'Fix the input to search it' : '');
      if (then) then();
      return;
    }
    var prev = keepCurrent && current >= 0 ? hits[current] : null;
    var s = T.createSearch(treeValue, query, searchOpts);
    searching = true;
    (function step() {
      if (gen !== searchGen) return;
      var t0 = performance.now();
      while (!s.done && performance.now() - t0 < 12) s.step(2000);
      if (!s.done) { setTimeout(step, 0); return; }
      searching = false;
      var keep = -1;
      if (prev) {
        for (var i = 0; i < s.matches.length; i++) {
          var m = s.matches[i];
          if (m.where === prev.where && m.start === prev.start && m.path.length === prev.path.length &&
              T.formatPath(m.path, 'js') === T.formatPath(prev.path, 'js')) { keep = i; break; }
        }
      }
      setHits(s.matches, s.truncated, s.error, null, keep);
      announce(countMessage());
      if (current >= 0) showCurrent();
      if (then) then();
    })();
  }

  function countMessage() {
    if (hitsError) return hitsError;
    if (!hits.length) return 'No matches';
    return T.groupDigits(hits.length) + (hitsTruncated ? '+' : '') + (hits.length === 1 ? ' match' : ' matches');
  }

  // Stores new results and updates every place that shows them.
  function setHits(list, truncated, error, note, keep) {
    hits = list;
    hitsTruncated = truncated;
    hitsError = error;
    current = keep >= 0 ? keep : list.length ? 0 : -1;
    matchIndex = null;
    if (list.length) {
      matchIndex = new Map();
      for (var i = 0; i < list.length; i++) {
        var p = T.formatPath(list[i].path, 'js'), e = matchIndex.get(p);
        if (!e) matchIndex.set(p, e = { key: [], value: [] });
        e[list[i].where].push({ start: list[i].start, end: list[i].end, i: i });
      }
    }
    if (!treeDirty) refreshTreeMatches();
    codeMarksDirty = true;
    if (outView === 'code' && lastOutput) renderCodeMarks();
    applyFilter();
    updateSearchStatus(note);
  }

  function updateSearchStatus(note) {
    var n = hits.length;
    searchCount.textContent = !searchOpen || !searchInput.value || hitsError || note ? '' :
      n ? T.groupDigits(current + 1) + ' of ' + T.groupDigits(n) + (hitsTruncated ? '+' : '') : 'No matches';
    var msg = note || hitsError || (hitsTruncated ? T.groupDigits(n) + '+ matches, showing the first ' + T.groupDigits(n) : '');
    searchNote.textContent = msg;
    searchNote.hidden = !msg;
    btnSearchPrev.disabled = btnSearchNext.disabled = !n;
    searchInput.setAttribute('aria-invalid', String(!!hitsError));
  }

  // Next (+1) or previous (-1) match, wrapping around. A search still waiting to run
  // (typing just stopped) runs first and shows its current match.
  function go(delta) {
    if (searchTimer || searching) { runSearch(true); return; }
    if (!hits.length) return;
    goTo((current + delta + hits.length) % hits.length);
  }
  function goTo(i) {
    current = i;
    updateSearchStatus();
    showCurrent();
    announce('Match ' + T.groupDigits(i + 1) + ' of ' + T.groupDigits(hits.length) + (hitsTruncated ? '+' : ''));
  }

  // Shows the current match: in the tree, opens its row and makes it active (focus stays in
  // the search field); in the Code view, scrolls to it.
  function showCurrent() {
    var m = hits[current];
    if (!m) return;
    selectPath(m.path);
    if (outView === 'tree') {
      if (treeDirty) return;
      var row = revealInTree(m.path, false);
      markCurrentTree(row);
      if (row) scrollIntoBox(treeEl.parentNode, row);
    } else {
      markCurrentCode(true);
    }
  }

  function scrollIntoBox(box, target) {
    var r = target.getBoundingClientRect(), b = box.getBoundingClientRect();
    if (r.top < b.top + 8 || r.bottom > b.bottom - 8) box.scrollTop += r.top - b.top - b.height / 3;
    if (r.left < b.left + 64 || r.right > b.right - 16) box.scrollLeft = Math.max(0, box.scrollLeft + r.left - b.left - 96);
  }

  // ---- Highlights in the tree ----
  // Where supported, matches are CSS Custom Highlights: ranges over the rows' existing
  // text, so painting or clearing thousands of matches changes no DOM. (Removing nodes
  // inside content-visibility blocks is slow.) Otherwise <mark> elements are used.
  var useHighlights = typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight === 'function' && typeof StaticRange === 'function';
  var hlAll = null, hlCurrent = null;
  if (useHighlights) {
    hlAll = new Highlight();
    hlCurrent = new Highlight();
    hlCurrent.priority = 1;
    CSS.highlights.set('json-search', hlAll);
    CSS.highlights.set('json-search-current', hlCurrent);
  }
  function addRanges(row, target, ranges, map, limit) {
    var node = target.firstChild, d = row._d, hasCurrent = false;
    if (!ranges || !node || node.nodeType !== 3) return false;
    for (var k = 0; k < ranges.length; k++) {
      var r = ranges[k];
      if (r.start >= limit) break;
      var s = map(r.start), e = Math.min(map(Math.min(r.end, limit)), node.length);
      if (s >= e) continue;
      var range = new StaticRange({ startContainer: node, startOffset: s, endContainer: node, endOffset: e });
      hlAll.add(range);
      (d.hl || (d.hl = [])).push({ range: range, i: r.i });
      if (r.i === current) { hlCurrent.add(range); hasCurrent = true; }
    }
    return hasCurrent;
  }
  function clearRowRanges(row) {
    var d = row._d;
    if (!d.hl) return;
    for (var k = 0; k < d.hl.length; k++) { hlAll.delete(d.hl[k].range); hlCurrent.delete(d.hl[k].range); }
    d.hl = null;
  }
  function setMarks(target, text, ranges, map, limit) {
    if (!ranges || !ranges.length) {
      if (target.firstElementChild) target.textContent = text;
      return false;
    }
    target.textContent = '';
    var pos = 0, hasCurrent = false;
    for (var k = 0; k < ranges.length; k++) {
      var r = ranges[k];
      if (r.start >= limit) break;
      var s = map(r.start), e = map(Math.min(r.end, limit));
      if (s < pos) continue;
      if (s > pos) target.appendChild(document.createTextNode(text.slice(pos, s)));
      var mk = target.appendChild(el('mark', 'm', text.slice(s, e)));
      mk.setAttribute('data-i', r.i);
      if (r.i === current) { mk.classList.add('current'); hasCurrent = true; }
      pos = e;
    }
    if (pos < text.length) target.appendChild(document.createTextNode(text.slice(pos)));
    return hasCurrent;
  }
  function paintRow(row) {
    var d = row._d;
    if (!d.parts) return;
    var e = matchIndex && matchIndex.get(d.path), hasCurrent = false;
    if (useHighlights) {
      clearRowRanges(row);
      if (e) {
        var rawKey = d.parts[d.parts.length - 1], kEl = typeof rawKey === 'string' && row.querySelector('.tree-key');
        if (kEl) {
          var q = T.displayKey(rawKey) !== rawKey;
          hasCurrent = addRanges(row, kEl, e.key, function (k) { return q ? T.jsonStringOffset(rawKey, k) : k; }, Infinity);
        }
        var vEl = !d.info && row.querySelector('.tree-val');
        if (vEl) {
          var val = d.value, str = typeof val === 'string', whole = !d.full || vEl.classList.contains('full');
          hasCurrent = addRanges(row, vEl, e.value, function (k) { return str ? T.jsonStringOffset(val, k) : k; },
            whole ? Infinity : d.cut) || hasCurrent;
        }
      }
      d.painted = !!e;
      row.classList.toggle('match-current', hasCurrent);
      return;
    }
    var raw = d.parts[d.parts.length - 1], keyEl = typeof raw === 'string' && row.querySelector('.tree-key');
    if (keyEl) {
      var shown = T.displayKey(raw), quoted = shown !== raw;
      hasCurrent = setMarks(keyEl, shown, e && e.key, function (k) { return quoted ? T.jsonStringOffset(raw, k) : k; }, Infinity);
    }
    var valEl = !d.info && row.querySelector('.tree-val');
    if (valEl) {
      var v = d.value, isStr = typeof v === 'string', full = !d.full || valEl.classList.contains('full');
      var text = d.full ? (full ? d.full : d.short) : T.scalarView(v).text;
      hasCurrent = setMarks(valEl, text, e && e.value, function (k) { return isStr ? T.jsonStringOffset(v, k) : k; },
        full ? Infinity : d.cut) || hasCurrent;
    }
    d.painted = !!e;
    row.classList.toggle('match-current', hasCurrent);
  }
  function refreshTreeMatches() {
    if (useHighlights) { hlAll.clear(); hlCurrent.clear(); }
    // A static list: painting changes the DOM, which would make a live list re-scan the
    // whole tree on every step.
    var rows = treeEl.querySelectorAll('.tree-row');
    for (var i = 0; i < rows.length; i++) {
      var d = rows[i]._d;
      if (useHighlights) d.hl = null;
      if (d.painted || (matchIndex && matchIndex.has(d.path))) paintRow(rows[i]);
    }
  }
  function markCurrentTree(row) {
    var old = treeEl.querySelectorAll('mark.current, .match-current');
    for (var i = 0; i < old.length; i++) old[i].classList.remove('current', 'match-current');
    if (useHighlights) {
      hlCurrent.clear();
      if (row && row._d.hl) {
        for (var k = 0; k < row._d.hl.length; k++) if (row._d.hl[k].i === current) hlCurrent.add(row._d.hl[k].range);
      }
    }
    if (!row) return;
    var mk = row.querySelector('mark[data-i="' + current + '"]');
    if (mk) mk.classList.add('current');
    row.classList.add('match-current');
  }

  // ---- Highlights in the Code view ----
  function renderCodeMarks() {
    codeMarksDirty = false;
    if (!lastOutput) return;
    if (!hits.length) {
      if (codeHasMarks) {
        if (lastHtml !== null) outCode.innerHTML = lastHtml; else outCode.textContent = lastOutput;
        codeHasMarks = false;
      }
      return;
    }
    var ranges = T.locateMatches(lastOutput, hits), list = [];
    for (var i = 0; i < ranges.length; i++) if (ranges[i]) list.push({ start: ranges[i].start, end: ranges[i].end, i: i });
    outCode.innerHTML = T.highlightMarked(lastOutput, list, lastHtml !== null);
    codeHasMarks = true;
    markCurrentCode(false);
  }
  function markCurrentCode(scroll) {
    var old = outCode.querySelector('mark.current');
    if (old) old.classList.remove('current');
    if (current < 0) return;
    var mk = outCode.querySelector('mark[data-i="' + current + '"]');
    if (!mk) return;
    mk.classList.add('current');
    if (scroll) scrollIntoBox(output, mk);
  }

  // ---- Filter (tree only) ----
  function buildFilterSets(list) {
    var relevant = new Set(), ancestors = new Set(), matched = new Set();
    relevant.add('');
    for (var i = 0; i < list.length; i++) {
      var parts = list[i].path, p = '';
      for (var k = 0; k < parts.length; k++) {
        ancestors.add(p);
        p = T.childPath(p, parts[k], typeof parts[k] === 'number');
        relevant.add(p);
      }
      matched.add(p);
    }
    return { relevant: relevant, ancestors: ancestors, matched: matched };
  }
  // Turns the filtered tree on or off to match the Filter toggle and the current results.
  // Turning it off restores the open rows and active row from before.
  function applyFilter() {
    var want = searchFilter && searchActive() && !hitsError;
    if (want) {
      if (!treeFilter && rootRow()) savedTreeState = captureTreeState();
      treeFilter = buildFilterSets(hits);
      if (outView === 'tree') buildTree({}); else treeDirty = true;
    } else if (treeFilter) {
      treeFilter = null;
      var state = savedTreeState;
      savedTreeState = null;
      if (outView === 'tree' && lastOutput) buildTree({ restore: state });
      else { treeDirty = true; pendingTreeRestore = state; }
    }
  }

  // ---- Wiring ----
  btnSearch.addEventListener('click', function () { if (searchOpen) closeSearch(); else openSearch(); });
  $('btnSearchClose').addEventListener('click', closeSearch);
  btnSearchNext.addEventListener('click', function () { go(1); });
  btnSearchPrev.addEventListener('click', function () { go(-1); });
  searchInput.addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { runSearch(false); }, 150);
  });
  searchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); go(e.shiftKey ? -1 : 1); }
  });
  searchBar.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
  });
  var scopeButtons = searchBar.querySelectorAll('[data-scope]');
  for (var sb = 0; sb < scopeButtons.length; sb++) {
    scopeButtons[sb].addEventListener('click', function () { setSearchOption('scope', this.getAttribute('data-scope')); });
  }
  $('btnSearchCase').addEventListener('click', function () { setSearchOption('caseSensitive', !searchOpts.caseSensitive); });
  $('btnSearchWord').addEventListener('click', function () { setSearchOption('wholeWord', !searchOpts.wholeWord); });
  $('btnSearchRegex').addEventListener('click', function () { setSearchOption('regex', !searchOpts.regex); });
  btnFilter.addEventListener('click', function () {
    searchFilter = !searchFilter;
    syncSearchOptions();
    applyFilter();
    if (!searchFilter && searchActive() && current >= 0) showCurrent();
  });

  function isTyping(a) {
    if (!a) return false;
    var tag = a.tagName;
    return tag === 'TEXTAREA' || tag === 'SELECT' || a.isContentEditable ||
      (tag === 'INPUT' && !/^(button|checkbox|radio|file|submit|reset|range|color|image)$/i.test(a.type));
  }
  // Ctrl/Cmd + F opens the search only when focus is in the output pane (elsewhere the
  // browser's own find works as usual); / opens it when not typing in a field.
  document.addEventListener('keydown', function (e) {
    var a = document.activeElement;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'f' || e.key === 'F')) {
      if (outputPane.contains(a)) { e.preventDefault(); openSearch(); }
      return;
    }
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTyping(a)) {
      e.preventDefault();
      openSearch();
    }
  });
  syncSearchOptions();

  // ---- Download ----
  // Saves the output as a .json file made in the browser (a Blob), so it works offline.
  var btnDownload = $('btnDownload');
  var loadedFileName = null;   // name of the file opened with "Open file", if any

  function downloadOutput() {
    if (!lastOutput) {
      showToast('Nothing to download yet: the input needs to be valid JSON');
      return;
    }
    var name = T.downloadName(loadedFileName, mode === 'minify');
    var url = URL.createObjectURL(new Blob([lastOutput], { type: 'application/json' }));
    var a = el('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
    showToast('Downloading ' + name);
  }
  btnDownload.addEventListener('click', downloadOutput);

  // Ctrl/Cmd + S downloads the result instead of saving the page.
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      clearTimeout(timer);
      update();
      downloadOutput();
    }
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
