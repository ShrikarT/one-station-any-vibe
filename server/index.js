/**
 * The station server.
 *
 * Two jobs, and deliberately no more:
 *   1. be the clock — every station's startedAt is on this process's Date.now()
 *   2. tell whoever is listening what that clock says
 *
 * node:http for static files and a small JSON API, ws for the live channel. No
 * framework: the whole point of this problem is timing, and every layer between
 * the socket and the timestamp is a place for that timing to get lost.
 */

import { createReadStream, existsSync, readFileSync, statSync } from "node:fs"
import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import { dirname, join, normalize, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

import { WebSocketServer } from "ws"

import { StationRegistry } from "./stations.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = resolve(HERE, "..", "public")

const PORT = Number(process.env.PORT ?? 3000)
/** Ping every client this often; anything that misses two rounds is gone. */
const HEARTBEAT_MS = 15_000
const EMPTY_STATION_TTL_MS = 10 * 60 * 1000
/** ws.OPEN, without importing the constant. */
const OPEN = 1

const MIME = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".wav": "audio/wav",
	".mp3": "audio/mpeg",
	".m4a": "audio/mp4",
	".ogg": "audio/ogg",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".webmanifest": "application/manifest+json",
	".txt": "text/plain; charset=utf-8",
}

function loadTracks() {
	const manifestPath = join(PUBLIC_DIR, "audio", "tracks.json")
	if (!existsSync(manifestPath)) {
		console.warn("[boot] no public/audio/tracks.json — run: npm run audio")
		return []
	}
	try {
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
		const tracks = Array.isArray(manifest.tracks) ? manifest.tracks : []
		console.log(`[boot] ${tracks.length} tracks loaded`)
		return tracks
	} catch (error) {
		console.error("[boot] tracks.json is not readable:", error.message)
		return []
	}
}

const registry = new StationRegistry(loadTracks())

// ---------------------------------------------------------------------------
// Join and leave are logged distinctly, from the events the registry emits.
// ---------------------------------------------------------------------------

registry.on("station:created", ({ id, name }) => {
	console.log(`[station:created] id=${id} name="${name}"`)
})

registry.on("station:closed", ({ stationId, name }) => {
	console.log(`[station:closed] id=${stationId} name="${name}" (nobody listening)`)
})

registry.on("join", (event) => {
	console.log(
		`[station:join] station=${event.stationId} client=${event.clientId} label="${event.label}" listeners=${event.listeners}`,
	)
})

registry.on("leave", (event) => {
	console.log(
		`[station:leave] station=${event.stationId} client=${event.clientId} reason="${event.reason}" listenedFor=${Math.round(event.listenedForMs / 1000)}s listeners=${event.listeners}`,
	)
})

registry.on("advance", (stationId) => {
	const station = registry.get(stationId)
	if (!station) return
	console.log(`[station:advance] station=${stationId} track="${station.currentTrack?.title}"`)
	broadcast(station, "advance")
})

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

function send(socket, payload) {
	if (!socket || socket.readyState !== OPEN) return
	try {
		socket.send(JSON.stringify(payload))
	} catch (error) {
		console.warn("[socket:error] send failed:", error.message)
	}
}

/** Everyone in this station, and nobody else. */
function broadcast(station, reason) {
	const snapshot = station.snapshot()
	for (const member of registry.membersOf(station)) {
		send(member.socket, { type: "station:state", reason, snapshot })
	}
}

function sendJson(res, status, body) {
	const text = JSON.stringify(body)
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(text),
		"cache-control": "no-store",
	})
	res.end(text)
}

