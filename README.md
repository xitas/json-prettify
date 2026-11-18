# JSON Prettify

A simple, fast JSON formatter built with plain HTML, CSS and JavaScript. Paste your JSON to beautify, minify and validate it right in the browser. No frameworks, no build step, and nothing is uploaded anywhere.

**Live demo:** [https://xitas.github.io/json-prettify/](https://xitas.github.io/json-prettify/)

## Features

- **Format / beautify** JSON with 2-space, 4-space or tab indentation (your choice is remembered)
- **Line numbers** beside the input and the output, with the line of a syntax error highlighted
- **Fix JSON** repairs common almost-JSON mistakes when you ask it to: trailing and missing commas, single or curly quotes, unquoted keys, comments, Python/JavaScript values (`True`, `None`, `undefined`, `NaN`) and a stray byte order mark. Text inside strings is never changed, and `Ctrl/Cmd + Z` undoes the fix
- **Minify** JSON and see how much size you saved
- **Validate** as you type, with the error message and the exact line and column
- **Go to error** button that jumps to the problem in the input
- **Sort keys** alphabetically (applies to nested objects too)
- **Tree view** of the output: fold and unfold objects and arrays, expand to a level, and move around with the keyboard; large arrays show 100 items at a time
- **Copy path or value** of any node as JavaScript, JSONPath, jq or JSON Pointer: click a key, use the copy icon, or press `C` / `Shift + C` in the tree; a breadcrumb shows where you are
- **Share** a link with the JSON (and your view settings) stored inside the link itself, compressed in the part after `#`, which browsers never send to a server. Nothing is uploaded; anyone with the link can see the JSON
- **Output as JSON or YAML**, with YAML that quotes anything a YAML parser could misread
- **Output as CSV** for an array of objects: one row per object, nested objects as `dotted.columns`, a comma, semicolon or tab delimiter, and protection against spreadsheet formula injection (on by default). Downloads include a UTF-8 byte order mark so Excel shows accents correctly
- **Output as TypeScript**: interfaces or type aliases inferred from the data, with an editable root name. Nested types get PascalCase names (`users` → `User`), identical shapes share one type, and array items are merged so missing properties become optional and mixed values become unions
- **Search** the output in both views: keys, values or both, match case, whole word and regex, with next/previous, a match count and a Filter that shows only matching branches of the tree
- **Syntax highlighting** for keys, strings, numbers, booleans and null
- **Compare** two documents (switch at the top): the data is compared, not the text, so whitespace and key order are not changes. Each addition, removal, changed value and changed type is listed with its path, and both documents are shown side by side with the changes lined up and marked with +, − and ~ (changed strings down to the character). Arrays can be matched by position, smartly (finding inserted and removed items) or by a key such as `id`. Jump between changes with Alt + ↓ and Alt + ↑, show only the changes with a few lines of context, copy the changes as a JSON Patch (RFC 6902) or as text, or share both documents in one link
- **Large files** (tested up to 50 MB): formatting and converting run in a Web Worker so the page never freezes, the Code view draws only the lines on screen, and long jobs show progress with a Cancel button. Files are read in the background with their size shown first; very large inputs are shown read-only, and typing in a large input waits for **Format** instead of re-formatting on every pause
- **Copy** the result, **download** it as a `.json` file (a loaded `data.json` saves as `data.formatted.json` or `data.min.json`), or use it as the new input
- **Open a file** from your device, or load a sample to try it out
- Keyboard shortcuts: `Ctrl/Cmd + Enter` to format, `Ctrl/Cmd + Shift + Enter` to fix broken JSON, `Ctrl/Cmd + S` to download the result, `Ctrl/Cmd + F` (in the output) or `/` to search

## Project structure

```
.
├── index.html              # Page markup
├── assets/
│   ├── css/
│   │   └── style.css       # Styles and light/dark theme tokens
│   └── js/
│       ├── json-tools.js   # Pure helpers: parsing, sorting, stats, conversions, highlighting, jobs
│       ├── code-view.js    # Virtual Code view: draws only the rows on screen
│       ├── compare.js      # Compare mode: two inputs, the list of changes, side-by-side view
│       └── app.js          # UI wiring: toolbar, input/output panes, status line, worker
├── scripts/
│   └── make-large-files.mjs  # Writes big JSON files for testing (not committed)
├── tests/
│   ├── json-tools.test.js  # Unit tests for json-tools.js
│   ├── big-text.test.js    # Unit tests for the large-file helpers and the worker
│   └── diff.test.js        # Unit tests for comparing documents (patches checked by applying them)
├── .github/workflows/
│   └── test.yml            # Runs the tests on every push and pull request
└── README.md
```

## Getting started

No installation needed. You can use the [live demo](https://xitas.github.io/json-prettify/) or run it locally.

1. Clone the repository:
   ```bash
   git clone https://github.com/xitas/json-prettify.git
   cd json-prettify
   ```
2. Open `index.html` in your browser.

Optionally, serve it locally:

```bash
python3 -m http.server 8000
```

Then visit `http://localhost:8000`.

## Running tests

The helpers in `assets/js/json-tools.js` have unit tests that use Node's built-in test runner. A few tests check the converters against real parsers and compilers (`yaml`, `typescript`), installed as dev dependencies. The page itself never loads anything from npm. With Node.js 22 or newer:

```bash
npm ci
npm test
```

To try the page with big inputs, `npm run large-files` writes 1, 5, 20 and 50 MB files (formatted and minified) to `test-data/large/`, which git ignores. Pass other sizes in MB to make those instead, for example `npm run large-files -- 2 100`.

Known bugs are recorded as tests marked `todo`: they describe the correct behavior, run with the rest of the suite and show up as `TODO` in the output, but do not fail it until the bug is fixed. There are no known bugs at the moment. GitHub Actions runs the same commands on every push and pull request.

## Usage

1. Paste or type JSON into the **Input** panel (or use **Open file** / **Load sample**).
2. Click **Format** to beautify or **Minify** to compress.
3. Click **Validate** to check the input. Errors show the line and column.
4. Click **Copy** to copy the result.

## Notes

- Very large numbers (beyond JavaScript's safe integer range) may lose precision when parsed, since the tool uses the browser's built-in `JSON.parse`.
- Inputs over 1 MB are processed in a Web Worker. The worker is made from a Blob URL, so it also starts when `index.html` is opened from disk. Where workers are not available, the same code runs on the main thread in small steps.
- Inputs over 2 MB (or 50,000 lines) are shown read-only, because the browser's text box takes seconds to load text that size and is slow to type in. **Edit as text** still loads inputs up to 10 MB into it. Files over 256 MB are not opened.

## License

This project is open source. Add a license of your choice (for example MIT) in a `LICENSE` file.