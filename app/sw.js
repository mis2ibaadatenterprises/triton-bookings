/* Triton service worker — built for auto-update, not for aggressive caching.
   Strategy:
     • HTML, JS, CSS  → network first. A deploy reaches phones on the next open.
     • icons, fonts   → cache first. They rarely change.
     • offline        → last good copy of the shell, so the app opens on a weak lift lobby signal.
   Bump CACHE whenever the shell changes; old caches are deleted on activate. */
var CACHE = "triton-v1";
var SHELL = [
  "./", "./index.html", "./styles.css", "./app.js", "./data.js", "./config.js",
  "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).catch(function () {})
  );
  /* Do not wait for every tab to close before the new version takes over. */
  self.skipWaiting();
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("message", function (e) {
  if (e.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;

  var url = new URL(req.url);

  /* Never cache API or auth traffic — it must always be live. */
  if (url.hostname.indexOf("supabase") > -1) return;

  var isShell = url.origin === location.origin &&
    /\.(html|js|css|webmanifest)$|\/$/.test(url.pathname);

  if (isShell) {
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
        return res;
      }).catch(function () {
        return caches.match(req).then(function (hit) {
          return hit || caches.match("./index.html");
        });
      })
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(function (hit) {
      return hit || fetch(req).then(function (res) {
        if (res.ok && url.origin === location.origin) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
        }
        return res;
      });
    })
  );
});
