const appVersion = "1.3";
const cacheName = "attendance-shell-v6";

const scope = new URL(
  "./",
  self.location.href
);

const files = [
  "index.html",
  "app.js",
  "store.js",
  "manifest.json",
  "icon.svg",
  "../shared/core.js"
].map(path => new URL(path, scope).href);

const indexUrl = files[0];
const appUrl = files[1];

const sharedUrl = new URL(
  "../shared/core.js",
  scope
).href;

/* installazione */

self.addEventListener("install", event => {
  event.waitUntil(
    (async () => {
      const previousCaches =
        await caches.keys();

      const migratingFromOldVersion =
        previousCaches.some(name =>
          /^attendance-shell-v[1-5]$/.test(name)
        );

      try {
        const cache =
          await caches.open(cacheName);

        const requests = files.map(
          url => new Request(url, {
            cache: "reload"
          })
        );

        await cache.addAll(requests);

        const page =
          await cache.match(indexUrl);

        const app =
          await cache.match(appUrl);

        if (!page || !app) {
          throw new Error(
            "File aggiornamento incompleti"
          );
        }

        const pageText =
          await page.text();

        const appText =
          await app.text();

        const correctPage =
          pageText.includes(
            `Attendance Center · versione ${appVersion}`
          );

        const correctApp =
          appText.includes(
            `const appVersion = "${appVersion}";`
          );

        if (!correctPage || !correctApp) {
          throw new Error(
            "Versioni dei file non corrispondenti"
          );
        }

        /*
         * Migrazione iniziale dalla vecchia PWA.
         *
         * Le versioni successive resteranno
         * in attesa del comando manuale.
         */

        if (migratingFromOldVersion) {
          await self.skipWaiting();
        }

      } catch (error) {
        await caches.delete(cacheName);
        throw error;
      }
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

/* risorse offline */

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
    new URL(sharedUrl).pathname;

  if (!insideApp && !sharedFile) {
    return;
  }

  event.respondWith(
    (async () => {
      const cache =
        await caches.open(cacheName);

      if (request.mode === "navigate") {
        const page =
          await cache.match(indexUrl);

        return page || fetch(request);
      }

      const pathnameUrl =
        new URL(url.pathname, scope.origin).href;

      const cached =
        await cache.match(pathnameUrl);

      return cached || fetch(request);
    })()
  );
});

/* comunicazione con la schermata */

self.addEventListener("message", event => {
  const type = event.data?.type;

  if (type === "activate-update") {
    event.waitUntil(
      self.skipWaiting()
    );

    return;
  }

  if (
    type !== "app-status" ||
    !event.ports[0]
  ) {
    return;
  }

  const port = event.ports[0];

  event.waitUntil(
    (async () => {
      try {
        const cache =
          await caches.open(cacheName);

        const matches = await Promise.all(
          files.map(file => cache.match(file))
        );

        port.postMessage({
          appVersion,
          cacheName,
          ready: matches.every(Boolean)
        });

      } catch {
        port.postMessage({
          appVersion,
          cacheName,
          ready: false
        });
      }
    })()
  );
});
