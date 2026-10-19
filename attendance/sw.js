const cacheName = "attendance-shell-v4";

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
      const cache = await caches.open(
        cacheName
      );

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
            name.startsWith(
              "attendance-shell-"
            ) &&
            name !== cacheName
          )
          .map(name => caches.delete(name))
      );

      await self.clients.claim();
    })()
  );
});

/* gestione richieste */

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
    url.pathname.startsWith(
      scope.pathname
    );

  const sharedFile =
    url.pathname ===
    new URL(
      "../shared/core.js",
      scope
    ).pathname;

  if (!insideApp && !sharedFile) {
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(
        cacheName
      );

      if (request.mode === "navigate") {
        const page = await cache.match(
          files[0]
        );

        if (page) {
          return page;
        }

        return fetch(request);
      }

      const cached = await cache.match(
        request
      );

      if (cached) {
        return cached;
      }

      return fetch(request);
    })()
  );
});

/* verifica cache */

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
          ready: matches.every(Boolean),
          cacheName
        });

      } catch (error) {
        port.postMessage({
          ready: false,
          cacheName
        });
      }
    })()
  );
});
