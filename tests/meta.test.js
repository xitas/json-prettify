// Checks the page's link-preview tags, structured data, robots.txt and sitemap.xml.
// Run with: node --test

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SITE = 'https://xitas.github.io/json-prettify/';
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const meta = attr => {
  const m = new RegExp(`<meta (?:property|name)="${attr}" content="([^"]*)"`).exec(html);
  return m && m[1];
};

test('link previews: Open Graph and Twitter tags, with the full image address', () => {
  assert.equal(meta('og:type'), 'website');
  assert.equal(meta('og:url'), SITE);
  assert.ok(meta('og:title'));
  assert.ok(meta('og:description'));
  assert.equal(meta('og:image'), SITE + 'og-image.png');
  assert.equal(meta('og:image:width'), '1200');
  assert.equal(meta('og:image:height'), '630');
  assert.ok(meta('og:image:alt'));
  assert.equal(meta('twitter:card'), 'summary_large_image');
  assert.equal(meta('twitter:image'), SITE + 'og-image.png');
  assert.match(html, new RegExp(`<link rel="canonical" href="${SITE}">`));
});

test('og-image.png exists and is 1200 x 630', () => {
  const png = fs.readFileSync(path.join(ROOT, 'og-image.png'));
  assert.equal(png.toString('ascii', 1, 4), 'PNG');
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
});

test('structured data is valid JSON describing the WebApplication', () => {
  const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, 'no JSON-LD block');
  const data = JSON.parse(m[1]);
  assert.equal(data['@context'], 'https://schema.org');
  assert.equal(data['@type'], 'WebApplication');
  assert.equal(data.url, SITE);
  assert.equal(data.name, 'JSON Prettify');
});

test('robots.txt points to the sitemap, which lists the site', () => {
  const robots = fs.readFileSync(path.join(ROOT, 'robots.txt'), 'utf8');
  assert.match(robots, new RegExp(`^Sitemap: ${SITE}sitemap\\.xml$`, 'm'));
  const sitemap = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
  assert.match(sitemap, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(sitemap, new RegExp(`<loc>${SITE}</loc>`));
});
