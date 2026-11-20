// Makes og-image.png, the 1200 x 630 social preview shown when a link to the site is shared,
// from an SVG drawn here (logo, name, tagline and a small formatted JSON snippet in the
// light theme's syntax colors). Uses headless Chrome or Edge; the PNG is committed.
//
//   node scripts/make-og-image.mjs     (or: npm run og-image)

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderPngs } from './lib/chrome.mjs';
import { BRACES } from './make-icons.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const W = 1200, H = 630;

// The light theme's tokens (assets/css/style.css).
const C = {
  bg: '#f3f3f3', surface: '#ffffff', fg: '#1f1f1f', muted: '#595959', line: '#dcdcdc',
  key: '#123c75', string: '#2e7d4f', number: '#a14f00', boolean: '#9b47b5', null: '#5c5c5c', punct: '#6b6b6b'
};
const UI = 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

// The snippet: one array per line of [text, color, bold?] pieces.
const p = t => [t, C.punct], k = t => [`"${t}"`, C.key, true], s = t => [`"${t}"`, C.string];
const IND = ['\u00a0\u00a0'];   // the indent (SVG text drops leading spaces)
const SNIPPET = [
  [p('{')],
  [IND, k('name'), p(': '), s('JSON Prettify'), p(',')],
  [IND, k('offline'), p(': '), ['true', C.boolean], p(',')],
  [IND, k('uploads'), p(': '), ['0', C.number], p(',')],
  [IND, k('formats'), p(': ['), s('YAML'), p(', '), s('CSV'), p('],')],
  [IND, k('tracking'), p(': '), ['null', C.null], p('')],
  [p('}')]
];

export function ogSvg() {
  const lx = 80, cardX = 640, cardY = 150, cardW = 480, cardH = 330;
  const code = SNIPPET.map((line, i) => `<text x="${cardX + 36}" y="${cardY + 58 + i * 38}">` +
    line.map(([t, color = C.fg, bold]) => `<tspan fill="${color}"${bold ? ' font-weight="700"' : ''}>${esc(t)}</tspan>`).join('') + '</text>').join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block">
  <rect width="${W}" height="${H}" fill="${C.bg}"/>
  <g transform="translate(${lx} 150) scale(3)">
    <rect x="1" y="1" width="30" height="30" rx="8" fill="${C.fg}"/>
    <path d="${BRACES}" fill="none" stroke="${C.surface}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="16" cy="16" r="1.75" fill="${C.surface}"/>
  </g>
  <text x="${lx}" y="320" font-family="${UI}" font-size="64" font-weight="700" fill="${C.fg}" letter-spacing="-1">JSON Prettify</text>
  <text font-family="${UI}" font-size="28" fill="${C.muted}">
    <tspan x="${lx}" y="378">Beautify, minify, validate and compare</tspan>
    <tspan x="${lx}" y="416">JSON. Everything runs in your browser,</tspan>
    <tspan x="${lx}" y="454">so your data stays on your device.</tspan>
  </text>
  <text x="${lx}" y="540" font-family="${UI}" font-size="22" font-weight="600" fill="${C.fg}">xitas.github.io/json-prettify</text>
  <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="20" fill="${C.surface}" stroke="${C.line}" stroke-width="2"/>
  <g font-family="${MONO}" font-size="24">${code}</g>
</svg>`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [png] = await renderPngs([{ width: W, height: H, html: `<!doctype html><html><body style="margin:0;overflow:hidden">${ogSvg()}</body></html>` }]);
  writeFileSync(join(root, 'og-image.png'), png);
  console.log('og-image.png');
}
