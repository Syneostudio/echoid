// Hors ligne sur le terrain : après une première ouverture en ligne, toute la présentation (page, scripts, styles,
// logo, vidéos) reste disponible sans réseau.
// Deux copies :
// - la page de cette version (CACHE : page, scripts, styles, police, manifeste, quelques centaines de Ko), gardée à
//   l'installation : une nouvelle version s'installe toujours, en quelques secondes, et remplace aussitôt l'ancienne ;
// - les médias (MEDIAS, la même d'une version à l'autre : un média modifié change toujours de nom, voir films.js),
//   gardés ensuite un par un, sans rien bloquer. Ceux d'une version précédente sont repris sans être retéléchargés.
// Rien ne dépend jamais de la copie : un fichier pas encore gardé (ou que l'appareil refuse de garder, faute de place)
// est lu directement en ligne.
// Changer CACHE à chaque nouvelle version.
const VERSION = 14
const CACHE = `echoid-v${VERSION}`
const MEDIAS = 'echoid-medias'
const PAGE = ['manifest.webmanifest', 'fonts/Michroma-Regular.ttf']
const MEDIA = [
  'media/brand/echoid-loop.mp4',
  'media/brand/echoid-logo-alpha.webp',
  'media/brand/echoid-orb.webp',
  'media/brand/icon-192.png',
  'media/brand/icon-512.png',
  'media/film/echoid-ouverture-restaurant-son-rapide.mp4',
  'media/film/echoid-ouverture-restaurant-debut.jpg',
  'media/film/echoid-ouverture-restaurant-fin.jpg',
  'media/film/echoid-suite-restaurant-son-rapide.mp4',
  'media/film/echoid-suite-restaurant-continu-rapide.mp4',
  'media/film/echoid-suite-restaurant-fin.jpg',
  'media/film/echoid-raccord-calcul.mp4',
  'media/film/echoid-calcul-restaurant.jpg',
  'media/film/echoid-fermeture-restaurant.mp4',
  'media/film/echoid-fermeture-restaurant-fin.jpg',
  'media/film/echoid-interieur-restaurant-rapide.mp4',
  'media/film/echoid-interieur-restaurant-fin.jpg',
]
const EXACT = { ignoreSearch: true, ignoreVary: true }

// Les noms des scripts et styles changent à chaque build : on les lit dans la page.
const assetsOf = html => [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(match => match[1])

// Une version s'installe toujours, même si l'appareil ne peut rien garder (plus de place) : elle laisse alors tout passer
// par le réseau. Une ancienne version, elle, pourrait bloquer la présentation : celle-ci la remplace aussitôt.
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE)
      const response = await fetch('./', { cache: 'no-store' })
      const html = await response.clone().text()
      await cache.put('./', response)
      await cache.addAll([...assetsOf(html), ...PAGE])
    } catch {
      // la page se gardera au fil des ouvertures (fetch, plus bas)
    }
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim())
})

// Les médias, un par un : repris d'une version précédente, sinon téléchargés. Un échec (réseau coupé, place refusée)
// n'arrête rien : le fichier reste lu en ligne, et l'on réessaie à la prochaine ouverture (pas avant 2 minutes).
let keeping = null
let failedAt = 0
function keepMedia() {
  if (keeping) return keeping
  if (Date.now() - failedAt < 120000) return Promise.resolve()
  keeping = (async () => {
    let missing = 0
    const medias = await caches.open(MEDIAS)
    for (const file of MEDIA) {
      if (await medias.match(file, EXACT)) continue
      try {
        const previous = await caches.match(file, EXACT)
        await medias.put(file, previous || await download(file))
      } catch {
        missing += 1
      }
    }
    if (missing) failedAt = Date.now()
    await tidy()
  })().catch(() => { failedAt = Date.now() }).finally(() => { keeping = null })
  return keeping
}

async function download(file) {
  const response = await fetch(file, { cache: 'no-store' })
  if (!response.ok || response.status !== 200) throw new Error(`${file} : ${response.status}`)
  return response
}

// Ménage : des copies des versions précédentes, ne reste que ce qui n'est pas encore repris ; le reste est effacé
// (la place compte sur une tablette). Jamais celle d'une version plus récente en train de s'installer.
const older = name => Number(/^echoid-v(\d+)$/.exec(name)?.[1] ?? Infinity) < VERSION
async function tidy() {
  const wanted = new Set(MEDIA.map(file => new URL(file, self.registration.scope).href))
  const medias = await caches.open(MEDIAS)
  for (const request of await medias.keys()) if (!wanted.has(request.url)) await medias.delete(request)
  for (const name of await caches.keys()) {
    if (!older(name)) continue
    const cache = await caches.open(name)
    for (const request of await cache.keys()) {
      const url = request.url.split('?')[0]
      if (!wanted.has(url) || await medias.match(url, EXACT)) await cache.delete(request)
    }
    if (!(await cache.keys()).length) await caches.delete(name)
  }
}

