const appVersion = "1.4.1";
const cacheName = "attendance-shell-v8";
const scope = new URL("./", self.location.href);
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
const sharedUrl = files[5];

/* Cache completa prima di installare. Nessun reset dei dati locali. */
self.addEventListener("install", event => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(cacheName);
      await cache.addAll(files.map(url => new Request(url, {
        cache: "reload"
      })));
      const [page, app] = await Promise.all([
        cache.match(indexUrl),
        cache.match(appUrl)
      ]);
      if (!page || !app) throw new Error("File mancanti");
      const [pageText, appText] = await Promise.all([
        page.text(), app.text()
      ]);
      if (!pageText.includes(`name="app-version" content="${appVersion}"`) ||
          !appText.includes(`const appVersion = "${appVersion}";`)) {
        throw new Error("Versioni dei file non corrispondenti");
      }
      // Gli aggiornamenti installati restano in attesa del click manuale.
      // Alla prima installazione il browser attiva normalmente il worker.
    } catch (error) {
      await caches.delete(cacheName);
      throw error;
    }
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(name => name.startsWith("attendance-shell-") && name !== cacheName)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

/* Cache-first: la shell funziona senza connessione. */
self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== scope.origin) return;
  const insideApp = url.pathname.startsWith(scope.pathname);
  const sharedFile = url.pathname === new URL(sharedUrl).pathname;
  if (!insideApp && !sharedFile) return;

  // Solo l'azione esplicita di verifica legge la versione online.
  if (url.searchParams.has("manual-update")) {
    event.respondWith(fetch(request));
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    if (request.mode === "navigate") {
      return (await cache.match(indexUrl)) || fetch(request);
    }
    const normalized = new URL(url.pathname, scope.origin).href;
    return (await cache.match(normalized)) || fetch(request);
  })());
});

/* Stato locale e attivazione solo su richiesta esplicita. */
self.addEventListener("message", event => {
  if (event.data?.type === "repair-shell" && event.ports[0]) {
    const port = event.ports[0];
    event.waitUntil((async () => {
      try {
        const cache = await caches.open(cacheName);
        const missing = [];
        for (const url of files) {
          if (!(await cache.match(url))) missing.push(url);
        }
        if (missing.length) {
          await cache.addAll(missing.map(url => new Request(url, {
            cache: "reload"
          })));
        }
        const matches = await Promise.all(files.map(url => cache.match(url)));
        port.postMessage({ ready: matches.every(Boolean) });
      } catch {
        port.postMessage({ ready: false });
      }
    })());
    return;
  }
  if (event.data?.type === "activate-update") {
    event.waitUntil(self.skipWaiting());
    return;
  }
  if (event.data?.type !== "app-status" || !event.ports[0]) return;
  const port = event.ports[0];
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(cacheName);
      const matches = await Promise.all(files.map(url => cache.match(url)));
      port.postMessage({
        appVersion, cacheName, ready: matches.every(Boolean)
      });
    } catch {
      port.postMessage({ appVersion, cacheName, ready: false });
    }
  })());
});
