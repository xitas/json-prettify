# JSON Prettify

A simple, fast JSON formatter built with plain HTML, CSS and JavaScript. Paste your JSON to beautify, minify and validate it right in the browser. No frameworks, no build step, and nothing is uploaded anywhere.

**Live demo:** [https://xitas.github.io/json-prettify/](https://xitas.github.io/json-prettify/)

## Features

- **Format / beautify** JSON with 2-space, 4-space or tab indentation
- **Minify** JSON and see how much size you saved
- **Validate** as you type, with the error message and the exact line and column
- **Go to error** button that jumps to the problem in the input
- **Sort keys** alphabetically (applies to nested objects too)
- **Syntax highlighting** for keys, strings, numbers, booleans and null
- **Copy** the result, or use it as the new input
- **Open a file** from your device, or load a sample to try it out
- Keyboard shortcut: `Ctrl/Cmd + Enter` to format

## Project structure

```
.
├── index.html              # Page markup
├── assets/
│   ├── css/
│   │   └── style.css       # Styles and light/dark theme tokens
│   └── js/
│       ├── json-tools.js   # Pure helpers: error parsing, sorting, stats, highlighting
│       └── app.js          # UI wiring: toolbar, input/output panes, status line
├── tests/
│   └── json-tools.test.js  # Unit tests for json-tools.js
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

The helpers in `assets/js/json-tools.js` have unit tests that use Node's built-in test runner, so there is nothing to install. With Node.js 22 or newer:

```bash
node --test
```

Known bugs are recorded as tests marked `todo`: they describe the correct behavior, run with the rest of the suite and show up as `TODO` in the output, but do not fail it until the bug is fixed. There are no known bugs at the moment. GitHub Actions runs the same command on every push and pull request.

## Usage

1. Paste or type JSON into the **Input** panel (or use **Open file** / **Load sample**).
2. Click **Format** to beautify or **Minify** to compress.
3. Click **Validate** to check the input. Errors show the line and column.
4. Click **Copy** to copy the result.

## Notes

- Very large numbers (beyond JavaScript's safe integer range) may lose precision when parsed, since the tool uses the browser's built-in `JSON.parse`.
- Highlighting is skipped for very large outputs to keep the page responsive.

## License

This project is open source. Add a license of your choice (for example MIT) in a `LICENSE` file.