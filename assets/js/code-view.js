/*
 * Virtual Code view: shows a text of any size by drawing only the rows on screen (plus a
 * few more above and below). Used for the output and for the read-only large input.
 * Row math and highlighting come from json-tools.js (rowIndex, virtualWindow, renderRow).
 *
 * Layout inside the scroll container:
 *   .code-rows (as tall as all the rows)  [ sticky .gutter > .gutter-track | pre > code ]
 * <code> is moved with a transform; each drawn row is an absolutely positioned
 * <div class="code-row" data-r="..."> holding exactly its slice of the text, line ending
 * included, so the rows join up to the original text.
 */
(function () {
  'use strict';

  var T = window.JsonTools;
  var ROW_H = 24, PAD = 16, BUFFER = 40, FULL_ROWS = 400, MAX_HEIGHT = 8000000;

  function create(opts) {
    var scroller = opts.scroller, rowsBox = opts.rows, pre = opts.pre, code = opts.code;
    var gutter = opts.gutter, track = opts.track, lineMark = opts.lineMark || null;
    var text = '', index = null, restarts = null, scanner = null;
    var ranges = null, current = -1;
    var drawn = new Map();        // row -> element
    var from = 0, to = -1, base = 0, win = null;
    var pinned = new Set();       // rows kept while a selection or a jump needs them
    var selectAll = false, markedLine = null;
    var label = null, rowClass = null;   // optional per-row gutter labels and row classes (compare view)

    function rows() { return index ? index.rows : 0; }
    function viewHeight() { return scroller.clientHeight || 400; }
    function fresh() {
      for (var r of drawn.keys()) drawn.get(r).remove();
      drawn.clear();
      from = 0; to = -1;
    }

    // ---- Drawing ----
    function rowHtml(r) { return T.renderRow(text, index, restarts, scanner, r, ranges); }

    function makeRow(r) {
      var el = document.createElement('div');
      el.className = 'code-row' + (rowClass ? ' ' + rowClass(r) : '');
      el.setAttribute('data-r', r);
      el.innerHTML = rowHtml(r);
      return el;
    }

    // The rows that hold the current selection's ends stay drawn, so a selection that
    // started far above can still be extended and copied.
    function selectionRows() {
      var keep = new Set(), sel = window.getSelection && window.getSelection();
      if (!sel || !sel.rangeCount) return keep;
      [sel.anchorNode, sel.focusNode].forEach(function (n) {
        var row = rowOf(n);
        if (row) keep.add(+row.getAttribute('data-r'));
      });
      return keep;
    }
    function rowOf(node) {
      var el = node && (node.nodeType === 1 ? node : node.parentNode);
      var row = el && el.closest ? el.closest('.code-row') : null;
      return row && code.contains(row) ? row : null;
    }

    // Draws the rows for the current scroll position. force: redraw the rows' contents
    // (new marks); otherwise rows already drawn are kept as they are.
    function render(force) {
      if (!index) return;
      var n = rows();
      win = T.virtualWindow(scroller.scrollTop, viewHeight(), n, ROW_H, PAD, MAX_HEIGHT);
      rowsBox.style.height = win.height + 'px';
      var a, b;
      if (n <= FULL_ROWS) { a = 0; b = n - 1; }
      else if (!force && win.first >= from && win.last <= to && (from === 0 || win.first - from >= 8) && (to === n - 1 || to - win.last >= 8)) {
        a = from; b = to;   // still well inside what is drawn: only the position changes
      } else {
        a = Math.max(0, win.first - BUFFER);
        b = Math.min(n - 1, win.last + BUFFER);
      }
      var keep = selectionRows();
      pinned.forEach(function (r) { keep.add(r); });
      var changed = force || a !== from || b !== to;
      if (changed) {
        // Remove rows no longer needed, then add the missing ones in order.
        drawn.forEach(function (el, r) {
          if ((r < a || r > b) && !keep.has(r)) { el.remove(); drawn.delete(r); }
          else if (force && !keep.has(r)) { el.innerHTML = rowHtml(r); el.className = 'code-row' + (rowClass ? ' ' + rowClass(r) : ''); }
        });
        var want = [];
        for (var r = a; r <= b; r++) want.push(r);
        keep.forEach(function (r) { if ((r < a || r > b) && r < n) want.push(r); });
        want.sort(function (x, y) { return x - y; });
        var next = null;
        for (var i = want.length - 1; i >= 0; i--) {
          var row = want[i], el = drawn.get(row);
          if (!el) {
            el = makeRow(row);
            drawn.set(row, el);
            code.insertBefore(el, next);
          } else if (el.nextSibling !== next) {
            code.insertBefore(el, next);
          }
          next = el;
        }
        from = a; to = b; base = a;
        drawn.forEach(function (el, r) { el.style.top = ((r - base) * ROW_H) + 'px'; });
        drawGutter();
      }
      // Place the drawn block: row r sits at PAD + r * ROW_H + shift in the scroll content.
      var y = PAD + base * ROW_H + win.shift;
      code.style.transform = 'translateY(' + y + 'px)';
      track.style.transform = 'translateY(' + y + 'px)';
      if (lineMark) placeLineMark();
      if (current >= 0) markCurrent();
    }

    function drawGutter() {
      var out = [];
      for (var r = from; r <= to; r++) {
        out.push(label ? label(r) : index.lineStarts && T.isContinuation(index, r) ? '' : String(T.lineOfRow(index, r) + 1));
      }
      track.textContent = out.join('\n');
    }

    // ---- Scrolling ----
    function scrollToRow(r, align) {
      var y = PAD + r * ROW_H - (align === undefined ? viewHeight() / 3 : align * viewHeight());
      scroller.scrollTop = T.virtualScrollTop(y, viewHeight(), rows(), ROW_H, PAD, MAX_HEIGHT);
      render(false);
    }
    function rowVisible(r) {
      var w = T.virtualWindow(scroller.scrollTop, viewHeight(), rows(), ROW_H, PAD, MAX_HEIGHT);
      var top = PAD + r * ROW_H - w.top;
      return top >= 0 && top + ROW_H <= viewHeight();
    }
    // Brings an offset into view (only when it is not already), vertically and horizontally.
    function reveal(offset, el) {
      if (!index) return;
      var r = T.rowOfOffset(index, offset);
      if (!rowVisible(r)) scrollToRow(r);
      var target = el || drawn.get(r);
      if (!target) return;
      var rect = target.getBoundingClientRect(), box = scroller.getBoundingClientRect(), gw = gutter.offsetWidth;
      if (rect.left < box.left + gw + 16 || rect.right > box.right - 16) {
        scroller.scrollLeft = Math.max(0, scroller.scrollLeft + rect.left - box.left - gw - 96);
      }
    }
    // Moving by keys and wheel in pixels of text, so it also works when the scroll range is
    // scaled (very long texts), where the browser's own steps would skip rows.
    function scrollBy(dy) {
      var w = T.virtualWindow(scroller.scrollTop, viewHeight(), rows(), ROW_H, PAD, MAX_HEIGHT);
      scroller.scrollTop = T.virtualScrollTop(w.top + dy, viewHeight(), rows(), ROW_H, PAD, MAX_HEIGHT);
      render(false);
    }

    scroller.addEventListener('scroll', function () { render(false); if (opts.onScroll) opts.onScroll(); }, { passive: true });
    scroller.addEventListener('wheel', function (e) {
      if (!win || !win.scaled || e.ctrlKey) return;
      e.preventDefault();
      var unit = e.deltaMode === 1 ? ROW_H : e.deltaMode === 2 ? viewHeight() : 1;
      if (e.deltaY) scrollBy(e.deltaY * unit);
      if (e.deltaX) scroller.scrollLeft += e.deltaX * unit;
    }, { passive: false });
    scroller.addEventListener('keydown', function (e) {
      if (e.target !== scroller || e.altKey) return;
      var page = viewHeight() - ROW_H, mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === 'a' || e.key === 'A')) {
        // Select all: the browser can only select the rows that are drawn, so copying while
        // "select all" is on gives the whole text.
        e.preventDefault();
        var sel = window.getSelection();
        sel.selectAllChildren(code);
        selectAll = true;
        return;
      }
      if (mod && e.key !== 'Home' && e.key !== 'End') return;
      var handled = true;
      switch (e.key) {
        case 'PageDown': scrollBy(page); break;
        case 'PageUp': scrollBy(-page); break;
        case ' ': scrollBy(e.shiftKey ? -page : page); break;
        case 'ArrowDown': if (win && win.scaled) scrollBy(ROW_H * 2); else handled = false; break;
        case 'ArrowUp': if (win && win.scaled) scrollBy(-ROW_H * 2); else handled = false; break;
        case 'Home': scroller.scrollTop = 0; if (!mod) scroller.scrollLeft = 0; render(false); break;
        case 'End': scroller.scrollTop = scroller.scrollHeight; render(false); break;
        default: handled = false;
      }
      if (handled) e.preventDefault();
    });
    if (window.ResizeObserver) new ResizeObserver(function () { render(false); }).observe(scroller);

    // ---- Selection and copying ----
    // Text offset of a DOM point inside a drawn row, or null.
    function offsetOf(node, offset) {
      var row = rowOf(node);
      if (!row) return null;
      var range = document.createRange();
      range.setStart(row, 0);
      try { range.setEnd(node, offset); } catch (e) { return null; }
      return index.starts[+row.getAttribute('data-r')] + range.toString().length;
    }
    // DOM point for a text offset; draws (and keeps) its row when needed.
    function pointAt(offset) {
      var r = T.rowOfOffset(index, offset), row = drawn.get(r);
      if (!row) { pinned.add(r); render(true); row = drawn.get(r); }
      if (!row) return null;
      var k = offset - index.starts[r];
      var walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT), node, pos = 0, last = null;
      while ((node = walker.nextNode())) {
        if (pos + node.length >= k) return { node: node, offset: k - pos };
        pos += node.length;
        last = node;
      }
      return last ? { node: last, offset: last.length } : { node: row, offset: 0 };
    }
    function selectionOffsets() {
      var sel = window.getSelection();
      if (!index || !sel || !sel.rangeCount) return null;
      if (selectAll) return { start: 0, end: text.length };
      var a = offsetOf(sel.anchorNode, sel.anchorOffset), b = offsetOf(sel.focusNode, sel.focusOffset);
      if (a === null && b === null) return null;
      if (a === null || b === null) {
        // One end is outside the rows (in the gutter or padding): use the row edge.
        var range = sel.getRangeAt(0), rowsIn = [];
        drawn.forEach(function (el, r) { if (range.intersectsNode(el)) rowsIn.push(r); });
        if (!rowsIn.length) return null;
        var lo = Math.min.apply(null, rowsIn), hi = Math.max.apply(null, rowsIn);
        if (a === null) a = b <= index.starts[lo] ? index.starts[hi + 1] : index.starts[lo];
        if (b === null) b = a <= index.starts[lo] ? index.starts[hi + 1] : index.starts[lo];
      }
      return { start: Math.min(a, b), end: Math.max(a, b) };
    }
    // Copying gives the exact text, also for rows that are not drawn and for long lines split
    // into rows (no extra line breaks).
    scroller.addEventListener('copy', function (e) {
      var o = selectionOffsets();
      if (!o || !e.clipboardData) return;
      e.preventDefault();
      e.clipboardData.setData('text/plain', text.slice(o.start, o.end));
    });
    document.addEventListener('mousedown', function () { selectAll = false; pinned.clear(); }, true);
    document.addEventListener('keydown', function (e) {
      if (!(e.ctrlKey || e.metaKey) || !/^[acAC]$/.test(e.key)) selectAll = false;
    }, true);

    // Selects a range of the text and scrolls its start into view.
    function select(start, end) {
      if (!index) return;
      var r = T.rowOfOffset(index, start);
      if (!rowVisible(r)) scrollToRow(r);
      pinned.clear();
      pinned.add(r);
      pinned.add(T.rowOfOffset(index, end));
      render(true);
      var a = pointAt(start), b = pointAt(end);
      if (!a || !b) return;
      var range = document.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      reveal(start);
    }

    // ---- Search marks ----
    function markCurrent() {
      var old = code.querySelectorAll('mark.current');
      for (var i = 0; i < old.length; i++) old[i].classList.remove('current');
      if (current < 0) return null;
      var mks = code.querySelectorAll('mark[data-i="' + current + '"]');
      for (var k = 0; k < mks.length; k++) mks[k].classList.add('current');
      return mks[0] || null;
    }

    // ---- The marked line (a syntax error in the input) ----
    function placeLineMark() {
      if (markedLine === null || !index) { lineMark.hidden = true; return; }
      var r = T.rowOfLine(index, markedLine - 1);
      var w = T.virtualWindow(scroller.scrollTop, viewHeight(), rows(), ROW_H, PAD, MAX_HEIGHT);
      lineMark.textContent = markedLine;
      lineMark.style.top = (PAD + r * ROW_H + w.shift) + 'px';
      lineMark.hidden = false;
    }

    return {
      // Shows a text. idx: T.rowIndex(text) (made here when left out); restartInfo and
      // scan: highlighting (T.rowRestarts and T.scannerFor), or null for plain text.
      // extra: { label(r), rowClass(r), marks } for the compare view.
      setText: function (t, idx, restartInfo, scan, keepScroll, extra) {
        text = t;
        label = extra && extra.label || null;
        rowClass = extra && extra.rowClass || null;
        index = idx || T.rowIndex(t);
        restarts = restartInfo || null;
        scanner = scan || null;
        ranges = extra && extra.marks && extra.marks.length ? extra.marks : null;
        current = -1;
        selectAll = false;
        pinned.clear();
        fresh();
        gutter.style.setProperty('--digits', T.gutterDigits(index.lines));
        pre.style.minWidth = 'calc(' + index.maxRowLength + 'ch + ' + (2 * PAD) + 'px)';
        if (!keepScroll) { scroller.scrollTop = 0; scroller.scrollLeft = 0; }
        render(true);
      },
      clear: function () {
        text = ''; index = null; restarts = null; scanner = null; ranges = null; current = -1; markedLine = null; label = null; rowClass = null;
        fresh();
        track.textContent = '';
        rowsBox.style.height = '';
        pre.style.minWidth = '';
        code.style.transform = '';
        if (lineMark) lineMark.hidden = true;
      },
      // Search marks: [{ start, end, i }] sorted by start (null: none).
      setMarks: function (list, cur) {
        ranges = list && list.length ? list : null;
        current = cur === undefined ? -1 : cur;
        if (index) render(true);
      },
      // Makes match i the current one; scroll: bring it into view.
      setCurrent: function (i, scroll) {
        current = i;
        if (!index) return;
        if (scroll && ranges) {
          var hit = null;
          for (var k = 0; k < ranges.length; k++) if (ranges[k].i === i) { hit = ranges[k]; break; }
          if (hit) {
            var r = T.rowOfOffset(index, hit.start);
            if (!rowVisible(r)) scrollToRow(r);
            else render(false);
            reveal(hit.start, markCurrent());
            return;
          }
        }
        markCurrent();
      },
      markLine: function (line) { markedLine = line || null; if (lineMark) placeLineMark(); },
      revealLine: function (line) { if (index) scrollToRow(T.rowOfLine(index, line - 1)); },
      // Scrolls row r into view (a third from the top) unless it is already in view.
      revealRow: function (r, force) { if (index && (force || !rowVisible(r))) scrollToRow(r); },
      // Redraws the drawn rows (after row classes changed).
      refresh: function () { if (index) render(true); },
      reveal: reveal,
      select: select,
      selectionOffsets: selectionOffsets,
      offsetOf: offsetOf,
      render: render,
      text: function () { return text; },
      index: function () { return index; },
      // For checks: how many rows are drawn right now.
      drawnRows: function () { return drawn.size; }
    };
  }

  window.CodeView = { create: create, ROW_H: ROW_H, PAD: PAD };
})();
