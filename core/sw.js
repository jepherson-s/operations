const cacheName = "core-shell-v5";

const scope = new URL(
  "./",
  self.location.href
);

const shellFiles = [
  new URL("index.html", scope).href,
  new URL("manifest.json", scope).href,
  new URL("icon.svg", scope).href,
  new URL("../shared/core.js", scope).href
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(cacheName)
      .then(cache => {
        const requests = shellFiles.map(
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

  if (url.origin !== scope.origin) {
    return;
  }

  const insideCore =
    url.pathname.startsWith(scope.pathname);

  const sharedFile =
    url.pathname ===
    new URL("../shared/core.js", scope).pathname;

  if (!insideCore && !sharedFile) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cached = await caches.match(
          shellFiles[0]
        );

        return cached || fetch(request);
      })()
    );

    return;
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      return cached || fetch(request);
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
        const cache = await caches.open(cacheName);

        const files = await Promise.all(
          shellFiles.map(file => cache.match(file))
        );

        port.postMessage({
          ready: files.every(Boolean)
        });
      } catch (error) {
        port.postMessage({
          ready: false
        });
      }
    })()
  );
});
