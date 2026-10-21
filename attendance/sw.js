
const appVersion = "1.5";
const cacheName = "attendance-shell-v9";
const scope = new URL("./", self.location.href);

const requiredFiles = [
  "index.html",
  "app.js",
  "store.js",
  "icon.svg",
  "../shared/core.js"
].map(path => new URL(path, scope).href);

const optionalFiles = [
  "manifest.json"
].map(path => new URL(path, scope).href);

const indexUrl = requiredFiles[0];
const appUrl = requiredFiles[1];
const sharedPath = new URL(
  requiredFiles[4]
).pathname;

/* controlla che la cache sia completa */

async function shellStatus() {
  const cache = await caches.open(cacheName);

  const matches = await Promise.all(
    requiredFiles.map(url => cache.match(url))
  );

  if (!matches.every(Boolean)) {
    return {
      appVersion,
      cacheName,
      ready: false
    };
  }

  const page = await cache.match(indexUrl);
  const app = await cache.match(appUrl);

  const [html, source] = await Promise.all([
    page.text(),
    app.text()
  ]);

  const ready =
    html.includes(
      `name="app-version" content="${appVersion}"`
    ) &&
    source.includes(
      `const appVersion = "${appVersion}";`
    );

  return {
    appVersion,
    cacheName,
    ready
  };
}

/* installazione completa e sicura */

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(cacheName);

      await cache.addAll(
        requiredFiles.map(url => new Request(url, {
          cache: "reload"
        }))
      );

      const status = await shellStatus();

      if (!status.ready) {
        throw new Error(
          "Versioni dei file non corrispondenti"
        );
      }

      // il manifest non deve bloccare
      // la conservazione della shell offline
      for (const url of optionalFiles) {
        try {
          await cache.add(
            new Request(url, { cache: "reload" })
          );
        } catch {
          // il file opzionale non blocca
          // l'installazione dei file principali
        }
      }

      // nessuno skipwaiting automatico:
      // l'attivazione avviene tramite il pulsante

    } catch (error) {
      await caches.delete(cacheName);
      throw error;
    }
  })());
});

/* attivazione */

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
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
  })());
});

/* utilizzo offline */

self.addEventListener("fetch", event => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (url.origin !== scope.origin) return;

  const insideApp =
    url.pathname.startsWith(scope.pathname);

  const sharedFile =
    url.pathname === sharedPath;

  if (!insideApp && !sharedFile) return;

  // il controllo esplicito della versione
  // deve leggere sempre il server
  if (url.searchParams.has("manual-update")) {
    event.respondWith(fetch(request));
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(cacheName);

    if (request.mode === "navigate") {
      const cached = await cache.match(indexUrl);
      return cached || fetch(request);
    }

    const normalized = new URL(
      url.pathname,
      url.origin
    ).href;

    const cached = await cache.match(normalized);

    return cached || fetch(request);
  })());
});

/* messaggi dal center */

self.addEventListener("message", event => {
  const type = event.data?.type;

  if (type === "activate-update") {
    event.waitUntil(self.skipWaiting());
    return;
  }

  if (
    !["app-status", "repair-shell"].includes(type) ||
    !event.ports?.[0]
  ) return;

  const port = event.ports[0];

  event.waitUntil((async () => {
    try {
      if (type === "repair-shell") {
        const cache = await caches.open(cacheName);
        const missing = [];

        for (const url of requiredFiles) {
          if (!(await cache.match(url))) {
            missing.push(url);
          }
        }

        if (missing.length) {
          await cache.addAll(
            missing.map(url => new Request(url, {
              cache: "reload"
            }))
          );
        }
      }

      const status = await shellStatus();
      port.postMessage(status);

    } catch {
      port.postMessage({
        appVersion,
        cacheName,
        ready: false
      });
    }
  })());
});
