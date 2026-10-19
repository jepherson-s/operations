const cacheName = "core-shell-v1";

const appFiles = [
  "./index.html",
  "./manifest.json",
  "./icon.svg"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(cacheName)
      .then(cache => cache.addAll(appFiles))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();

      await Promise.all(
        names
          .filter(name =>
            name.startsWith("core-shell-") &&
            name !== cacheName
          )
          .map(name => caches.delete(name))
      );

      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;

  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  const scope = new URL("./", self.location.href);

  if (
    url.origin !== scope.origin ||
    !url.pathname.startsWith(scope.pathname)
  ) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(cacheName);
        const saved = await cache.match("./index.html");

        if (saved) {
          return saved;
        }

        return fetch(request);
      })()
    );

    return;
  }

  event.respondWith(
    (async () => {
      const saved = await caches.match(request);

      if (saved) {
        return saved;
      }

      return fetch(request);
    })()
  );
});
