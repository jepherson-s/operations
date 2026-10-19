const cacheName = "attendance-shell-v5";

const scope = new URL(
  "./",
  self.location.href
);

const files = [
  new URL("index.html", scope).href,
  new URL("manifest.json", scope).href,
  new URL("icon.svg", scope).href,
  new URL("app.js", scope).href,
  new URL("store.js", scope).href,
  new URL("../shared/core.js", scope).href
];

/* installazione */

self.addEventListener("install", event => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(cacheName);

      const requests = files.map(
        url => new Request(url, {
          cache: "reload"
        })
      );

      await cache.addAll(requests);
      await self.skipWaiting();
    })()
  );
});

/* attivazione */

self.addEventListener("activate", event => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();

      await Promise.all(
        names
          .filter(name =>
            name.startsWith("attendance-shell-") &&
            name !== cacheName
          )
          .map(name => caches.delete(name))
      );

      await self.clients.claim();
    })()
  );
});

/* richieste */

self.addEventListener("fetch", event => {
  const request = event.request;

  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);

  if (url.origin !== scope.origin) {
    return;
  }

  const insideApp =
    url.pathname.startsWith(scope.pathname);

  const sharedFile =
    url.pathname ===
    new URL("../shared/core.js", scope).pathname;

  if (!insideApp && !sharedFile) {
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(cacheName);

      if (request.mode === "navigate") {
        const page = await cache.match(files[0]);

        return page || fetch(request);
      }

      const cached = await cache.match(request);

      return cached || fetch(request);
    })()
  );
});
