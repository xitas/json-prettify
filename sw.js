/*
 * Service worker: keeps JSON Prettify's own files, so the page works offline after the first
 * visit (it never stores anyone's JSON). Registered by app.js over https or on localhost.
 *
 * The list of files below, with a hash of each file's contents, is written by
 * scripts/build-sw.mjs (npm run build-sw); a unit test fails if a file changed without it.
 * A new list makes a new cache version: the page then offers "A new version is available.
 * Reload", and the new version only takes over when the person chooses to reload.
 */
'use strict';

// <files> written by scripts/build-sw.mjs; do not edit by hand
var VERSION = "51551abf6dc6";
var FILES = {
  "index.html": "91fc87dc160d416d",
  "manifest.webmanifest": "ac9f07dfec5bce3d",
  "assets/css/style.css": "5e01121a47706a7e",
  "assets/js/app.js": "bf67cfb328c894ca",
  "assets/js/code-view.js": "81d2b85b5b50bc00",
  "assets/js/compare.js": "3f2268722f6bbe6a",
  "assets/js/doc-input.js": "6bd3a5f5b0d50228",
  "assets/js/json-tools.js": "60bc1b8eba302c29",
  "assets/js/schema.js": "138910b3310076cb",
  "assets/icons/apple-touch-icon.png": "67f3c262c0eeba7a",
  "assets/icons/icon-192.png": "95d3868b35bcac3c",
  "assets/icons/icon-512.png": "e192004c877cff1d",
  "assets/icons/icon-maskable-512.png": "23949c2a54f5cc40"
};
// </files>

var PREFIX = 'json-prettify-';
var CACHE = PREFIX + VERSION;
var SCOPE = self.registration.scope;   // https://.../json-prettify/
var INDEX = SCOPE + 'index.html';

self.addEventListener('install', function (event) {
  // Each file is fetched fresh (its hash in the query string gets past HTTP caches) and
  // stored under its plain address.
  event.waitUntil(caches.open(CACHE).then(function (cache) {
    return Promise.all(Object.keys(FILES).map(function (file) {
      return fetch(new Request(SCOPE + file + '?h=' + FILES[file], { cache: 'no-cache' })).then(function (response) {
        if (!response.ok) throw new Error('Could not fetch ' + file);
        return cache.put(SCOPE + file, response);
      });
    }));
  }));
});

self.addEventListener('activate', function (event) {
  // Old versions' caches go; this version starts serving the open pages.
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf(PREFIX) === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

// The page asks the waiting version to take over (after the person clicked Reload).
self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin || url.href.indexOf(SCOPE) !== 0) return;
  // The page itself (any address in the scope, with any query or hash): the kept index.html.
  // Files: the kept copy. Anything not kept goes to the network as usual.
  var key = req.mode === 'navigate' ? INDEX : url.origin + url.pathname;
  event.respondWith(caches.open(CACHE).then(function (cache) {
    return cache.match(key);
  }).then(function (kept) {
    return kept || fetch(req);
  }));
});
