/*
 * UI wiring for JSON Prettify: reads the input, renders the result and
 * status bar, and handles toolbar actions. Pure helpers live in json-tools.js.
 */
(function () {
  'use strict';

  var T = window.JsonTools;
  var fmtBytes = T.fmtBytes, byteLen = T.byteLen, esc = T.esc;

  var $ = function (id) { return document.getElementById(id); };
  var input = $('input'), output = $('output'), outCode = $('outCode'), outTitle = $('outTitle');
  var outMeta = $('outMeta'), inMeta = $('inMeta');
  var outEmpty = $('outEmpty'), outEmptyTitle = $('outEmptyTitle'), outEmptyText = $('outEmptyText');
  var statusEl = $('status'), indentSel = $('indent'), sortBox = $('sortKeys');
  var btnFormat = $('btnFormat'), btnMinify = $('btnMinify'), btnCopy = $('btnCopy'), btnUse = $('btnUse');
  var inGutter = $('inGutter'), inTrack = $('inGutterTrack'), inMark = $('inGutterMark');
  var inputView = $('inputView'), inputNote = $('inputNote'), inputNoteText = $('inputNoteText'), btnEditLarge = $('btnEditLarge');

  // The output's Code view and the read-only view for large inputs draw only the rows on
  // screen (code-view.js).
  var codeView = window.CodeView.create({
    scroller: output, rows: output.querySelector('.code-rows'), pre: output.querySelector('pre'), code: outCode,
    gutter: $('outGutter'), track: $('outGutterTrack')
  });
  var bigInputView = window.CodeView.create({
    scroller: inputView, rows: inputView.querySelector('.code-rows'), pre: inputView.querySelector('pre'), code: $('inViewCode'),
    gutter: $('inViewGutter'), track: $('inViewTrack'), lineMark: $('inViewMark')
  });

  /*
   * Sizes, in characters. Inputs up to SYNC_CHARS are processed on the main thread as you
   * type, exactly as before (it takes a few milliseconds). Bigger inputs are processed in a
   * Web Worker, and typing no longer re-formats them on every pause: Format (Ctrl/Cmd +
   * Enter) does. Above VIEW_ONLY_CHARS or VIEW_ONLY_LINES the input is shown read-only,
   * because the browser's text box takes seconds to load text that big and is slow to type
   * in; "Edit as text" still loads it there, up to EDIT_MAX_CHARS. Files over MAX_FILE_BYTES
   * are not opened: the browser would run out of memory.
   */
  var SYNC_CHARS = 1000000, VIEW_ONLY_CHARS = 2000000, VIEW_ONLY_LINES = 50000, EDIT_MAX_CHARS = 10000000;
  var MAX_FILE_BYTES = 256 * 1048576, PROGRESS_DELAY = 300;

  var mode = 'format';
  var lastOutput = '';
  var lastView = '';
  var lastResultAsync = false;   // the output came from the worker (it can answer questions about it)

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
    if (schemaBadge && state === 'valid') placeSchemaBadge();
  }

  // The schema check's result in the status bar ("Valid against schema", "3 schema
  // errors"...), set by schema.js: { state, text, title } or null. Kept when the status
  // is redrawn.
  var schemaBadge = null;
  function placeSchemaBadge() {
    var old = statusEl.querySelector('.schema-badge');
    if (old) old.remove();
    if (!schemaBadge || statusEl.getAttribute('data-state') !== 'valid') return;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'schema-badge';
    b.setAttribute('data-state', schemaBadge.state);
    b.textContent = schemaBadge.text;
    if (schemaBadge.title) b.title = schemaBadge.title;
    b.addEventListener('click', function () { if (schemaHook && schemaHook.showList) schemaHook.showList(); });
    var actions = statusEl.querySelector('.status-actions');
    statusEl.insertBefore(b, actions);
  }

  function showEmpty(kind, title, text) {
    lastOutput = '';
    lastResultAsync = false;
    codeView.clear();
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
    btnCopyPath.disabled = btnCopyValue.disabled = true;
    btnDownload.disabled = true;
    btnShare.disabled = true;
    if (searchOpen) {
      searchGen++;
      setHits([], false, null, kind === 'info' || kind === 'stopped' ? '' : inputText().trim() ? 'Fix the input to search it' : '');
    }
  }

  // Output formats. JSON gets the tree, path bar and JSON-aware search; the others are shown
  // as text in the Code view. The conversions themselves are in json-tools.js (runJob).
  var FORMATS = {
    json: { label: 'JSON', mime: 'application/json' },
    yaml: { label: 'YAML', mime: 'application/yaml' }
  };
  var CSV_KEY = 'json-formatter-csv', csvOpts = { delimiter: ',', protect: true };
  try {
    var savedCsv = JSON.parse(localStorage.getItem(CSV_KEY) || 'null');
    if (savedCsv && typeof savedCsv === 'object') {
      if ([',', ';', '\t'].indexOf(savedCsv.delimiter) !== -1) csvOpts.delimiter = savedCsv.delimiter;
      if (typeof savedCsv.protect === 'boolean') csvOpts.protect = savedCsv.protect;
    }
  } catch (e) {}
  FORMATS.csv = { label: 'CSV', mime: 'text/csv;charset=utf-8', bom: true };
  var TS_KEY = 'json-formatter-ts', tsOpts = { style: 'interface', rootName: 'Root' };
  try {
    var savedTs = JSON.parse(localStorage.getItem(TS_KEY) || 'null');
    if (savedTs && typeof savedTs === 'object') {
      if (savedTs.style === 'type') tsOpts.style = 'type';
      if (typeof savedTs.rootName === 'string') tsOpts.rootName = savedTs.rootName.slice(0, 60);
    }
  } catch (e) {}
  // Plain text: some systems treat .ts as an MPEG video file.
  FORMATS.ts = { label: 'TypeScript', mime: 'text/plain;charset=utf-8' };
  var outFormat = 'json';
  var FORMAT_KEY = 'json-formatter-format', outFormatSel = $('outFormat');
  try {
    var savedFormat = localStorage.getItem(FORMAT_KEY);
    if (FORMATS[savedFormat]) outFormat = outFormatSel.value = savedFormat;
  } catch (e) {}

  // Options for a job (see runJob in json-tools.js).
  function jobOptions() {
    return {
      mode: mode, indent: indentSel.value === 'tab' ? '\t' : +indentSel.value, sort: sortBox.checked, format: outFormat,
      csv: { delimiter: csvOpts.delimiter, protect: csvOpts.protect }, ts: { style: tsOpts.style, rootName: tsOpts.rootName }
    };
  }

  // r: a failed job ({ deep, tooBig, message, depth }).
  function showFailure(r) {
    setStatus('invalid', 'Error',
      r.tooBig ? 'This JSON is too big for the browser to format.' :
        r.deep ? 'This JSON is nested too deeply to format.' : 'Something went wrong while formatting this JSON.',
      r.depth !== null && r.depth !== undefined ? ['depth ' + r.depth.toLocaleString('en-US')] : null);
    showEmpty('error', 'Can\u2019t show a result', r.tooBig
      ? 'The browser ran out of memory. Try a smaller file, or a browser on a computer with more memory.'
      : r.deep ? 'The browser can\u2019t format JSON nested this deeply. Try formatting a smaller part of it.'
        : (r.message || 'Unknown error') + '.');
  }

  // ---- Line-number gutter of the input text box ----
  // The numbers are one string in a data attribute, shown with CSS generated content.
  // It is rebuilt only when the line count changes, never on every keystroke.
  var gutterCount = 0;

  function setInputGutterLines(count) {
    if (gutterCount === count) return;
    gutterCount = count;
    inTrack.setAttribute('data-lines', T.lineNumbers(count));
    inGutter.style.setProperty('--digits', T.gutterDigits(count));
  }

  // The textarea scrolls by itself (wheel, keys, touch, paste, caret moves); the gutter
  // track follows its scrollTop.
  function syncInputGutter() {
    inTrack.style.transform = 'translateY(' + (-input.scrollTop) + 'px)';
  }

  function refreshInputGutter() {
    if (bigText !== null) return;
    setInputGutterLines(T.countLines(input.value));
    syncInputGutter();
  }

  // Highlights the number of the line with a syntax error (null clears it).
  function markErrorLine(line) {
    if (bigText !== null) {
      bigInputView.markLine(line);
      inMark.hidden = true;
      return;
    }
    if (line) {
      inMark.textContent = line;
      inMark.style.setProperty('--mark-line', line);
      inMark.hidden = false;
    } else {
      inMark.hidden = true;
    }
  }

  // ---- The input: the text box, or a read-only view for large texts ----
  var bigText = null;                    // the input while it is shown read-only (else null)
  var bigBytes = null;                   // its size in bytes
  var textVersion = 0;                   // goes up whenever the input text changes
  var editPaused = false;                // a large input was edited and not formatted since

  function inputText() { return bigText !== null ? bigText : input.value; }
  function hasText(text) { return /\S/.test(text); }   // without trimming a copy of a big text

  function isBigText(text) {
    return text.length > VIEW_ONLY_CHARS || (text.length > VIEW_ONLY_LINES && T.countLines(text) > VIEW_ONLY_LINES);
  }

  // Replaces the input. info.bytes: the file size, when it came from a file.
  function setInputText(text, info) {
    textVersion++;
    editPaused = false;
    if (isBigText(text)) {
      var hadFocus = document.activeElement === input || document.activeElement === inputView;
      bigText = text;
      bigBytes = info && info.bytes !== undefined ? info.bytes : byteLen(text);
      input.value = '';
      input.hidden = true;
      inGutter.hidden = true;
      inMark.hidden = true;
      inputView.hidden = false;
      bigInputView.setText(text);
      if (hadFocus) inputView.focus();
    } else {
      if (bigText !== null) {
        bigText = null;
        bigBytes = null;
        inputView.hidden = true;
        bigInputView.clear();
        input.hidden = false;
        inGutter.hidden = false;
        gutterCount = -1;
      }
      input.value = text;
    }
    syncInputNote();
  }

  function syncInputNote() {
    var msg = '';
    if (bigText !== null) {
      msg = 'Large file: shown read-only so the page stays responsive.';
      btnEditLarge.hidden = bigText.length > EDIT_MAX_CHARS;
    } else {
      btnEditLarge.hidden = true;
      if (editPaused) msg = 'Large file: press Format to update (Ctrl/Cmd + Enter).';
    }
    inputNoteText.textContent = msg;
    inputNote.hidden = !msg;
  }

  function inputMeta(text) {
    if (!text.length) return '';
    if (bigText !== null) return badges([fmtBytes(bigBytes), plural(bigInputView.index().lines, 'line', 'lines')]);
    return badges([fmtBytes(byteLen(text)), plural(T.countLines(text), 'line', 'lines')]);
  }

  // "Edit as text": move a large input into the text box (slow once, and slow to type in).
  btnEditLarge.addEventListener('click', function () {
    if (bigText === null) return;
    var text = bigText;
    showProgress('Loading the input into the text box\u2026', null, false);
    setTimeout(function () {   // let the message draw first
      bigText = null;
      bigBytes = null;
      inputView.hidden = true;
      bigInputView.clear();
      input.hidden = false;
      inGutter.hidden = false;
      gutterCount = -1;
      input.value = text;
      hideProgress();
      refreshInputGutter();
      syncInputNote();
      input.focus();
      input.setSelectionRange(0, 0);
      input.scrollTop = 0;
    }, 50);
  });

  // ---- Worker ----
  // Inputs over SYNC_CHARS are processed in a Web Worker made from json-tools.js itself (a
  // Blob URL, which also works when the page is opened from disk). Each job has an id; when
  // a new one starts while another is still running, the old one is stopped (the worker is
  // ended and a new one started), so a stale result never shows. Without workers, the same
  // code runs on the main thread in slices (createWorkerHandler's sliced mode).
  var jobs = T.createJobTracker();
  var worker = null, workerFailed = false, workerAnswered = false, workerVersion = null, workerUrl = null;
  var fallback = null;          // the handler on the main thread, when workers are not available
  var running = null;           // { id, version, text, key, phase, size, started }
  var shownKey = null;          // the job whose result is showing (version + options)
  var replies = {}, requestId = 0, idleWaiters = [];

  function workersOff() {
    try { return localStorage.getItem('json-formatter-worker') === 'off'; } catch (e) { return false; }
  }
  function startWorker() {
    if (worker || workerFailed) return worker;
    try {
      if (workersOff() || typeof Worker === 'undefined') throw new Error('off');
      if (!workerUrl) workerUrl = URL.createObjectURL(new Blob([T.workerSource()], { type: 'text/javascript' }));
      worker = new Worker(workerUrl);
      worker.onmessage = function (e) { workerAnswered = true; onWorkerMessage(e.data); };
      worker.onerror = function (e) { if (e && e.preventDefault) e.preventDefault(); onWorkerCrash(); };
    } catch (e) {
      workerFailed = true;
      worker = null;
    }
    return worker;
  }
  function post(msg) {
    var w = startWorker();
    if (w) { w.postMessage(msg); return; }
    if (!fallback) {
      fallback = T.createWorkerHandler(function (m) { setTimeout(function () { onWorkerMessage(m); }, 0); }, { sliced: true });
    }
    fallback(msg);
  }
  // Ends the worker (stopping whatever it is doing) or, without one, the job in slices.
  function stopWorker() {
    if (worker) { worker.terminate(); worker = null; workerVersion = null; }
    else if (fallback && running) fallback({ type: 'cancel', id: running.id });
    var pending = replies;
    replies = {};
    for (var k in pending) pending[k]({ type: 'error', cancelled: true });
  }
  // Questions about the result showing (search, paths, values), answered by the worker.
  function request(msg, done) {
    var id = 'q' + (++requestId);
    msg.id = id;
    replies[id] = done;
    post(msg);
  }

  function startJob(text, version) {
    var opts = jobOptions(), key = version + '|' + JSON.stringify(opts);
    if (running && running.key === key) return;            // already on its way
    if (!running && shownKey === key && lastResultAsync) return;   // already showing
    if (running) stopWorker();
    var id = jobs.start();
    running = { id: id, version: version, text: text, key: key, phase: 'parse', size: bigText !== null ? bigBytes : byteLen(text), started: Date.now() };
    post({ type: 'job', id: id, version: version, text: workerVersion === version ? undefined : text, opts: opts });
    workerVersion = version;
    output.closest('.pane-body').setAttribute('aria-busy', 'true');
    clearTimeout(progressTimer);
    progressTimer = setTimeout(function () {
      if (!running || running.id !== id) return;
      // A job that takes a while: the status bar says so, instead of describing the old result.
      setStatus('empty', 'Working', lastOutput ? 'The result below is out of date until this finishes.' : 'Working on the input\u2026');
      jobProgressTick();
    }, PROGRESS_DELAY);
  }

  function onWorkerMessage(m) {
    if (m.type === 'progress') {
      if (running && m.id === running.id) { running.phase = m.phase; if (!jobProgress.hidden) jobProgressTick(); }
      return;
    }
    if (m.type === 'need-text') {   // the worker restarted and lost the text: send it again
      if (running && m.id === running.id) {
        post({ type: 'job', id: running.id, version: running.version, text: running.text, opts: jobOptions() });
        workerVersion = running.version;
      }
      return;
    }
    if (m.type === 'result') {
      if (!running || !jobs.isCurrent(m.id) || m.id !== running.id) return;   // an older job: ignore
      var key = running.key;
      running = null;
      hideProgress();
      shownKey = key;
      showJobResult(m, true);
      var waiting = idleWaiters;
      idleWaiters = [];
      waiting.forEach(function (f) { f(); });
      return;
    }
    var done = replies[m.id];
    if (done) { delete replies[m.id]; done(m); }
  }

  // The worker stopped by itself: it could not start (some browsers or settings block
  // workers), or it ran out of memory.
  function onWorkerCrash() {
    var job = running;
    worker = null;
    workerVersion = null;
    var pending = replies;
    replies = {};
    for (var k in pending) pending[k]({ type: 'error', cancelled: true });
    if (!workerAnswered) {
      workerFailed = true;   // never worked here: use the main thread from now on
      if (job) { running = null; startJob(job.text, job.version); }
      return;
    }
    if (!job) return;
    running = null;
    idleWaiters = [];
    hideProgress();
    showJobResult({ status: 'failed', tooBig: true, deep: false, message: 'The browser stopped the worker', depth: null }, true);
  }

  // Runs f once the current job is done (right away when none is running).
  function whenIdle(f) {
    if (running) idleWaiters.push(f); else f();
  }

  // Stops the running job, if any, without showing anything.
  function cancelJob() {
    if (!running) return;
    stopWorker();
    jobs.cancel();
    running = null;
    idleWaiters = [];
    hideProgress();
  }

  // ---- Progress, with Cancel ----
  var jobProgress = $('jobProgress'), jobText = $('jobText'), jobTime = $('jobTime'), jobBar = $('jobBar'), btnCancelJob = $('btnCancelJob');
  var progressTimer = null, progressTicker = null, reading = null;
  var PHASES = { parse: 'Parsing', sort: 'Sorting keys of', format: 'Formatting', convert: 'Converting' };

  // fraction: 0..1, or null for "working" without a known amount. cancellable: show Cancel.
  // time: elapsed time, shown but not announced (it changes every half second).
  function showProgress(label, fraction, cancellable, time) {
    if (jobText.textContent !== label) jobText.textContent = label;
    jobTime.textContent = time || '';
    if (fraction === null || fraction === undefined) jobBar.removeAttribute('value');
    else jobBar.value = fraction;
    btnCancelJob.hidden = cancellable === false;
    jobProgress.hidden = false;
  }
  function jobProgressTick() {
    if (!running) return;
    var secs = Math.floor((Date.now() - running.started) / 1000);
    showProgress((PHASES[running.phase] || 'Working on') + ' ' + fmtBytes(running.size) + '\u2026', null, true, secs ? secs + ' s' : '');
    clearTimeout(progressTicker);
    progressTicker = setTimeout(jobProgressTick, 500);
  }
  function hideProgress() {
    clearTimeout(progressTimer);
    clearTimeout(progressTicker);
    var hadFocus = jobProgress.contains(document.activeElement);
    jobProgress.hidden = true;
    output.closest('.pane-body').removeAttribute('aria-busy');
    if (hadFocus) btnFormat.focus();
  }

  btnCancelJob.addEventListener('click', function () {
    if (reading) { reading.abort(); return; }
    if (!running) { hideProgress(); return; }
    cancelJob();
    shownKey = null;
    setStatus('empty', 'Stopped', 'Formatting was stopped. Press Format (Ctrl/Cmd + Enter) to start it again.');
    showEmpty('stopped', 'Stopped', 'The result is not up to date. Press Format to try again.');
    finishView('stopped');
    btnFormat.focus();
  });

  // ---- Running the input ----
  // Small inputs are processed right here; bigger ones in the worker (see above).
  function update(force) {
    var text = inputText();
    if (sharedText !== null && text !== sharedText) clearShareHash();
    refreshInputGutter();
    markErrorLine(null);
    inMeta.innerHTML = inputMeta(text);
    outTitle.textContent = outFormat === 'json' ? (mode === 'minify' ? 'Minified JSON' : 'Formatted JSON') : FORMATS[outFormat].label + ' output';

    if (!hasText(text)) {
      cancelJob();
      shownKey = null;
      setStatus('empty', 'Ready', 'Paste or type JSON to begin.');
      showEmpty('empty', 'Nothing to format yet', 'Paste JSON into the input, open a file, or load the sample.');
      finishView('empty');
      lastDataStatus = 'empty';
      if (schemaHook) schemaHook.dataChanged('empty');
      return;
    }
    if (text.length <= SYNC_CHARS) {
      cancelJob();
      shownKey = null;
      showJobResult(T.runJob(text, jobOptions()), false);
      return;
    }
    if (editPaused && force !== true && force !== 'options') return;
    editPaused = false;
    syncInputNote();
    startJob(text, textVersion);
  }

  // Shows a job's result (from runJob here, or a message from the worker).
  function showJobResult(r, async) {
    var view;
    if (r.status === 'failed') {
      view = 'failed';
      showFailure(r);
    } else if (r.status === 'invalid') {
      var err = r.error;
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
      // The tree is rebuilt only when the data could have changed (input text or Sort keys).
      // A result from the worker has no value here: the tree parses the input when needed.
      var source = textVersion + '|' + sortBox.checked;
      if (source !== treeSource) { treeSource = source; treeValue = r.value; treeLoad = null; treeDirty = true; }
      var stats = [r.kind, plural(r.stats.keys, 'key', 'keys') + ' in total', 'depth ' + r.stats.depth];
      if (r.status === 'unsupported') {
        view = 'unsupported';
        setStatus('valid', 'Valid', fixNotice ? esc(fixNotice) : 'Valid JSON', stats);
        showEmpty('info', 'Can\u2019t show this as ' + FORMATS[outFormat].label, r.message);
        btnShare.disabled = false;   // the JSON itself can still be shared
      } else {
        view = 'valid-' + mode;
        lastOutput = r.output;
        lastResultAsync = async;
        outCode.classList.add('hl');
        codeView.setText(r.output, r.index, r.restarts, T.scannerFor(outFormat, csvOpts), true);
        showResult();
        if (searchActive()) runSearch(true);   // the data changed: search it again
        var meta = [fmtBytes(r.outBytes)];
        if (mode === 'minify' && outFormat === 'json' && r.inBytes > 0) {
          var saved = Math.round((1 - r.outBytes / r.inBytes) * 100);
          // The input's size is on the input pane; here, the result and what was saved
          // (short enough to keep the header on one row).
          if (saved > 0) meta.push('\u2212' + saved + '%');
        }
        outMeta.innerHTML = badges(meta);
        btnCopy.disabled = false;
        btnCopyPath.disabled = btnCopyValue.disabled = outFormat !== 'json';
        btnUse.disabled = outFormat !== 'json';
        btnDownload.disabled = false;
        btnShare.disabled = false;
        setStatus('valid', 'Valid', fixNotice ? esc(fixNotice) : 'Valid JSON', stats);
        if (fixNotice && fixUndo !== null) {
          var undoWrap = document.createElement('span');
          undoWrap.className = 'status-actions';
          undoWrap.appendChild(statusButton('btnUndoFix', 'Undo fix', undoFix));
          statusEl.appendChild(undoWrap);
        }
      }
    }
    finishView(view);
    lastDataStatus = r.status;
    if (schemaHook) schemaHook.dataChanged(r.status);
  }

  // Fade in only when what is shown changes, not on every keystroke.
  function finishView(view) {
    if (view !== lastView) {
      reveal(statusEl);
      reveal(!outEmpty.hidden ? outEmpty : currentView() === 'tree' ? treeView : output);
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
    var before = inputText();
    if (before.length > SYNC_CHARS) {
      // Big inputs are repaired in the worker.
      showProgress('Fixing ' + fmtBytes(bigText !== null ? bigBytes : byteLen(before)) + '\u2026', null, false);
      request({ type: 'repair', text: before }, function (m) {
        hideProgress();
        if (m.type === 'repair' && inputText() === before) finishFix(before, m.result);
      });
      return;
    }
    finishFix(before, T.repairJson(before));
  }

  function finishFix(before, r) {
    if (!r.ok || !r.changed) {
      fixFailure = r.ok ? 'it is already valid' : r.error;
      update(true);
      whenIdle(function () {
        var go = $('btnGoError');
        if (go) go.focus();
      });
      return;
    }
    if (bigText !== null || isBigText(r.text)) {
      // The read-only view has no undo of its own: offer an "Undo fix" button.
      setInputText(r.text);
      fixUndo = before;
    } else {
      // Replace the text through the editing pipeline so Ctrl+Z / Cmd+Z can undo the fix.
      applyingFix = true;
      input.focus();
      input.setSelectionRange(0, before.length);
      var kept = false;
      try { kept = document.execCommand('insertText', false, r.text); } catch (e) {}
      if (!kept || input.value !== r.text) {
        setInputText(r.text);   // fallback: no browser undo, so offer an "Undo fix" button
        fixUndo = before;
      } else {
        fixUndo = null;
      }
      applyingFix = false;
    }
    fixNotice = r.summary;
    treeResetNext = true;
    fixFailure = null;
    clearTimeout(timer);
    update(true);
    if (bigText === null) {
      input.setSelectionRange(0, 0);
      input.scrollTop = 0;
    }
  }

  function undoFix() {
    if (fixUndo === null) return;
    setInputText(fixUndo);
    fixUndo = null;
    fixNotice = null;
    update(true);
    (bigText !== null ? inputView : input).focus();
  }

  function jumpTo(err) {
    if (bigText !== null) {
      inputView.focus();
      bigInputView.select(Math.min(err.pos, bigText.length), Math.min(err.pos + 1, bigText.length));
      return;
    }
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
    clearTimeout(timer);
    update(true);
  }

  btnFormat.addEventListener('click', function () { setMode('format'); });
  btnMinify.addEventListener('click', function () { setMode('minify'); });
  $('btnValidate').addEventListener('click', function () {
    clearTimeout(timer);
    update(true);
    whenIdle(function () {
      var b = $('btnGoError') || $('btnFix');
      if (b) b.focus();
    });
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
  sortBox.addEventListener('change', function () { update('options'); });

  var timer = null;
  input.addEventListener('input', function () {
    refreshInputGutter(); // immediately, so numbers keep up with fast typing and pastes
    inputDirty = true;
    textVersion++;
    if (!applyingFix) {
      // Any edit (including Ctrl+Z undoing a fix) clears the fix summary and failure note.
      fixNotice = null;
      fixFailure = null;
      fixUndo = null;
    }
    clearTimeout(timer);
    if (input.value.length > SYNC_CHARS) {
      // Large input: formatting waits for Format (Ctrl/Cmd + Enter) instead of every pause.
      if (!editPaused) { editPaused = true; syncInputNote(); }
      if (lastView === 'empty') {
        // Nothing was formatted yet: say how to get a result, not "nothing to format".
        setStatus('empty', 'Ready', 'Press Format (Ctrl/Cmd + Enter) to format this input.');
        showEmpty('empty', 'Not formatted yet', 'This input is large, so it is formatted when you press Format.');
      }
      return;
    }
    if (editPaused) { editPaused = false; syncInputNote(); }
    timer = setTimeout(update, 160);
  });
  // Pasting a big text: show it in the read-only view instead of loading the text box,
  // which would freeze the page for seconds.
  input.addEventListener('paste', function (e) {
    var data = e.clipboardData && e.clipboardData.getData('text/plain');
    if (!data || data.length < 20000) return;
    var v = input.value, next = v.slice(0, input.selectionStart) + data + v.slice(input.selectionEnd);
    if (!isBigText(next)) return;
    e.preventDefault();
    treeResetNext = true;
    inputDirty = true;
    loadedFileName = null;
    fixNotice = fixFailure = fixUndo = null;
    setInputText(next);
    update(true);
  });
  // Pasting into the read-only view replaces the input.
  inputView.addEventListener('paste', function (e) {
    var data = e.clipboardData && e.clipboardData.getData('text/plain');
    if (!data) return;
    e.preventDefault();
    treeResetNext = true;
    inputDirty = true;
    loadedFileName = null;
    fixNotice = fixFailure = fixUndo = null;
    setInputText(data);
    update(true);
  });
  input.addEventListener('scroll', syncInputGutter, { passive: true });
  function formatShortcut(e) {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'Enter') { e.preventDefault(); setMode('format'); }
  }
  input.addEventListener('keydown', formatShortcut);
  inputView.addEventListener('keydown', formatShortcut);
  // Ctrl/Cmd + Shift + Enter: Fix JSON (only when the input is invalid).
  document.addEventListener('keydown', function (e) {
    if (appMode === 'compare') return;   // Compare mode has its own inputs
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(timer);
      update(true);
      whenIdle(function () {
        if (statusEl.getAttribute('data-state') === 'invalid' && $('btnFix')) applyFix();
      });
    }
  });

  function resetFor(name, dirty) {
    treeResetNext = true;
    loadedFileName = name;
    inputDirty = dirty;
    fixNotice = fixFailure = fixUndo = null;
  }
  $('btnSample').addEventListener('click', function () { resetFor(null, false); setInputText(SAMPLE); setMode('format'); });
  $('btnClear').addEventListener('click', function () {
    resetFor(null, false);
    if (reading) reading.abort();
    setInputText('');
    update(true);
    input.focus();
  });

  btnUse.addEventListener('click', function () {
    if (!lastOutput) return;
    resetFor(null, true);
    setInputText(lastOutput);
    update(true);
  });

  // "Copied" shows as a message like the other copy actions (the button may be icon-only).
  btnCopy.addEventListener('click', function () {
    if (lastOutput) copyText(lastOutput, 'Copied');
  });

  // ---- Opening and dropping files ----
  // Files are read with the File API in the background, with their size shown first and a
  // Cancel button. Files too big for the browser get a message instead of a crash.
  function openFile(f) {
    if (!f) return;
    if (reading) reading.abort();
    cancelJob();
    var size = fmtBytes(f.size), name = f.name || 'file';
    if (f.size > MAX_FILE_BYTES) {
      shownKey = null;
      setStatus('invalid', 'Too big', esc(name) + ' is ' + size + ', more than the ' + fmtBytes(MAX_FILE_BYTES) + ' this page can open.');
      showEmpty('error', 'This file is too big', 'Browsers run out of memory with JSON files this big. Try a smaller file, or split it into parts.');
      finishView('too-big');
      return;
    }
    var reader = new FileReader();
    reading = reader;
    showProgress('Reading ' + name + ' (' + size + ')\u2026', 0, true);
    reader.onprogress = function (e) {
      if (reading !== reader || !e.lengthComputable) return;
      showProgress('Reading ' + name + ' (' + fmtBytes(e.loaded) + ' of ' + size + ')\u2026', e.total ? e.loaded / e.total : null, true);
    };
    reader.onload = function () {
      if (reading !== reader) return;
      reading = null;
      hideProgress();
      resetFor(name, true);
      setInputText(String(reader.result || ''), { bytes: f.size });
      setMode('format');
    };
    reader.onerror = function () {
      if (reading !== reader) return;
      reading = null;
      hideProgress();
      shownKey = null;
      var big = reader.error && /NotReadable|Range|memory/i.test(reader.error.name + ' ' + reader.error.message) && f.size > 64 * 1048576;
      setStatus('invalid', 'Error', big ? 'This file is too big for the browser to read.' : 'Couldn\u2019t read ' + esc(name) + '.');
      showEmpty('error', 'Can\u2019t open this file', big ? 'Try a smaller file, or split it into parts.' :
        'The browser couldn\u2019t read it. It may have been moved, or be in use by another program.');
      finishView('read-error');
    };
    reader.onabort = function () {
      if (reading !== reader) return;
      reading = null;
      hideProgress();
      showToast('Stopped reading ' + name);
    };
    reader.readAsText(f);
  }

  $('fileIn').addEventListener('change', function (e) {
    openFile(e.target.files && e.target.files[0]);
    e.target.value = '';
  });

  // Drop a file anywhere on the input pane.
  var inputPane = input.closest('.pane');
  function hasFiles(e) { return e.dataTransfer && [].indexOf.call(e.dataTransfer.types || [], 'Files') !== -1; }
  inputPane.addEventListener('dragover', function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    inputPane.classList.add('drop-target');
  });
  inputPane.addEventListener('dragleave', function (e) {
    if (!inputPane.contains(e.relatedTarget)) inputPane.classList.remove('drop-target');
  });
  inputPane.addEventListener('drop', function (e) {
    inputPane.classList.remove('drop-target');
    if (!hasFiles(e)) return;
    e.preventDefault();
    openFile(e.dataTransfer.files[0]);
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
  // The view actually shown: the tree only applies to JSON.
  function currentView() { return outFormat === 'json' ? outView : 'code'; }

  function showResult() {
    outEmpty.hidden = true;
    pathBar.hidden = outFormat !== 'json';
    // Keep the selected path while it still exists in the (possibly edited) data. (Not known
    // yet when the data is only in the worker; the path is kept until the tree is built.)
    if (treeValue !== undefined && T.valueAtPath(treeValue, selectedParts) === undefined) selectedParts = [];
    renderCrumbs();
    var view = currentView();
    output.hidden = view !== 'code';
    treeView.hidden = view !== 'tree';
    if (view === 'tree' && treeDirty) buildTree();
  }

  function setOutView(view, save) {
    outView = view;
    btnViewCode.classList.toggle('active', view === 'code');
    btnViewTree.classList.toggle('active', view === 'tree');
    btnViewCode.setAttribute('aria-pressed', String(view === 'code'));
    btnViewTree.setAttribute('aria-pressed', String(view === 'tree'));
    if (save) { try { localStorage.setItem(VIEW_KEY, view); } catch (e) {} }
    btnFilter.hidden = currentView() !== 'tree';
    if (lastOutput) {
      showResult();
      reveal(currentView() === 'tree' ? treeView : output);
      if (currentView() === 'code' && codeMarksDirty) renderCodeMarks();
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
    if (treeValue === undefined) {
      // The data was processed in the worker: parse the input here, in slices, first.
      treeDirty = true;
      loadTreeValue(function () { if (currentView() === 'tree' && treeDirty) buildTree(opts); });
      return;
    }
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

  // Gets the parsed data for the tree when the worker did the formatting: the input is
  // parsed again here with createParser, a few milliseconds at a time, so the page stays
  // responsive (receiving the worker's copy would block the page while it is copied in).
  var treeLoad = null;
  function loadTreeValue(done) {
    if (treeLoad && treeLoad.source === treeSource) { treeLoad.waiting.push(done); return; }
    var mine = treeLoad = { source: treeSource, waiting: [done] };
    var p = T.createParser(inputText(), { sort: sortBox.checked });
    setBusy(1);
    setTreeNote('Preparing the tree\u2026');
    (function step() {
      if (treeLoad !== mine) { setBusy(-1); return; }   // the data changed in the meantime
      if (!p.step(12)) {
        setTreeNote('Preparing the tree\u2026 ' + Math.floor(p.progress() * 100) + '%');
        setTimeout(step, 0);
        return;
      }
      treeLoad = null;
      setBusy(-1);
      setTreeNote('');
      if (p.error) { setTreeNote('Couldn\u2019t build the tree for this data.'); return; }
      treeValue = p.value;
      mine.waiting.forEach(function (f) { f(); });
    })();
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

  // Code view: clicking a value shows its path; the breadcrumb selects a value. For results
  // from the worker, it finds the path (it has the text and the data).
  output.addEventListener('click', function () {
    if (!lastOutput || outFormat !== 'json') return;
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    var offset = codeView.offsetOf(sel.focusNode, sel.focusOffset);
    if (offset === null) return;
    if (lastResultAsync) {
      var shown = lastOutput;
      request({ type: 'pathAt', offset: offset }, function (m) {
        if (m.type === 'pathAt' && m.path && lastOutput === shown) selectPath(m.path);
      });
      return;
    }
    try { selectPath(T.pathAtOffset(lastOutput, offset)); } catch (e) {}
  });
  // Selects a value's text in the Code view and scrolls it into view.
  function selectInCode(parts) {
    if (lastResultAsync) {
      var shown = lastOutput;
      request({ type: 'rangeOf', parts: parts }, function (m) {
        if (m.type === 'rangeOf' && m.range && lastOutput === shown) codeView.select(m.range.start, m.range.end);
      });
      return;
    }
    var range = null;
    try { range = T.rangeOfPath(lastOutput, parts); } catch (e) {}
    if (range) codeView.select(range.start, range.end);
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
    var indent = indentSel.value === 'tab' ? '\t' : +indentSel.value;
    if (treeValue === undefined && lastResultAsync) {
      // The data is in the worker: it makes the text.
      request({ type: 'copyValue', parts: parts, indent: indent }, function (m) {
        if (m.type === 'copyValue' && m.text !== null) copyText(m.text, 'Copied value of ' + (pathText(parts) || 'the root'));
        else if (m.type === 'error' && !m.cancelled) showToast('Couldn\u2019t copy this value');
      });
      return;
    }
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
  var codeMarksDirty = false;

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
    // Keys / Values only mean something for JSON; other formats search their text.
    var json = outFormat === 'json';
    for (var k = 0; k < scopes.length; k++) {
      scopes[k].disabled = !json;
      scopes[k].title = json ? '' : 'Only for JSON output; ' + FORMATS[outFormat].label + ' is searched as text';
    }
    searchInput.setAttribute('aria-label', json ? 'Search keys and values' : 'Search the ' + FORMATS[outFormat].label + ' output');
    searchInput.placeholder = json ? 'Search keys and values' : 'Search the ' + FORMATS[outFormat].label;
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
      setHits([], false, null, query && searchOpen && !lastOutput && hasText(inputText()) && lastView !== 'stopped' ? 'Fix the input to search it' : '');
      if (then) then();
      return;
    }
    var prev = keepCurrent && current >= 0 ? hits[current] : null;
    var finish = function (matches, truncated, error) {
      searching = false;
      var keep = -1;
      for (var i = 0; prev && i < matches.length; i++) {
        var m = matches[i];
        if (!m.path ? m.start === prev.start : m.where === prev.where && m.start === prev.start && m.path.length === prev.path.length &&
            T.formatPath(m.path, 'js') === T.formatPath(prev.path, 'js')) { keep = i; break; }
      }
      setHits(matches, truncated, error, null, keep);
      announce(countMessage());
      if (current >= 0) showCurrent();
      if (then) then();
    };
    if (lastResultAsync) {
      // A big result: the worker searches its copy (the data for JSON, else the text) and
      // also finds where JSON matches are in the text.
      searching = true;
      var shown = lastOutput;
      request({ type: 'search', query: query, opts: searchOpts }, function (m) {
        if (gen !== searchGen || lastOutput !== shown) return;
        if (m.type !== 'search') { searching = false; if (!m.cancelled) setHits([], false, null, ''); return; }
        if (m.ranges) for (var i = 0; i < m.matches.length; i++) m.matches[i].range = m.ranges[i];
        finish(m.matches, m.truncated, m.error);
      });
      return;
    }
    if (outFormat !== 'json') {
      // Other formats: search the text that is showing.
      var r = T.searchText(lastOutput, query, searchOpts);
      finish(r.matches, r.truncated, r.error);
      return;
    }
    var s = T.createSearch(treeValue, query, searchOpts);
    searching = true;
    (function step() {
      if (gen !== searchGen) return;
      var t0 = performance.now();
      while (!s.done && performance.now() - t0 < 12) s.step(2000);
      if (!s.done) { setTimeout(step, 0); return; }
      finish(s.matches, s.truncated, s.error);
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
    if (list.length && list[0].path) {
      matchIndex = new Map();
      for (var i = 0; i < list.length; i++) {
        var p = T.formatPath(list[i].path, 'js'), e = matchIndex.get(p);
        if (!e) matchIndex.set(p, e = { key: [], value: [] });
        e[list[i].where].push({ start: list[i].start, end: list[i].end, i: i });
      }
    }
    if (!treeDirty) refreshTreeMatches();
    codeMarksDirty = true;
    if (currentView() === 'code' && lastOutput) renderCodeMarks();
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
    if (!m.path) { markCurrentCode(true); return; }   // a text match (YAML, CSV, TypeScript)
    selectPath(m.path);
    if (currentView() === 'tree') {
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
  // The Code view draws marks on the rows it shows; it gets every match as a text range.
  // JSON matches come with their range from the worker, or are located in the text here.
  function renderCodeMarks() {
    codeMarksDirty = false;
    if (!lastOutput) return;
    if (!hits.length) { codeView.setMarks(null, -1); return; }
    var ranges = !hits[0].path ? hits : hits[0].range !== undefined ? hits.map(function (h) { return h.range; }) : T.locateMatches(lastOutput, hits);
    var list = [];
    for (var i = 0; i < ranges.length; i++) if (ranges[i]) list.push({ start: ranges[i].start, end: ranges[i].end, i: i });
    codeView.setMarks(list, current);
  }
  // A text match can be split across several marks (one per highlighted token).
  function markCurrentCode(scroll) {
    if (codeMarksDirty) renderCodeMarks();
    codeView.setCurrent(current, scroll);
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
    var want = searchFilter && searchActive() && !hitsError && outFormat === 'json';
    if (want) {
      if (!treeFilter && rootRow()) savedTreeState = captureTreeState();
      treeFilter = buildFilterSets(hits);
      if (currentView() === 'tree') buildTree({}); else treeDirty = true;
    } else if (treeFilter) {
      treeFilter = null;
      var state = savedTreeState;
      savedTreeState = null;
      if (currentView() === 'tree' && lastOutput) buildTree({ restore: state });
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
    if (appMode === 'compare') return;
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

  // ---- More menu (WAI-ARIA menu button) ----
  var btnMore = $('btnMore'), moreMenu = $('moreMenu');
  var btnCopyPath = $('btnCopyPath'), btnCopyValue = $('btnCopyValue');
  function menuItems() {
    return [].slice.call(moreMenu.querySelectorAll('[role="menuitem"]')).filter(function (b) { return !b.disabled && !b.hidden; });
  }
  function openMenu(focusLast) {
    moreMenu.hidden = false;
    btnMore.setAttribute('aria-expanded', 'true');
    var items = menuItems();
    (items.length ? items[focusLast ? items.length - 1 : 0] : moreMenu).focus();
  }
  function closeMenu(returnFocus) {
    if (moreMenu.hidden) return;
    moreMenu.hidden = true;
    btnMore.setAttribute('aria-expanded', 'false');
    if (returnFocus) btnMore.focus();
  }
  btnMore.addEventListener('click', function () {
    if (moreMenu.hidden) openMenu(false); else closeMenu(true);
  });
  btnMore.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openMenu(e.key === 'ArrowUp'); }
  });
  moreMenu.addEventListener('keydown', function (e) {
    var items = menuItems(), i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length) items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      if (items.length) items[e.key === 'Home' ? 0 : items.length - 1].focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu(true);
    } else if (e.key === 'Tab') {
      closeMenu(false);
    }
  });
  // Choosing an item closes the menu and returns focus to the More button first, so actions
  // that move focus themselves (the share panel) still can.
  moreMenu.addEventListener('click', function (e) {
    if (e.target.closest('[role="menuitem"]')) closeMenu(true);
  }, true);
  document.addEventListener('pointerdown', function (e) {
    if (!moreMenu.hidden && !moreMenu.contains(e.target) && !btnMore.contains(e.target)) closeMenu(false);
  });
  moreMenu.addEventListener('focusout', function (e) {
    if (!moreMenu.hidden && e.relatedTarget && !moreMenu.contains(e.relatedTarget) && e.relatedTarget !== btnMore) closeMenu(false);
  });

  // ---- Share link ----
  // The input text (and the current settings) go into the link's hash, compressed. Browsers
  // never send the hash to a server, so nothing is uploaded. In Compare mode the link holds
  // both documents (compare.js gives them and applies opened links).
  var SHARE_NOTE_KEY = 'json-formatter-share-note-seen';
  var SITE_URL = 'https://xitas.github.io/json-prettify/';
  var PRIVACY_NOTE = 'Anyone with this link can see the JSON. It\u2019s stored in the link, not on a server.';
  var btnShare = $('btnShare'), sharePanel = $('sharePanel'), shareMsg = $('shareMsg'), shareActions = $('shareActions');
  var sharedText = null;   // the input as opened from a share link, while its hash is in the address bar
  var inputDirty = false;  // the input holds the user's own JSON (typed, pasted or opened)
  var SHARE_HASH = /^#[jude]\d+=/;

  // Opened from disk, a link to the local file would not work for anyone else.
  function shareBase() {
    return /^https?:$/.test(location.protocol) ? location.origin + location.pathname : SITE_URL;
  }
  function clearShareHash() {
    sharedText = null;
    if (SHARE_HASH.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
  }

  // The share message panel of the mode showing (and where focus goes back to).
  function sharePlace() {
    return appMode === 'compare'
      ? { box: $('cmpSharePanel'), msg: $('cmpShareMsg'), actions: $('cmpShareActions'), back: $('btnCmpShare') }
      : { box: sharePanel, msg: shareMsg, actions: shareActions, back: btnMore };
  }
  // Messages and choices about sharing, under the output header. Text only (no HTML).
  function showSharePanel(paragraphs, buttons, focusFirst) {
    var p = sharePlace();
    p.msg.textContent = '';
    for (var i = 0; i < paragraphs.length; i++) p.msg.appendChild(el('p', null, paragraphs[i]));
    p.actions.textContent = '';
    for (var k = 0; k < buttons.length; k++) {
      var b = p.actions.appendChild(el('button', 'btn-xs' + (buttons[k].solid ? ' btn-solid' : ''), buttons[k].label));
      b.type = 'button';
      b.addEventListener('click', buttons[k].onClick);
    }
    p.box.hidden = false;
    if (focusFirst && p.actions.firstElementChild) p.actions.firstElementChild.focus();
  }
  function hideSharePanel() {
    var p = sharePlace(), hadFocus = p.box.contains(document.activeElement);
    p.box.hidden = true;
    if (hadFocus) p.back.focus();
  }
  var dismiss = { label: 'Got it', onClick: function () { hideSharePanel(); } };

  function seenPrivacyNote() {
    try { return localStorage.getItem(SHARE_NOTE_KEY) === '1'; } catch (e) { return false; }
  }

  function shareLink() {
    var compare = appMode === 'compare' && cmp;
    if (!compare && !lastOutput) return;
    var texts = compare ? cmp.texts() : null, text = compare ? null : inputText();
    var size0 = compare ? texts.original.length + texts.changed.length : text.length;
    var button = compare ? $('btnCmpShare') : btnShare;
    var instead = compare
      ? [dismiss]
      : [{ label: 'Download instead', solid: true, onClick: function () { hideSharePanel(); downloadOutput(); } }, dismiss];
    var insteadText = compare ? 'Send the files instead, or copy the changes as a JSON Patch.' : 'Use Download and send the file instead.';
    if (size0 > 20 * T.SHARE_MAX_LENGTH) {
      // Far too big for a link even compressed: say so without compressing it first.
      showSharePanel(['This JSON is too big to share by link. ' + insteadText], instead);
      return;
    }
    button.disabled = true;
    var made = compare ? T.encodeCompareShare(texts.original, texts.changed, cmp.settings())
      : T.encodeShare(text, { indent: indentSel.value, sortKeys: sortBox.checked, mode: mode, view: outView });
    made.then(function (hash) {
      button.disabled = compare ? false : !lastOutput;
      var link = shareBase() + '#' + hash, size = T.shareLinkCheck(link.length);
      var chars = T.groupDigits(size.length) + ' characters';
      if (size.tooBig) {
        showSharePanel(['This JSON is too big to share by link (' + chars + '; the limit is ' + T.groupDigits(T.SHARE_MAX_LENGTH) + '). ' + insteadText], instead);
        return;
      }
      var notes = [];
      if (!seenPrivacyNote()) {
        notes.push(PRIVACY_NOTE);
        try { localStorage.setItem(SHARE_NOTE_KEY, '1'); } catch (e) {}
      }
      if (size.warn) {
        notes.push('This link is ' + chars + ' long. Some chat apps and email clients cut long links off, so check that it ' +
          'arrives complete' + (compare ? '.' : ', or use Download instead.'));
      }
      var after = function () { if (notes.length) showSharePanel(notes, [dismiss]); else sharePlace().box.hidden = true; };
      // On phones, the system share sheet; elsewhere (or if it fails), copy the link.
      var phone = window.matchMedia && matchMedia('(pointer: coarse)').matches;
      if (phone && navigator.share) {
        navigator.share({ title: compare ? 'JSON comparison' : 'JSON', url: link }).then(function () { showToast('Link shared (' + chars + ')'); after(); }, function (e) {
          if (e && e.name === 'AbortError') return;
          copyText(link, 'Link copied (' + chars + ')');
          after();
        });
      } else {
        copyText(link, 'Link copied (' + chars + ')');
        after();
      }
    }, function () {
      button.disabled = compare ? false : !lastOutput;
      showToast('Couldn\u2019t make a link in this browser');
    });
  }
  btnShare.addEventListener('click', shareLink);

  // Opening a link with shared JSON. Shared content is untrusted: it only ever goes into the
  // input as text and through the same escaping as typed JSON; settings are whitelisted.
  function applyShared(r) {
    var s = r.settings;
    if (r.compare) {
      setAppMode('compare', true);
      if (!cmp) { pendingCompareLink = r; return; }   // compare.js has not started yet
      cmp.apply(r);
      if (!r.restore) showToast('Opened shared comparison');
      return;
    }
    setAppMode('format', true);
    if (s.indent) indentSel.value = s.indent;
    if (typeof s.sortKeys === 'boolean') sortBox.checked = s.sortKeys;
    if (s.view) setOutView(s.view, false);
    resetFor(null, false);
    setInputText(r.text);
    sharedText = r.text;
    setMode(s.mode || 'format');
    showToast('Opened shared JSON');
  }
  function openShareHash() {
    var hash = location.hash;
    if (!SHARE_HASH.test(hash)) return;
    T.decodeShare(hash).then(function (r) {
      if (!r || hash !== location.hash) return;
      if (!r.ok) {
        var why = r.reason === 'version' ? 'This link was made by a newer version of JSON Prettify. Reload the page, or ask for a new link.' :
          r.reason === 'unsupported' ? 'This browser can\u2019t open compressed links. Try a current version of Chrome, Edge, Firefox or Safari.' :
          'This link seems to be incomplete, so it can\u2019t be opened. It may have been cut off when it was sent. Ask for the full link, or for the file.';
        if (/^#[de]/.test(hash)) setAppMode('compare', false);
        showSharePanel([why], [dismiss]);
        return;
      }
      var dirty = r.compare ? cmp && cmp.dirty(r) : inputDirty && inputText() !== r.text;
      if (dirty) {
        if (r.compare) setAppMode('compare', false); else setAppMode('format', false);
        showSharePanel([r.compare ? 'This link has two shared documents in it. Opening it replaces both inputs.' :
          'This link has shared JSON in it. Opening it replaces the JSON in the input.'], [
          { label: r.compare ? 'Open shared comparison' : 'Open shared JSON', solid: true, onClick: function () { hideSharePanel(); applyShared(r); } },
          { label: 'Keep my JSON', onClick: function () { hideSharePanel(); clearShareHash(); } }
        ], true);
        return;
      }
      sharePlace().box.hidden = true;
      applyShared(r);
    });
  }
  window.addEventListener('hashchange', openShareHash);

  // ---- Format / Compare ----
  // Two modes, each with its own card. The choice is remembered.
  var APP_MODE_KEY = 'json-formatter-app-mode';
  var appMode = 'format', cmp = null, pendingCompareLink = null, schemaHook = null, lastDataStatus = 'empty';
  var btnModeFormat = $('btnModeFormat'), btnModeCompare = $('btnModeCompare');
  function setAppMode(m, save) {
    appMode = m === 'compare' ? 'compare' : 'format';
    $('formatCard').hidden = appMode !== 'format';
    $('compareCard').hidden = appMode !== 'compare';
    btnModeFormat.classList.toggle('active', appMode === 'format');
    btnModeCompare.classList.toggle('active', appMode === 'compare');
    btnModeFormat.setAttribute('aria-pressed', String(appMode === 'format'));
    btnModeCompare.setAttribute('aria-pressed', String(appMode === 'compare'));
    if (save) { try { localStorage.setItem(APP_MODE_KEY, appMode); } catch (e) {} }
    if (appMode === 'compare' && cmp) cmp.shown();
  }
  btnModeFormat.addEventListener('click', function () { setAppMode('format', true); });
  btnModeCompare.addEventListener('click', function () { setAppMode('compare', true); });

  // What compare.js uses from here: the worker, copying and messages, the path format, the
  // Format input, the size limits and sharing.
  window.JsonPrettify = {
    request: function (msg, done) { request(msg, done); },
    stopWorker: function () { stopWorker(); },
    copyText: copyText,
    showToast: showToast,
    announce: announce,
    pathFormat: function () { return pathFormatSel.value; },
    setPathFormat: function (v) { pathFormatSel.value = v; pathFormatSel.dispatchEvent(new Event('change')); },
    formatInput: function () { return inputText(); },
    sizes: { SYNC_CHARS: SYNC_CHARS, VIEW_ONLY_CHARS: VIEW_ONLY_CHARS, VIEW_ONLY_LINES: VIEW_ONLY_LINES, EDIT_MAX_CHARS: EDIT_MAX_CHARS, MAX_FILE_BYTES: MAX_FILE_BYTES },
    share: shareLink,
    clearShareHash: clearShareHash,
    mode: function () { return appMode; },
    // compare.js registers { shown(), texts(), settings(), apply(link), dirty(link) }.
    // ---- for schema.js ----
    // The current input text and its version (goes up with every change).
    inputText: function () { return inputText(); },
    inputVersion: function () { return textVersion; },
    // Shows a value: selects it in the Tree or Code view (JSON output) and marks its line
    // in the input's gutter.
    showValue: function (parts, line) {
      if (outFormat === 'json' && lastOutput) jumpToPath(parts);
      if (line) {
        markErrorLine(line);
        if (bigText !== null) bigInputView.revealLine(line);
        else input.scrollTop = Math.max(0, (line - 4) * 24);
      }
    },
    setSchemaBadge: function (badge) { schemaBadge = badge; placeSchemaBadge(); },
    // Ends the worker (a check ran too long); a format job that was running starts again.
    restartWorker: function () {
      var job = running;
      stopWorker();
      if (job) { running = null; startJob(job.text, job.version); }
    },
    onPathFormat: function (f) { pathFormatSel.addEventListener('change', f); },
    registerSchema: function (hooks) { schemaHook = hooks; hooks.dataChanged(lastDataStatus); },
    registerCompare: function (hooks) {
      cmp = hooks;
      if (pendingCompareLink) {
        var r = pendingCompareLink;
        pendingCompareLink = null;
        if (r.restore) { cmp.apply(r); if (appMode === 'compare') cmp.shown(); }   // kept across an update's reload
        else applyShared(r);
      }
      else if (appMode === 'compare') cmp.shown();
    }
  };
  // ---- Output format choice ----
  var csvBar = $('csvBar'), csvDelimiter = $('csvDelimiter'), csvProtect = $('csvProtect');
  csvDelimiter.value = csvOpts.delimiter === '\t' ? 'tab' : csvOpts.delimiter;
  csvProtect.checked = csvOpts.protect;
  function saveCsvOptions() {
    csvOpts.delimiter = csvDelimiter.value === 'tab' ? '\t' : csvDelimiter.value;
    csvOpts.protect = csvProtect.checked;
    try { localStorage.setItem(CSV_KEY, JSON.stringify(csvOpts)); } catch (e) {}
    update('options');
  }
  csvDelimiter.addEventListener('change', saveCsvOptions);
  csvProtect.addEventListener('change', saveCsvOptions);
  var tsBar = $('tsBar'), tsStyle = $('tsStyle'), tsRoot = $('tsRoot'), tsTimer = 0;
  tsStyle.value = tsOpts.style;
  tsRoot.value = tsOpts.rootName;
  function saveTsOptions() {
    clearTimeout(tsTimer);
    tsOpts.style = tsStyle.value === 'type' ? 'type' : 'interface';
    tsOpts.rootName = tsRoot.value;
    try { localStorage.setItem(TS_KEY, JSON.stringify(tsOpts)); } catch (e) {}
    update('options');
  }
  tsStyle.addEventListener('change', saveTsOptions);
  tsRoot.addEventListener('input', function () { clearTimeout(tsTimer); tsTimer = setTimeout(saveTsOptions, 200); });
  tsRoot.addEventListener('change', saveTsOptions);
  function syncFormatBars() { csvBar.hidden = outFormat !== 'csv'; tsBar.hidden = outFormat !== 'ts'; }
  syncFormatBars();

  outFormatSel.addEventListener('change', function () {
    outFormat = FORMATS[outFormatSel.value] ? outFormatSel.value : 'json';
    try { localStorage.setItem(FORMAT_KEY, outFormat); } catch (e) {}
    syncSearchOptions();
    syncFormatBars();
    btnFilter.hidden = currentView() !== 'tree';
    update('options');
  });

  // ---- Download ----
  // Saves the output as a .json file made in the browser (a Blob), so it works offline.
  var btnDownload = $('btnDownload');
  var loadedFileName = null;   // name of the file opened with "Open file", if any

  function downloadOutput() {
    if (!lastOutput) {
      showToast('Nothing to download yet: the input needs to be valid JSON');
      return;
    }
    var name = T.downloadName(loadedFileName, mode === 'minify', outFormat);
    // CSV starts with a UTF-8 byte order mark so Excel shows accents and emoji correctly.
    // (As separate parts, so a big output is not copied into a new string first.)
    var parts = FORMATS[outFormat].bom ? ['\ufeff', lastOutput] : [lastOutput];
    var url = URL.createObjectURL(new Blob(parts, { type: FORMATS[outFormat].mime }));
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
    if (appMode === 'compare') return;
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      clearTimeout(timer);
      update(true);
      whenIdle(downloadOutput);
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

  // Each theme's page background (--bg), as written in index.html's theme-color tags.
  var themeBars = document.querySelectorAll('meta[name="theme-color"]'), barColors = {};
  [].forEach.call(themeBars, function (m) {
    barColors[/dark/.test(m.getAttribute('media') || '') ? 'dark' : 'light'] = m.getAttribute('content');
  });

  function applyTheme(theme, animate) {
    if (animate && !(reduceMotion && reduceMotion.matches)) {
      root.classList.add('theme-switching');
      clearTimeout(fadeTimer);
      fadeTimer = setTimeout(function () { root.classList.remove('theme-switching'); }, 300);
    }
    root.setAttribute('data-theme', theme);
    if (colorMeta) colorMeta.setAttribute('content', theme);
    // The browser bar (and the installed app's title bar) follows the theme shown: both
    // theme-color tags get this theme's color (read from the tags, not from the styles,
    // which would make the browser work out the styles early while the page loads).
    var color = barColors[theme];
    for (var i = 0; i < themeBars.length && color; i++) themeBars[i].setAttribute('content', color);
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

  // ---- Install the app (Progressive Web App) ----
  // "Install app" in the More menu, where the browser offers installing (beforeinstallprompt);
  // on iPhone and iPad, which have no such prompt, a tip. Hidden once installed.
  var btnInstall = $('btnInstall'), installSep = $('installSep'), installPrompt = null;
  var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  function installed() {
    return (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  }
  function syncInstall() {
    var show = !installed() && (installPrompt !== null || isIOS);
    btnInstall.hidden = installSep.hidden = !show;
  }
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();   // our own menu item instead of the browser's banner
    installPrompt = e;
    syncInstall();
  });
  window.addEventListener('appinstalled', function () {
    installPrompt = null;
    syncInstall();
    showToast('JSON Prettify is installed');
  });
  btnInstall.addEventListener('click', function () {
    if (installPrompt) {
      var prompt = installPrompt;
      installPrompt = null;
      prompt.prompt();
      prompt.userChoice.then(syncInstall, syncInstall);
      syncInstall();
      return;
    }
    if (isIOS) showSharePanel(['To install JSON Prettify, tap Share, then Add to Home Screen.'], [dismiss]);
  });
  syncInstall();

  // Opening a .json file with the installed app (desktop Chrome and Edge: file_handlers in
  // the manifest): the file arrives through launchQueue and opens like "Open file".
  if (window.launchQueue && typeof window.launchQueue.setConsumer === 'function') {
    window.launchQueue.setConsumer(function (params) {
      if (!params || !params.files || !params.files.length) return;
      params.files[0].getFile().then(function (f) {
        setAppMode('format', true);
        openFile(f);
      }, function () { showToast('Couldn\u2019t open that file'); });
    });
  }

  // ---- Offline use (service worker) ----
  // Only over https or on this computer (localhost); opened from disk (file://) there is no
  // service worker, quietly. sw.js keeps the app's files, so it works offline. A new
  // version waits until the person chooses to reload: nothing reloads by itself.
  var updateBar = $('updateBar'), waitingWorker = null, reloading = false;
  var RESTORE_KEY = 'json-prettify-restore';
  var canUseSw = 'serviceWorker' in navigator && (location.protocol === 'https:' || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname));
  function showUpdate(worker) {
    waitingWorker = worker;
    updateBar.hidden = false;
  }
  if (canUseSw) {
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      var offer = function (w) { if (w && navigator.serviceWorker.controller) showUpdate(w); };
      offer(reg.waiting);
      reg.addEventListener('updatefound', function () {
        var w = reg.installing;
        if (w) w.addEventListener('statechange', function () { if (w.state === 'installed') offer(w); });
      });
      // Look for a new version now and then, and when the page comes back into view.
      var check = function () { reg.update().catch(function () {}); };
      setInterval(check, 30 * 60 * 1000);
      document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') check(); });
    }).catch(function () {});
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (reloading) location.reload();
    });
  }
  // Reload: what is typed in is kept for this one reload (in this tab only).
  $('btnUpdateReload').addEventListener('click', function () {
    if (!waitingWorker) { location.reload(); return; }
    try {
      var keep = { mode: appMode, input: inputText().length <= 2000000 ? inputText() : null };
      if (cmp) { var t = cmp.texts(); if (t.original.length + t.changed.length <= 2000000) keep.compare = { original: t.original, changed: t.changed, settings: cmp.settings() }; }
      sessionStorage.setItem(RESTORE_KEY, JSON.stringify(keep));
    } catch (e) {}
    reloading = true;
    waitingWorker.postMessage({ type: 'skip-waiting' });
  });
  $('btnUpdateLater').addEventListener('click', function () {
    updateBar.hidden = true;
    btnFormat.focus();
  });
  function restoreAfterUpdate() {
    var kept = null;
    try { kept = JSON.parse(sessionStorage.getItem(RESTORE_KEY) || 'null'); sessionStorage.removeItem(RESTORE_KEY); } catch (e) {}
    if (!kept || typeof kept !== 'object') return false;
    if (typeof kept.input === 'string') setInputText(kept.input);
    if (kept.compare && typeof kept.compare.original === 'string' && typeof kept.compare.changed === 'string') pendingCompareLink = { ok: true, compare: true, original: kept.compare.original, changed: kept.compare.changed, settings: kept.compare.settings || {}, restore: true };
    return kept.mode === 'compare' ? 'compare' : 'format';
  }

  var restoredMode = restoreAfterUpdate();
  if (restoredMode === false) setInputText(SAMPLE);
  update();
  // (Compare texts kept across an update come back through compare.js when it starts.)
  try { setAppMode(restoredMode || (localStorage.getItem(APP_MODE_KEY) === 'compare' ? 'compare' : 'format'), false); } catch (e) { setAppMode('format', false); }
  openShareHash();
})();