self.addEventListener('message', event => {
  // La page le demande à chaque ouverture : garder les médias pour le hors ligne.
  if (event.data?.type === 'garder') {
    event.waitUntil(keepMedia())
    return
  }
  // Voyant « prêt hors ligne » du menu : combien de fichiers de cette version sont déjà gardés sur l'appareil.
  if (event.data?.type !== 'etat-hors-ligne' || !event.ports[0]) return
  event.waitUntil(keepMedia())
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE)
      const medias = await caches.open(MEDIAS)
      const page = await cache.match('./', EXACT)
      const files = [...assetsOf(page ? await page.text() : ''), ...PAGE]
      let done = page ? 1 : 0
      for (const file of files) if (await cache.match(file, EXACT)) done += 1
      for (const file of MEDIA) if (await medias.match(file, EXACT)) done += 1
      event.ports[0].postMessage({ done, total: 1 + files.length + MEDIA.length })
    } catch {
      event.ports[0].postMessage({ storage: false })
    }
  })())
})

self.addEventListener('fetch', event => {
  const { request } = event
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return

  // La page : le réseau d'abord (mises à jour), sinon la copie de cette version.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request)
        if (response.ok) {
          const copy = response.clone()
          caches.open(CACHE).then(cache => cache.put('./', copy)).catch(() => {})
        }
        return response
      } catch {
        try {
          return (await (await caches.open(CACHE)).match('./', EXACT)) || Response.error()
        } catch {
          return Response.error()
        }
      }
    })())
    return
  }

  // Le reste : la copie si elle existe (cette version, les médias, sinon une version précédente : même nom = même
  // contenu), sinon directement en ligne, par morceaux si la page le demande. La copie ne bloque jamais la lecture.
  event.respondWith((async () => {
    try {
      const kept = (await (await caches.open(CACHE)).match(request.url, EXACT))
        || (await (await caches.open(MEDIAS)).match(request.url, EXACT))
        || (await caches.match(request.url, EXACT))
      if (kept) return await partial(request, kept)
    } catch {
      // copie illisible ou indisponible : en ligne
    }
    const response = await fetch(request)
    // les petits fichiers de la page (scripts, styles…) se gardent au passage ; les médias, par keepMedia
    if (response.status === 200 && !new URL(request.url).pathname.includes('/media/')) {
      const copy = response.clone()
      caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => {})
    }
    return response
  })())
})

// Safari (iPad) lit les vidéos par morceaux : il exige une réponse 206 à ses requêtes Range.
// Le début d'un film part aussitôt de la copie, sans l'ouvrir en entier : les films ont leur index en tête, la lecture
// commence avec ces premiers octets. Pour les morceaux suivants, le film est ouvert une fois (dès sa première demande,
// en arrière-plan) ; les deux derniers ouverts le restent.
const blobs = new Map()
function opened(url, response) {
  let blob = blobs.get(url)
  if (!blob) {
    blob = response.blob()
    blobs.set(url, blob)
    blob.catch(() => blobs.delete(url))
    if (blobs.size > 2) blobs.delete(blobs.keys().next().value)
  }
  return blob
}

// Les octets 0 à `end` d'une copie, lus depuis son début (sans lire le reste).
async function head(response, end) {
  const reader = response.body.getReader()
  const chunks = []
  let length = 0
  while (length <= end) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    length += value.length
  }
  reader.cancel().catch(() => {})
  return new Blob(chunks).slice(0, end + 1)
}

const OPEN_LIMIT = 8 * 1024 * 1024
async function partial(request, response) {
  const range = request.headers.get('range')
  const match = range && /bytes=(\d*)-(\d*)/.exec(range)
  if (!match) return response
  const size = Number(response.headers.get('Content-Length'))
  const start = Number(match[1] || 0)
  const reply = (body, from, to, total) => new Response(body, {
    status: 206,
    headers: {
      'Content-Type': response.headers.get('Content-Type') || 'application/octet-stream',
      'Content-Range': `bytes ${from}-${to}/${total}`,
      'Content-Length': String(to - from + 1),
      'Accept-Ranges': 'bytes',
    },
  })
  if (start === 0 && size > 0 && !blobs.has(request.url)) {
    caches.match(request.url, EXACT).then(copy => copy && opened(request.url, copy)).catch(() => {})
    if (!match[2]) return reply(response.body, 0, size - 1, size)
    const end = Math.min(Number(match[2]), size - 1)
    if (end < OPEN_LIMIT) return reply(await head(response, end), 0, end, size)
  }
  const blob = await opened(request.url, response)
  const end = Math.min(match[2] ? Number(match[2]) : blob.size - 1, blob.size - 1)
  return reply(blob.slice(start, end + 1), start, end, blob.size)
}
