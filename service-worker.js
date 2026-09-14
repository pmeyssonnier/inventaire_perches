/* Service worker de l'inventaire des perches.
 *
 * L'application sert sur le terrain, souvent sans réseau : toute la coquille
 * est donc pré-chargée, polices comprises, et aucune ressource n'est servie
 * depuis un domaine tiers.
 */

/* Remplacé par le SHA du commit lors du déploiement (voir deploy-pages.yml).
 * Chaque déploiement obtient ainsi un cache neuf sans intervention manuelle. */
const BUILD_ID = 'dev';
const CACHE_NAME = `perches-inventaire-${BUILD_ID}`;

const APP_SHELL = [
  './',
  'index.html',
  'app.js',
  'styles.css',
  'manifest.webmanifest',
  'icons/logo.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/favicon-32.png',
  'fonts/inter-400.woff2',
  'fonts/inter-500.woff2',
  'fonts/inter-600.woff2',
  'fonts/inter-700.woff2',
  'fonts/roboto-slab-700.woff2'
];

const OFFLINE_FALLBACK = new Response(
  'Ressource indisponible hors connexion.',
  { status: 503, statusText: 'Service Unavailable', headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
);

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL.map(url => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

/* L'écriture dans le cache est confiée à event.waitUntil : détachée, elle peut
 * être interrompue par l'arrêt du service worker avant d'avoir abouti. */
function cacheResponse(event, request, response) {
  const copy = response.clone();
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(request, copy)));
}

async function handleNavigate(event) {
  try {
    const response = await fetch(event.request);
    if (response && response.ok) cacheResponse(event, event.request, response);
    return response;
  } catch (error) {
    const cache = await caches.open(CACHE_NAME);
    return (await cache.match(event.request))
      || (await cache.match('index.html'))
      || (await cache.match('./'))
      || OFFLINE_FALLBACK.clone();
  }
}

/* Cache d'abord, rafraîchissement en arrière-plan : la page s'affiche
 * instantanément, et une version déployée depuis atteint quand même
 * l'application déjà installée. */
async function handleAsset(event) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(event.request);
  const network = fetch(event.request)
    .then(response => {
      if (response && response.ok) cacheResponse(event, event.request, response);
      return response;
    })
    .catch(() => null);

  if (cached) {
    event.waitUntil(network);
    return cached;
  }
  /* Rien en cache : on attend le réseau, et on garantit une réponse même
   * lorsqu'il échoue — respondWith(undefined) provoquerait une erreur réseau. */
  return (await network) || OFFLINE_FALLBACK.clone();
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigate(event));
    return;
  }
  event.respondWith(handleAsset(event));
});