function readBody(req) {
	return new Promise((resolvePromise, reject) => {
		const chunks = []
		let size = 0
		req.on("data", (chunk) => {
			size += chunk.length
			if (size > 64 * 1024) {
				reject(new Error("body too large"))
				req.destroy()
				return
			}
			chunks.push(chunk)
		})
		req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")))
		req.on("error", reject)
	})
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

function serveStatic(req, res, pathname) {
	const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "")
	const target = normalize(join(PUBLIC_DIR, relative))

	// Never serve anything outside public/, whatever the path claims to be.
	if (!target.startsWith(PUBLIC_DIR + sep) && target !== PUBLIC_DIR) {
		res.writeHead(404).end("Not found")
		return
	}

	if (existsSync(target) && statSync(target).isFile()) {
		const extension = target.slice(target.lastIndexOf("."))
		const headers = { "content-type": MIME[extension] ?? "application/octet-stream" }
		// Audio never changes at a given URL, so let both the browser and the service
		// worker keep it forever. Everything else must be able to change on deploy.
		headers["cache-control"] = extension === ".wav" ? "public, max-age=31536000, immutable" : "no-cache"
		headers["accept-ranges"] = "bytes"
		res.writeHead(200, headers)
		createReadStream(target).pipe(res)
		return
	}

	// Deep links like /s/hill%20road%20dhaba are the app, not files. Gated on Accept
	// so a genuinely missing script 404s instead of silently receiving HTML — which
	// is exactly how a broken import once looked like a working one.
	const wantsHtml = String(req.headers.accept ?? "").includes("text/html")
	if (wantsHtml && existsSync(join(PUBLIC_DIR, "index.html"))) {
		const html = readFileSync(join(PUBLIC_DIR, "index.html"))
		res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-cache" })
		res.end(html)
		return
	}

	res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found")
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
	try {
		// Split rather than new URL: no host guessing, no throwing on odd paths.
		const pathname = (req.url ?? "/").split("?")[0]

		// The clock, on its own, in one round trip. A client whose socket is dead but
		// whose network is back can re-measure its offset from here.
		if (pathname === "/api/time") {
			sendJson(res, 200, { serverNow: Date.now() })
			return
		}

		if (pathname === "/api/tracks") {
			sendJson(res, 200, { tracks: registry.tracks })
			return
		}

		if (pathname === "/api/stations" && req.method === "GET") {
			sendJson(res, 200, { stations: registry.list(), serverNow: Date.now() })
			return
		}

		// Create or join by name. There is no list of allowed names.
		if (pathname === "/api/stations" && req.method === "POST") {
			if (registry.tracks.length === 0) {
				sendJson(res, 503, { error: "no-tracks-generated", hint: "run: npm run audio" })
				return
			}
			let payload
			try {
				payload = JSON.parse((await readBody(req)) || "{}")
			} catch (error) {
				sendJson(res, 400, { error: "invalid-json" })
				return
			}
			const name = String(payload.name ?? "").trim()
			if (!name) {
				sendJson(res, 400, { error: "station-name-required" })
				return
			}
			const { station, created } = registry.createOrGet(name)
			sendJson(res, created ? 201 : 200, {
				created,
				station: station.publicInfo(),
				snapshot: station.snapshot(),
			})
			return
		}

		// Where is this station right now? The reconnect path calls this first.
		if (pathname.startsWith("/api/stations/")) {
			const stationId = decodeURIComponent(pathname.slice("/api/stations/".length))
			const station = registry.get(stationId)
			if (!station) {
				sendJson(res, 404, { error: "unknown-station", stationId })
				return
			}
			sendJson(res, 200, { snapshot: station.snapshot() })
			return
		}

		serveStatic(req, res, pathname)
	} catch (error) {
		console.error("[http:error]", error)
		if (!res.headersSent) sendJson(res, 500, { error: "server-error" })
		else res.end()
	}
})

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server })

