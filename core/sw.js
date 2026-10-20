
const appVersion = "1.6";
const cacheName = "core-shell-v8";
const scope = new URL("./", self.location.href);
const shellFiles = [
  "index.html",
  "manifest.json",
  "icon.svg",
  "../shared/core.js"
].map(path => new URL(path, scope).href);
const indexUrl = shellFiles[0];
const sharedPath = new URL(shellFiles[3]).pathname;

/* salva una versione completa prima dell'attivazione */
self.addEventListener("install", event => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(cacheName);
      await cache.addAll(shellFiles.map(url => new Request(url, {
        cache: "reload"
      })));
      const page = await cache.match(indexUrl);
      if (!page) throw new Error("pagina mancante");
      const html = await page.text();
      if (!html.includes(`name="app-version" content="${appVersion}"`) ||
          !html.includes(`const appVersion = "${appVersion}";`)) {
        throw new Error("versioni non corrispondenti");
      }
      const matches = await Promise.all(shellFiles.map(url => cache.match(url)));
      if (!matches.every(Boolean)) throw new Error("cache incompleta");

      // solo la prima migrazione dalla v1.5 richiede attivazione immediata:
      // la vecchia interfaccia non possiede il pulsante pubblico.
      const names = await caches.keys();
      if (names.includes("core-shell-v7")) await self.skipWaiting();
    } catch (error) {
      await caches.delete(cacheName);
      throw error;
    }
  })());
});

/* rimuove soltanto le precedenti cache dell'interfaccia */
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(name => name.startsWith("core-shell-") && name !== cacheName)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

/* interfaccia dalla cache, versione online soltanto su click */
self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== scope.origin) return;
  const insideCore = url.pathname.startsWith(scope.pathname);
  const sharedFile = url.pathname === sharedPath;
  if (!insideCore && !sharedFile) return;

  if (url.searchParams.has("manual-update")) {
    event.respondWith(fetch(request));
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    if (request.mode === "navigate") {
      return (await cache.match(indexUrl)) || fetch(request);
    }
    const normalized = new URL(url.pathname, url.origin).href;
    return (await cache.match(normalized)) || fetch(request);
  })());
});

/* comandi locali del service worker */
self.addEventListener("message", event => {
  const type = event.data?.type;
  if (type === "activate-update") {
    event.waitUntil(self.skipWaiting());
    return;
  }
  if (!["app-status", "cache-check", "repair-shell"].includes(type) || !event.ports[0]) {
    return;
  }
  const port = event.ports[0];
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(cacheName);
      if (type === "repair-shell") {
        const missing = [];
        for (const file of shellFiles) {
          if (!(await cache.match(file))) missing.push(file);
        }
        if (missing.length) {
          await cache.addAll(missing.map(url => new Request(url, {
            cache: "reload"
          })));
        }
      }
      const files = await Promise.all(shellFiles.map(file => cache.match(file)));
      const page = await cache.match(indexUrl);
      const html = page ? await page.text() : "";
      const ready = files.every(Boolean) &&
        html.includes(`name="app-version" content="${appVersion}"`) &&
        html.includes(`const appVersion = "${appVersion}";`);
      port.postMessage({ appVersion, cacheName, ready });
    } catch {
      port.postMessage({ appVersion, cacheName, ready: false });
    }
  })());
});
