const cacheName = "attendance-shell-v2";

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

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(cacheName)
      .then(cache => {
        const requests = files.map(
          url => new Request(url, {
            cache: "reload"
          })
        );

        return cache.addAll(requests);
      })
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
            name.startsWith("attendance-shell-") &&
            name !== cacheName
          )
          .map(name => caches.delete(name))
      );

      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") {
    return;
  }

  const url = new URL(event.request.url);

  if (url.origin !== scope.origin) {
    return;
  }

  const insideApp =
    url.pathname.startsWith(scope.pathname);

  const shared =
    url.pathname ===
    new URL("../shared/core.js", scope).pathname;

  if (!insideApp && !shared) {
    return;
  }

  if (event.request.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cached = await caches.match(
          files[0]
        );

        return cached || fetch(event.request);
      })()
    );

    return;
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(
        event.request
      );

      return cached || fetch(event.request);
    })()
  );
});

self.addEventListener("message", event => {
  if (
    event.data?.type !== "cache-check" ||
    !event.ports[0]
  ) {
    return;
  }

  const port = event.ports[0];

  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(
          cacheName
        );

        const matches = await Promise.all(
          files.map(file => cache.match(file))
        );

        port.postMessage({
          ready: matches.every(Boolean)
        });
      } catch (error) {
        port.postMessage({
          ready: false
        });
      }
    })()
  );
});
