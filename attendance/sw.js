const appVersion = "1.4";
const cacheName = "attendance-shell-v7";
const scope = new URL("./", self.location.href);
const files = [
  "index.html", "app.js", "store.js",
  "manifest.json", "icon.svg", "../shared/core.js"
].map(path => new URL(path, scope).href);
const indexUrl = files[0];
const appUrl = files[1];
const sharedUrl = files[5];

/* scarica tutta la nuova versione prima di installarla */
self.addEventListener("install", event => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(cacheName);
      await cache.addAll(files.map(url => new Request(url, { cache: "reload" })));
      const page = await cache.match(indexUrl);
      const app = await cache.match(appUrl);
      if (!page || !app) throw new Error("File mancanti");
      const [pageText, appText] = await Promise.all([page.text(), app.text()]);
      if (!pageText.includes(`name="app-version" content="${appVersion}"`) ||
          !appText.includes(`const appVersion = "${appVersion}";`)) {
        throw new Error("Versioni non corrispondenti");
      }
      // Con un'app già installata aspetta la richiesta manuale.
      // Alla prima installazione il browser attiva il worker normalmente.
    } catch (error) {
      await caches.delete(cacheName);
      throw error;
    }
  })());
});

/* conserva il nuovo set completo, elimina solo vecchie cache shell */
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(name => name.startsWith("attendance-shell-") && name !== cacheName)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

/* niente rete per le risorse app già memorizzate */
self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== scope.origin) return;
  const insideApp = url.pathname.startsWith(scope.pathname);
  const sharedFile = url.pathname === new URL(sharedUrl).pathname;
  if (!insideApp && !sharedFile) return;

  // Solo il click manuale può bypassare la shell per leggere la versione online.
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

/* comandi locali: non avviano controlli aggiornamenti */
self.addEventListener("message", event => {
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
      port.postMessage({ appVersion, cacheName, ready: matches.every(Boolean) });
    } catch {
      port.postMessage({ appVersion, cacheName, ready: false });
    }
  })());
});