wss.on("connection", (socket, req) => {
	const clientId = randomUUID().slice(0, 8)
	socket.clientId = clientId
	socket.stationId = null
	socket.isAlive = true

	console.log(`[socket:open] client=${clientId} from=${req.socket.remoteAddress}`)

	// The tracks travel with hello so the client can start caching before it joins.
	send(socket, { type: "hello", clientId, serverNow: Date.now(), tracks: registry.tracks })

	socket.on("pong", () => {
		socket.isAlive = true
	})

	socket.on("message", (raw) => {
		// Stamped before parsing: the clock measurement must not include our own JSON.
		const t1 = Date.now()

		let message
		try {
			message = JSON.parse(String(raw))
		} catch (error) {
			send(socket, { type: "error", error: "invalid-json" })
			return
		}

		socket.isAlive = true

		switch (message.type) {
			// One leg of the offset measurement. t0 comes back untouched; t1 and t2 are
			// ours, and the client does the arithmetic.
			case "ping": {
				send(socket, { type: "pong", t0: message.t0, t1, t2: Date.now() })
				return
			}

			case "join": {
				const name = String(message.stationName ?? "").trim()
				if (!name) {
					send(socket, { type: "error", error: "station-name-required" })
					return
				}
				if (registry.tracks.length === 0) {
					send(socket, { type: "error", error: "no-tracks-generated" })
					return
				}

				// Moving between stations must not leave a ghost in the old one.
				if (socket.stationId) {
					registry.leave(socket.stationId, clientId, { reason: "switched station" })
				}

				const { station, created } = registry.createOrGet(name)
				socket.stationId = station.id
				registry.join(station, clientId, socket, String(message.label ?? "listener").slice(0, 40))

				// The snapshot is the whole answer: current track, when it started, and
				// where the station is now. A late joiner gets the same shape as anyone.
				send(socket, {
					type: "joined",
					created,
					reconnect: Boolean(message.reconnect),
					snapshot: station.snapshot(),
				})
				broadcast(station, "listener-joined")
				return
			}

			// Explicitly asked for by a client that suspects it has drifted or missed
			// an update. Cheaper than reconnecting.
			case "resync": {
				const station = registry.get(socket.stationId)
				if (!station) {
					send(socket, { type: "error", error: "not-in-a-station" })
					return
				}
				send(socket, { type: "station:state", reason: "resync", snapshot: station.snapshot() })
				return
			}

			// Controls move the station, not the caller: the server decides what the
			// action means and tells everyone the result.
			case "control": {
				const station = registry.get(socket.stationId)
				if (!station) {
					send(socket, { type: "error", error: "not-in-a-station" })
					return
				}

				switch (message.action) {
					case "play":
						registry.play(station)
						break
					case "pause":
						registry.pause(station)
						break
					case "next":
						registry.skip(station, 1)
						break
					case "previous":
						registry.skip(station, -1)
						break
					case "select":
						registry.select(station, Number(message.cursor))
						break
					default:
						send(socket, { type: "error", error: "unknown-action" })
						return
				}

				console.log(`[station:control] station=${station.id} action=${message.action} by=${clientId}`)
				broadcast(station, `control:${message.action}`)
				return
			}

			case "leave": {
				const station = registry.get(socket.stationId)
				registry.leave(socket.stationId, clientId, { reason: "left" })
				socket.stationId = null
				if (station) broadcast(station, "listener-left")
				return
			}

			default:
				send(socket, { type: "error", error: "unknown-message-type" })
		}
	})

	// The disconnect handler. This is what stops membership growing forever.
	socket.on("close", (code, reasonBuffer) => {
		const reason = String(reasonBuffer ?? "") || `socket closed (${code})`
		const station = registry.get(socket.stationId)
		registry.leave(socket.stationId, clientId, { reason })
		socket.stationId = null
		if (station) broadcast(station, "listener-left")
		console.log(`[socket:close] client=${clientId} code=${code}`)
	})

	socket.on("error", (error) => {
		console.warn(`[socket:error] client=${clientId}: ${error.message}`)
	})
})

/**
 * A phone that walks out of range never sends a close frame, so without this the
 * station would keep counting it as present forever.
 */
const heartbeat = setInterval(() => {
	for (const socket of wss.clients) {
		if (socket.isAlive === false) {
			console.log(`[socket:stale] client=${socket.clientId} missed heartbeat, dropping`)
			socket.terminate()
			continue
		}
		socket.isAlive = false
		try {
			socket.ping()
		} catch (error) {
			socket.terminate()
		}
	}
}, HEARTBEAT_MS)
heartbeat.unref?.()

const sweeper = setInterval(() => registry.sweepEmpty(EMPTY_STATION_TTL_MS), 60_000)
sweeper.unref?.()

server.listen(PORT, () => {
	console.log(`[boot] one station, any vibe — http://localhost:${PORT}`)
})

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		console.log(`[server] ${signal} — closing`)
		clearInterval(heartbeat)
		clearInterval(sweeper)
		for (const socket of wss.clients) socket.close(1001, "server shutting down")
		server.close(() => process.exit(0))
		setTimeout(() => process.exit(0), 1500).unref?.()
	})
}
