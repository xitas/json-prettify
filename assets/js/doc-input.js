/*
 * A JSON input box like the main one: line numbers, the error with Fix JSON and Go to error,
 * Open file and dropping files, and a read-only view for large texts. Used by Compare mode
 * (Original and Changed) and by the Schema panel. Element ids are prefix + name + suffix,
 * for example cmpInputA or schemaInput.
 * opts.progress: { show(label, fraction, cancel), hide() } for reading files.
 */
(function () {
  'use strict';

  var T = window.JsonTools, CV = window.CodeView;

  function badges(items) {
    return items.map(function (t) { return '<span class="badge">' + T.esc(t) + '</span>'; }).join('');
  }
  function plural(n, one, many) { return T.groupDigits(n) + ' ' + (n === 1 ? one : many); }

  function create(prefix, suffix, title, opts) {
    var el = function (name) { return document.getElementById(prefix + name + suffix); };
    var App = window.JsonPrettify, SIZES = App.sizes, reading = null;
    var showProgress = opts.progress.show, hideProgress = opts.progress.hide;
    var ta = el('Input'), gutter = el('Gutter'), track = el('Track'), mark = el('Mark');
    var viewEl = el('View'), meta = el('Meta'), pane = el('Pane');
    var errBox = el('Error'), errText = el('ErrorText'), btnFix = el('Fix'), btnGo = el('Go');
    var note = el('Note'), noteText = el('NoteText'), btnEdit = el('Edit'), fileIn = el('File');
    var view = CV.create({ scroller: viewEl, rows: viewEl.querySelector('.code-rows'), pre: viewEl.querySelector('pre'), code: el('ViewCode'),
      gutter: el('ViewGutter'), track: el('ViewTrack'), lineMark: el('ViewMark') });
    var doc = { title: title, version: 1, big: null, bytes: 0, error: null, fixFailure: null, dirty: false, onChange: function () {} };
    var lineCount = 0;

    doc.text = function () { return doc.big !== null ? doc.big : ta.value; };
    function isBig(t) {
      return t.length > SIZES.VIEW_ONLY_CHARS || (t.length > SIZES.VIEW_ONLY_LINES && T.countLines(t) > SIZES.VIEW_ONLY_LINES);
    }
    function refreshGutter() {
      if (doc.big !== null) return;
      var n = T.countLines(ta.value);
      if (n !== lineCount) {
        lineCount = n;
        track.setAttribute('data-lines', T.lineNumbers(n));
        gutter.style.setProperty('--digits', T.gutterDigits(n));
      }
      track.style.transform = 'translateY(' + (-ta.scrollTop) + 'px)';
    }
    function refreshMeta() {
      var t = doc.text();
      meta.innerHTML = t.length ? badges([T.fmtBytes(doc.big !== null ? doc.bytes : T.byteLen(t)),
        plural(doc.big !== null ? view.index().lines : T.countLines(t), 'line', 'lines')]) : '';
    }
    function syncNote() {
      noteText.textContent = doc.big !== null ? 'Large file: shown read-only so the page stays responsive.' : '';
      btnEdit.hidden = doc.big === null || doc.big.length > SIZES.EDIT_MAX_CHARS;
      note.hidden = doc.big === null;
    }
    // Replaces the text (info.bytes: the file size). Large texts go to the read-only view.
    doc.setText = function (t, info) {
      doc.version++;
      doc.fixFailure = null;
      if (isBig(t)) {
        doc.big = t;
        doc.bytes = info && info.bytes !== undefined ? info.bytes : T.byteLen(t);
        ta.value = '';
        ta.hidden = gutter.hidden = true;
        viewEl.hidden = false;
        view.setText(t);
      } else {
        if (doc.big !== null) { doc.big = null; viewEl.hidden = true; view.clear(); ta.hidden = gutter.hidden = false; lineCount = -1; }
        ta.value = t;
      }
      syncNote();
      refreshGutter();
      refreshMeta();
    };
    doc.focus = function () { (doc.big !== null ? viewEl : ta).focus(); };

    // The error to show for this input (or null).
    doc.showError = function (err) {
      doc.error = err;
      if (!err) {
        errBox.hidden = true;
        mark.hidden = true;
        view.markLine(null);
        return;
      }
      errText.textContent = (err.line ? 'Line ' + err.line + ', column ' + err.col + ': ' : '') + err.message + '.' +
        (doc.fixFailure ? ' Couldn\u2019t fix this automatically: ' + doc.fixFailure + '.' : '');
      btnFix.hidden = !!doc.fixFailure;
      btnGo.hidden = err.pos === null;
      errBox.hidden = false;
      if (doc.big !== null) view.markLine(err.line);
      else if (err.line) {
        mark.textContent = err.line;
        mark.style.setProperty('--mark-line', err.line);
        mark.hidden = false;
      }
    };

    function changed() {
      doc.dirty = true;
      doc.fixFailure = null;
      refreshMeta();
      doc.onChange();
    }
    ta.addEventListener('input', function () { doc.version++; refreshGutter(); changed(); });
    ta.addEventListener('scroll', function () { track.style.transform = 'translateY(' + (-ta.scrollTop) + 'px)'; }, { passive: true });
    // Pasting a big text: into the read-only view, not the text box (which would freeze).
    ta.addEventListener('paste', function (e) {
      var data = e.clipboardData && e.clipboardData.getData('text/plain');
      if (!data || data.length < 20000) return;
      var v = ta.value, next = v.slice(0, ta.selectionStart) + data + v.slice(ta.selectionEnd);
      if (!isBig(next)) return;
      e.preventDefault();
      doc.setText(next);
      changed();
    });
    viewEl.addEventListener('paste', function (e) {
      var data = e.clipboardData && e.clipboardData.getData('text/plain');
      if (!data) return;
      e.preventDefault();
      doc.setText(data);
      changed();
    });
    btnEdit.addEventListener('click', function () {
      var t = doc.big;
      if (t === null) return;
      doc.big = null;
      viewEl.hidden = true;
      view.clear();
      ta.hidden = gutter.hidden = false;
      lineCount = -1;
      ta.value = t;
      syncNote();
      refreshGutter();
      if (doc.error) doc.showError(doc.error);
      ta.focus();
      ta.setSelectionRange(0, 0);
    });

    // Fix JSON and Go to error, as in Format mode.
    btnGo.addEventListener('click', function () {
      var err = doc.error, t = doc.text();
      if (!err || err.pos === null) return;
      if (doc.big !== null) { viewEl.focus(); view.select(Math.min(err.pos, t.length), Math.min(err.pos + 1, t.length)); return; }
      ta.focus();
      try { ta.setSelectionRange(Math.min(err.pos, t.length), Math.min(err.pos + 1, t.length)); } catch (e) {}
      ta.scrollTop = Math.max(0, (err.line - 4) * 24);
    });
    btnFix.addEventListener('click', function () {
      var before = doc.text();
      var finish = function (r) {
        if (doc.text() !== before) return;
        if (!r.ok || !r.changed) {
          doc.fixFailure = r.ok ? 'it is already valid' : r.error;
          if (doc.error) doc.showError(doc.error);
          btnGo.focus();
          return;
        }
        var kept = false;
        if (doc.big === null && !isBig(r.text)) {
          // Through the editing pipeline, so Ctrl/Cmd + Z can undo the fix.
          ta.focus();
          ta.setSelectionRange(0, before.length);
          try { kept = document.execCommand('insertText', false, r.text); } catch (e) {}
        }
        if (!kept || ta.value !== r.text) doc.setText(r.text);
        else { doc.version++; refreshGutter(); }
        App.showToast(r.summary);
        changed();
      };
      if (before.length > SIZES.SYNC_CHARS) App.request({ type: 'repair', text: before }, function (m) { if (m.type === 'repair') finish(m.result); });
      else finish(T.repairJson(before));
    });

    // Opening and dropping files
    function openFile(f) {
      if (!f) return;
      if (f.size > SIZES.MAX_FILE_BYTES) {
        App.showToast(f.name + ' is ' + T.fmtBytes(f.size) + ', too big for this page (the limit is ' + T.fmtBytes(SIZES.MAX_FILE_BYTES) + ')');
        return;
      }
      var reader = new FileReader();
      reading = reader;
      showProgress('Reading ' + f.name + ' (' + T.fmtBytes(f.size) + ')\u2026', 0, function () { reader.abort(); });
      reader.onprogress = function (e) {
        if (reading === reader && e.lengthComputable) showProgress('Reading ' + f.name + ' (' + T.fmtBytes(e.loaded) + ' of ' + T.fmtBytes(f.size) + ')\u2026', e.loaded / e.total, function () { reader.abort(); });
      };
      reader.onload = function () {
        if (reading !== reader) return;
        reading = null;
        hideProgress();
        doc.setText(String(reader.result || ''), { bytes: f.size });
        changed();
      };
      reader.onerror = function () {
        if (reading !== reader) return;
        reading = null;
        hideProgress();
        App.showToast('Couldn\u2019t read ' + f.name);
      };
      reader.onabort = function () {
        if (reading !== reader) return;
        reading = null;
        hideProgress();
        App.showToast('Stopped reading ' + f.name);
      };
      reader.readAsText(f);
    }
    fileIn.addEventListener('change', function () { openFile(fileIn.files && fileIn.files[0]); fileIn.value = ''; });
    var hasFiles = function (e) { return e.dataTransfer && [].indexOf.call(e.dataTransfer.types || [], 'Files') !== -1; };
    pane.addEventListener('dragover', function (e) { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; pane.classList.add('drop-target'); });
    pane.addEventListener('dragleave', function (e) { if (!pane.contains(e.relatedTarget)) pane.classList.remove('drop-target'); });
    pane.addEventListener('drop', function (e) {
      pane.classList.remove('drop-target');
      if (!hasFiles(e)) return;
      e.preventDefault();
      openFile(e.dataTransfer.files[0]);
    });

    refreshGutter();
    return doc;
  }

  window.DocInput = { create: create };
})();
