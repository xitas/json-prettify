// Makes the app icons (PNG) from the logo (the same SVG artwork as the page header), with
// headless Chrome or Edge. Dev only; the PNG files are committed.
//
//   node scripts/make-icons.mjs        (or: npm run icons)
//
// Set CHROME_PATH if Chrome or Edge is not in a usual place. Writes assets/icons/:
//   icon-192.png, icon-512.png   the logo: a rounded dark square with the braces cut out
//   icon-maskable-512.png        full-bleed square with the braces in the middle (Android
//                                masks it to a circle or squircle; the braces stay inside the
//                                safe zone, the middle 80%)
//   apple-touch-icon.png         180 px, full-bleed (iOS rounds the corners itself)

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderPngs } from './lib/chrome.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'assets', 'icons');

// The logo (see the header in index.html): braces and a dot on a rounded square, 32 x 32.
export const BRACES = 'M13 9h-.5A2.5 2.5 0 0 0 10 11.5v2A2.5 2.5 0 0 1 7.5 16 2.5 2.5 0 0 1 10 18.5v2a2.5 2.5 0 0 0 2.5 2.5h.5M19 9h.5a2.5 2.5 0 0 1 2.5 2.5v2a2.5 2.5 0 0 0 2.5 2.5 2.5 2.5 0 0 0-2.5 2.5v2a2.5 2.5 0 0 1-2.5 2.5H19';
const INK = '#1f1f1f', PAPER = '#ffffff';
export function logoSvg(size, fullBleed, ink = INK, paper = PAPER) {
  const square = fullBleed ? `<rect width="32" height="32" fill="${ink}"/>` : `<rect x="1" y="1" width="30" height="30" rx="8" fill="${ink}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" style="display:block" width="${size}" height="${size}" viewBox="0 0 32 32">${square}` +
    `<path d="${BRACES}" fill="none" stroke="${paper}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<circle cx="16" cy="16" r="1.75" fill="${paper}"/></svg>`;
}
const ICONS = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
  ['apple-touch-icon.png', 180, true]
];

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pngs = await renderPngs(ICONS.map(([, size, fullBleed]) => ({
    width: size, height: size, transparent: true,
    html: `<!doctype html><html><body style="margin:0;overflow:hidden;background:transparent">${logoSvg(size, fullBleed)}</body></html>`
  })));
  mkdirSync(outDir, { recursive: true });
  ICONS.forEach(([name], i) => { writeFileSync(join(outDir, name), pngs[i]); console.log('assets/icons/' + name); });
}
