/**
 * The service worker, hand-written and committed.
 *
 * Two caches, deliberately separate:
 *   station-shell-v1  the app itself, so it boots with no network
 *   station-audio-v1  the tracks, so a dropped connection does not kill playback
 *
 * Audio is cache-first and never revalidated: a wav at a given URL does not
 * change, and a client on patchy signal should never wait on the network for
 * something it already has on disk.
 */

const VERSION = "v1"
const SHELL_CACHE = `station-shell-${VERSION}`
const AUDIO_CACHE = `station-audio-${VERSION}`

const SHELL_ASSETS = [
	"/",
	"/index.html",
	"/styles.css",
	"/app.js",
	"/audio-engine.js",
	"/lib/sync/clock.js",
	"/audio/tracks.json",
]

self.addEventListener("install", (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(SHELL_CACHE)
			// Added one at a time: cache.addAll rejects the whole install if any single
			// request 404s, which would leave the app with no worker at all.
			await Promise.all(
				SHELL_ASSETS.map(async (url) => {
					try {
						await cache.add(new Request(url, { cache: "reload" }))
					} catch (error) {
						console.warn("[sw] could not precache", url, error)
					}
				}),
			)
			await self.skipWaiting()
		})(),
	)
})

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			const keys = await caches.keys()
			await Promise.all(
				keys
					.filter((key) => key.startsWith("station-") && key !== SHELL_CACHE && key !== AUDIO_CACHE)
					.map((key) => caches.delete(key)),
			)
			await self.clients.claim()
		})(),
	)
})

/** Audio assets, by folder or by extension. */
function isAudioRequest(url) {
	if (url.pathname.startsWith("/audio/") && !url.pathname.endsWith(".json")) return true
	return /[.](wav|mp3|m4a|ogg|opus|flac)$/i.test(url.pathname)
}

/**
 * Serve a byte range out of a cached response.
 *
 * Browsers ask for audio with Range headers. A cached 200 handed back to a Range
 * request makes some of them refuse to play, so slice it into a real 206.
 */
async function sliceResponse(response, rangeHeader) {
	const buffer = await response.arrayBuffer()
	const total = buffer.byteLength
	const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader)
	if (!match) return new Response(buffer, { status: 200, headers: response.headers })

	const start = match[1] ? Number(match[1]) : 0
	const end = match[2] ? Number(match[2]) : total - 1
	const slice = buffer.slice(start, end + 1)

	const headers = new Headers(response.headers)
	headers.set("Content-Range", `bytes ${start}-${end}/${total}`)
	headers.set("Content-Length", String(slice.byteLength))
	headers.set("Accept-Ranges", "bytes")
	return new Response(slice, { status: 206, statusText: "Partial Content", headers })
}

/** Cache-first. This is the line that keeps music playing when the socket dies. */
async function serveAudio(request) {
	const cache = await caches.open(AUDIO_CACHE)
	const cached = await cache.match(request.url, { ignoreSearch: true })
	const range = request.headers.get("range")

	if (cached) {
		return range ? sliceResponse(cached.clone(), range) : cached.clone()
	}

	try {
		// Fetch the whole file, not the requested range, so the copy we keep is complete.
		const fresh = await fetch(new Request(request.url, { mode: "cors", credentials: "omit" }))
		if (fresh.ok && fresh.status === 200) {
			await cache.put(request.url, fresh.clone())
			return range ? sliceResponse(fresh.clone(), range) : fresh
		}
		return fresh
	} catch (error) {
		return new Response("Audio unavailable offline", { status: 504, statusText: "Offline" })
	}
}

/** Network-first, so a deploy is picked up, with the cache as the safety net. */
async function serveShell(request) {
	const cache = await caches.open(SHELL_CACHE)
	try {
		const fresh = await fetch(request)
		if (fresh.ok) await cache.put(request, fresh.clone())
		return fresh
	} catch (error) {
		const cached = await cache.match(request, { ignoreSearch: true })
		if (cached) return cached
		if (request.mode === "navigate") {
			const shell = await cache.match("/index.html")
			if (shell) return shell
		}
		return new Response("Offline", { status: 503, statusText: "Offline" })
	}
}

self.addEventListener("fetch", (event) => {
	const request = event.request
	if (request.method !== "GET") return

	const url = new URL(request.url)
	if (url.origin !== self.location.origin) return
	// Station state is live by definition; caching it would hand back a stale
	// timeline and put a reconnecting client in the wrong place in the track.
	if (url.pathname.startsWith("/api/")) return

	event.respondWith(isAudioRequest(url) ? serveAudio(request) : serveShell(request))
})

/** The page asks for the rest of the playlist to be pulled down in the background. */
self.addEventListener("message", (event) => {
	const data = event.data ?? {}

	if (data.type === "cache-audio" && Array.isArray(data.urls)) {
		event.waitUntil(
			(async () => {
				const cache = await caches.open(AUDIO_CACHE)
				for (const url of data.urls) {
					if (await cache.match(url, { ignoreSearch: true })) continue
					try {
						const response = await fetch(url)
						if (response.ok) await cache.put(url, response.clone())
					} catch (error) {
						// Offline mid-prefetch is fine; whatever landed is still cached.
					}
				}
				const keys = await cache.keys()
				event.source?.postMessage({ type: "cache-status", cachedAudio: keys.length })
			})(),
		)
	}

	if (data.type === "cache-status") {
		event.waitUntil(
			(async () => {
				const cache = await caches.open(AUDIO_CACHE)
				const keys = await cache.keys()
				event.source?.postMessage({ type: "cache-status", cachedAudio: keys.length })
			})(),
		)
	}
})
