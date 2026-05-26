const CACHE = "recipes-v4";
const SHELL = [
  "/",
  "/index.html",
  "/app.js",
  "/convert.js",
  "/voice-assistant.js",
  "/style.css",
  "/manifest.json",
  "/icons.svg",
  "/icon-launcher.svg",
  "/data/densities.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (url.pathname.startsWith("/api/recipes/") && url.pathname !== "/api/recipes/") {
    event.respondWith(staleWhileRevalidate(event.request));
    return;
  }

  if (url.pathname === "/api/recipes") {
    event.respondWith(networkFirst(event.request));
    return;
  }

  if (SHELL.some((p) => url.pathname === p || url.pathname.endsWith(p))) {
    event.respondWith(cacheFirst(event.request));
  }
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  return cached || fetch(request);
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    const cache = await caches.open(CACHE);
    cache.put(request, response.clone());
    return response;
  } catch {
    return (await caches.match(request)) || new Response("[]", { headers: { "Content-Type": "application/json" } });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached || network;
}
