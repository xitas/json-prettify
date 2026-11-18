/*
 * The Schema panel in Format mode: a JSON Schema input, the check of the JSON against it
 * (always in the worker, with a time limit, because a pattern in a schema can be very
 * slow), the list of problems, and "Generate schema from this JSON".
 * The validator and the generator are in json-tools.js; app.js shows the result in the
 * status bar and jumps to values.
 */
(function () {
  'use strict';

  var T = window.JsonTools, App = window.JsonPrettify;
  var $ = function (id) { return document.getElementById(id); };
  var SIZES = App.sizes, GROUPS_STEP = 20, PROGRESS_DELAY = 300;
  var KEY_OPEN = 'json-formatter-schema-open', KEY_FORMATS = 'json-formatter-schema-formats';
  var KEY_REMEMBER = 'json-formatter-schema-remember', KEY_TEXT = 'json-formatter-schema-text', REMEMBER_MAX = 2000000;
  var load = function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } };
  var store = function (k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); return true; } catch (e) { return false; } };

  var toggle = $('btnSchemaToggle'), body = $('schemaBody'), summary = $('schemaSummary'), named = $('schemaNamed');
  var formatsBox = $('schemaFormats'), rememberBox = $('schemaRemember'), list = $('schemaList'), more = $('btnSchemaMore');
  var countEl = $('schemaCount'), empty = $('schemaEmpty'), emptyTitle = $('schemaEmptyTitle'), emptyText = $('schemaEmptyText');
  var progress = $('schemaProgress'), progressText = $('schemaProgressText'), bar = $('schemaBar'), btnCancel = $('btnSchemaCancel');

  // ---- Progress (reading a schema file, long checks) ----
  var onCancel = null;
  function showProgress(label, fraction, cancel) {
    progressText.textContent = label;
    if (fraction === null || fraction === undefined) bar.removeAttribute('value'); else bar.value = fraction;
    onCancel = cancel || null;
    btnCancel.hidden = !cancel;
    progress.hidden = false;
  }
  function hideProgress() {
    var hadFocus = progress.contains(document.activeElement);
    progress.hidden = true;
    onCancel = null;
    if (hadFocus) toggle.focus();
  }
  btnCancel.addEventListener('click', function () { if (onCancel) onCancel(); });

  var doc = window.DocInput.create('schema', '', 'Schema', { progress: { show: showProgress, hide: hideProgress } });

  // ---- Options ----
  formatsBox.checked = load(KEY_FORMATS) === '1';
  rememberBox.checked = load(KEY_REMEMBER) === '1';
  if (rememberBox.checked && load(KEY_TEXT)) doc.setText(load(KEY_TEXT));
  formatsBox.addEventListener('change', function () { store(KEY_FORMATS, formatsBox.checked ? '1' : null); run(); });
  rememberBox.addEventListener('change', function () {
    store(KEY_REMEMBER, rememberBox.checked ? '1' : null);
    if (rememberBox.checked) saveText(); else store(KEY_TEXT, null);
    App.showToast(rememberBox.checked ? 'The schema will be kept in this browser' : 'The schema is no longer kept');
  });
  function saveText() {
    if (!rememberBox.checked) return;
    var t = doc.text();
    if (t.length > REMEMBER_MAX) { store(KEY_TEXT, null); App.showToast('This schema is too big to remember'); return; }
    if (!store(KEY_TEXT, t || null)) App.showToast('The browser didn\u2019t let this page keep the schema');
  }
  var saveTimer = null;
  doc.onChange = function () {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveText, 400);
    schedule(300);
  };
  $('btnSchemaClear').addEventListener('click', function () {
    doc.setText('');
    saveText();
    run();
    doc.focus();
  });

  // ---- Open and closed: the check only runs while the panel is open ----
  function isOpen() { return toggle.getAttribute('aria-expanded') === 'true'; }
  function setOpen(open, save) {
    toggle.setAttribute('aria-expanded', String(open));
    body.hidden = !open;
    if (save) store(KEY_OPEN, open ? '1' : null);
    run();
  }
  toggle.addEventListener('click', function () { setOpen(!isOpen(), true); });

  // ---- Running the check ----
  var seq = 0, timer = null, limitTimer = null, slowTimer = null, pending = null, has = { dv: null, sv: null }, result = null, shownGroups = 0;
  function schedule(delay) { clearTimeout(timer); timer = setTimeout(run, delay); }
  function dataStatus() { return lastDataStatus; }
  var lastDataStatus = 'empty';
  function badge(state, text, title) { App.setSchemaBadge(state ? { state: state, text: text, title: title || '' } : null); }

  function stopPending() {
    clearTimeout(limitTimer);
    clearTimeout(slowTimer);
    pending = null;
    hideProgress();
  }

  function run() {
    clearTimeout(timer);
    var my = ++seq;
    stopPending();
    var schemaText = doc.text();
    if (!isOpen() || !/\S/.test(schemaText)) {
      badge(null);
      doc.showError(null);
      showState('empty', 'No schema yet', isOpen() ? 'Paste a JSON Schema, open one, or generate one from the JSON.' : '');
      summary.innerHTML = '';
      named.hidden = true;
      return;
    }
    if (lastDataStatus !== 'ok' && lastDataStatus !== 'unsupported') {
      badge(null);
      showState('empty', 'Nothing to check yet', lastDataStatus === 'empty' ? 'Paste or open JSON to check it against the schema.' : 'Fix the JSON to check it against the schema.');
      return;
    }
    var dataText = App.inputText(), dv = App.inputVersion(), sv = doc.version;
    // The limit grows with the size of the data; the worker stops itself a little earlier
    // when it can, and is ended from here when a single slow pattern keeps it busy.
    var limit = 4000 + Math.round(dataText.length / 1048576 * 1000);
    var msg = { type: 'validate', dv: dv, sv: sv, opts: { formats: formatsBox.checked, maxErrors: 5000, limitMs: limit - 500 } };
    if (has.dv !== dv) msg.data = dataText;
    if (has.sv !== sv) msg.schema = schemaText;
    pending = { id: my, started: Date.now() };
    slowTimer = setTimeout(function () {
      if (!pending || pending.id !== my) return;
      badge('busy', 'Checking against schema\u2026');
      showProgress('Checking against the schema\u2026', null, function () { stopped(my, 'The check was cancelled.'); });
    }, PROGRESS_DELAY);
    limitTimer = setTimeout(function () {
      stopped(my, 'Checking took longer than ' + Math.round(limit / 1000) + ' seconds, so it was stopped. A "pattern" in the schema may be very slow on this data.');
    }, limit);
    var send = function (m) {
      App.request(m, function (reply) {
        if (!pending || pending.id !== my || my !== seq) return;
        if (reply.type === 'need-text') {
          send({ type: 'validate', dv: dv, sv: sv, data: dataText, schema: schemaText, opts: msg.opts });
          return;
        }
        stopPending();
        if (reply.type !== 'validate') {
          if (reply.cancelled) return;
          has = { dv: null, sv: null };
          show({ status: 'schema-error', message: reply.message || 'The check failed.' });
          return;
        }
        has = { dv: dv, sv: sv };
        show(reply.result);
      });
    };
    send(msg);
  }

  // A check that ran too long (or was cancelled): end the worker so the page never waits.
  function stopped(my, why) {
    if (!pending || pending.id !== my) return;
    stopPending();
    seq++;
    has = { dv: null, sv: null };
    App.restartWorker();
    result = null;
    badge('invalid', 'Schema check stopped', why);
    showState('error', 'Check stopped', why);
    countEl.innerHTML = '';
  }

  function showState(kind, title, text) {
    list.textContent = '';
    more.hidden = true;
    empty.hidden = false;
    empty.setAttribute('data-kind', kind);
    emptyTitle.textContent = title;
    emptyText.textContent = text;
    if (kind !== 'same') countEl.innerHTML = '';
  }

  function show(r) {
    result = r;
    summary.innerHTML = '';
    named.hidden = true;
    if (r.status === 'invalid' && r.side === 'schema') {
      doc.showError(r.error);
      badge('invalid', 'Schema isn\u2019t valid JSON', 'Fix the schema\u2019s JSON to check against it.');
      showState('error', 'The schema isn\u2019t valid JSON', 'Fix it in the Schema box, then the JSON is checked against it.');
      return;
    }
    doc.showError(null);
    if (r.status === 'invalid') { badge(null); showState('empty', 'Nothing to check yet', 'Fix the JSON to check it against the schema.'); return; }
    if (r.status === 'timeout') {
      badge('invalid', 'Schema check stopped', 'Checking took too long.');
      showState('error', 'Check stopped', 'Checking took too long, so it was stopped. A "pattern" in the schema may be very slow on this data.');
      return;
    }
    if (r.status === 'schema-error') {
      badge('invalid', 'Schema problem', r.message);
      showState('error', 'There\u2019s a problem with the schema', r.message);
      return;
    }
    summary.innerHTML = '<span class="badge">draft ' + T.esc(r.draft) + '</span>';
    var notes = [];
    if (r.note) notes.push(r.note);
    if (r.dataSchema) {
      notes.push(r.dataSchema.draft
        ? 'This JSON\u2019s "$schema" names draft ' + r.dataSchema.draft + ' (it looks like a schema itself).'
        : 'This JSON names its schema: ' + r.dataSchema.uri + '. Nothing is downloaded; paste that schema here to check against it.');
    }
    named.textContent = notes.join(' ');
    named.hidden = !notes.length;
    if (r.valid) {
      badge('valid', 'Valid against schema', 'Checked with the draft ' + r.draft + ' rules' + (formatsBox.checked ? ', formats included.' : '.'));
      showState('same', 'Valid against the schema', 'Checked with the draft ' + r.draft + ' rules' + (formatsBox.checked ? ', formats included.' : '. "format" is a note; turn on Check formats to check it.'));
      countEl.innerHTML = '';
      return;
    }
    var n = r.errors.length, label = T.groupDigits(n) + (r.truncated ? '+' : '') + ' schema ' + (n === 1 ? 'error' : 'errors');
    badge('invalid', label, 'Show the problems');
    countEl.innerHTML = '<span class="badge">' + T.esc(label) + '</span>' + (r.groups.length < n ? '<span class="badge">' + r.groups.length + ' kinds</span>' : '');
    empty.hidden = true;
    list.textContent = '';
    shownGroups = 0;
    lineByPath = new Map();
    for (var i = 0; i < r.errors.length; i++) {
      var key = T.formatPath(r.errors[i].path, 'pointer');
      if (!lineByPath.has(key)) lineByPath.set(key, r.errors[i].line);
    }
    showMore();
  }
  var lineByPath = new Map();

  // ---- The list of problems ----
  function pathText(parts) {
    var f = App.pathFormat(), p = T.formatPath(parts, f);
    return p || (f === 'jq' ? '.' : f === 'jsonpath' ? '$' : '(root)');
  }
  function showMore() {
    var groups = result.groups, end = Math.min(groups.length, shownGroups + GROUPS_STEP), frag = document.createDocumentFragment();
    for (var g = shownGroups; g < end; g++) frag.appendChild(groupItem(groups[g], g));
    list.appendChild(frag);
    shownGroups = end;
    more.hidden = shownGroups >= groups.length;
    more.textContent = 'Show more (' + T.groupDigits(groups.length - shownGroups) + ' more)';
  }
  more.addEventListener('click', function () {
    var first = shownGroups;
    showMore();
    var b = list.querySelector('[data-g="' + first + '"]');
    if (b) b.focus();
  });
  function groupItem(gr, g) {
    var li = document.createElement('li');
    li.className = 'schema-item';
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'schema-err';
    b.setAttribute('data-g', g);
    b.setAttribute('data-p', 0);
    var where = pathText(gr.paths[0]) + (gr.count > 1 ? '' : '');
    b.innerHTML = '<span class="schema-msg">' + T.esc(gr.message) + '</span>' +
      '<span class="schema-where"><span class="schema-path">' + T.esc(where) + '</span>' +
      (gr.count > 1 ? '<span class="schema-count"> and ' + T.groupDigits(gr.count - 1) + ' more ' + (gr.count === 2 ? 'place' : 'places') + '</span>' : '') + '</span>' +
      (gr.within ? '<span class="schema-within">In ' + T.esc(gr.within) + ', the closest match</span>' : '') +
      '<span class="schema-kw">' + T.esc(gr.keyword) + ' \u00b7 ' + T.esc(gr.schemaPath) + '</span>';
    li.appendChild(b);
    if (gr.count > 1) {
      var det = document.createElement('details'), sum = document.createElement('summary'), ol = document.createElement('ol');
      det.className = 'schema-paths';
      sum.textContent = 'All places' + (gr.count > gr.paths.length ? ' (first ' + gr.paths.length + ' of ' + T.groupDigits(gr.count) + ')' : '');
      det.appendChild(sum);
      for (var k = 0; k < gr.paths.length; k++) {
        var pli = document.createElement('li'), pb = document.createElement('button');
        pb.type = 'button';
        pb.className = 'schema-place';
        pb.setAttribute('data-g', g);
        pb.setAttribute('data-p', k);
        pb.textContent = pathText(gr.paths[k]);
        pli.appendChild(pb);
        ol.appendChild(pli);
      }
      det.appendChild(ol);
      li.appendChild(det);
    }
    return li;
  }
  list.addEventListener('click', function (e) {
    var b = e.target.closest('[data-g]');
    if (!b || !result || !result.groups) return;
    var parts = result.groups[+b.getAttribute('data-g')].paths[+b.getAttribute('data-p')];
    var cur = list.querySelectorAll('[aria-current]');
    for (var i = 0; i < cur.length; i++) cur[i].removeAttribute('aria-current');
    b.setAttribute('aria-current', 'true');
    App.showValue(parts, lineByPath.get(T.formatPath(parts, 'pointer')) || null);
  });
  App.onPathFormat(function () {
    if (!result || !result.groups || result.valid) return;
    var n = shownGroups;
    list.textContent = '';
    shownGroups = 0;
    while (shownGroups < n) showMore();
  });

  // ---- Generate a schema from the JSON ----
  $('btnGenSchema').addEventListener('click', function () {
    var text = App.inputText();
    if (lastDataStatus !== 'ok' && lastDataStatus !== 'unsupported') {
      App.showToast('The JSON needs to be valid to generate a schema from it');
      return;
    }
    var apply = function (schema) {
      doc.setText(JSON.stringify(schema, null, 2));
      saveText();
      if (!isOpen()) setOpen(true, true); else run();
      App.showToast('Schema generated from the JSON');
    };
    if (text.length <= SIZES.SYNC_CHARS) { apply(T.generateSchema(JSON.parse(text))); return; }
    App.request({ type: 'generateSchema', text: text }, function (m) {
      if (m.type === 'generateSchema') apply(m.schema);
      else if (!m.cancelled) App.showToast('Couldn\u2019t generate a schema for this JSON');
    });
  });

  App.registerSchema({
    // The JSON changed (or was checked again): check it against the schema.
    dataChanged: function (status) {
      lastDataStatus = status;
      if (isOpen()) schedule(status === 'ok' ? 150 : 0);
    },
    // The status bar's schema badge: open the panel and go to the problems.
    showList: function () {
      if (!isOpen()) setOpen(true, true);
      var first = list.querySelector('.schema-err');
      $('schemaPanel').scrollIntoView({ block: 'start', behavior: 'smooth' });
      (first || toggle).focus({ preventScroll: true });
    }
  });
  if (load(KEY_OPEN) === '1') setOpen(true, false);
})();
