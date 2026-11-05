# JSON Formatter

A simple, fast JSON formatter built with plain HTML, CSS and JavaScript. Paste your JSON to beautify, minify and validate it right in the browser. No frameworks, no build step, and nothing is uploaded anywhere.

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
├── index.html   # Page markup
├── style.css    # Styles
├── script.js    # Formatting, validation and UI logic
└── README.md
```

## Getting started

No installation needed.

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

## Usage

1. Paste or type JSON into the **Input** panel (or use **Open file** / **Load sample**).
2. Click **Format** to beautify or **Minify** to compress.
3. Click **Validate** to check the input. Errors show the line and column.
4. Click **Copy** to copy the result.

## Deploy with GitHub Pages

1. Push the project to GitHub.
2. Go to **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, select `main` and `/ (root)`, then save.
4. Your site will be live at `https://<your-username>.github.io/<your-repo>/`.

## Notes

- Very large numbers (beyond JavaScript's safe integer range) may lose precision when parsed, since the tool uses the browser's built-in `JSON.parse`.
- Highlighting is skipped for very large outputs to keep the page responsive.

## License

This project is open source. Add a license of your choice (for example MIT) in a `LICENSE` file.
