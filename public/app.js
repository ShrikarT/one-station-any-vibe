/**
 * The client.
 *
 * Responsibilities, in order of importance:
 *   1. measure this device's clock offset from the station, continuously
 *   2. hand every station snapshot to the audio engine, which schedules against it
 *   3. survive the socket dying without stopping the music
 */

import { AudioEngine } from "/audio-engine.js"
import { estimateOffset } from "/lib/sync/clock.js"

/** Pings in the first burst. More samples, better median, one-off cost. */
const PING_BURST = 7
/** Pings in each refresh burst. Phone clocks get nudged by NTP as you sit there. */
const PING_REFRESH = 3
const PING_SPACING_MS = 120
const CLOCK_REFRESH_MS = 20_000
const DRIFT_CHECK_MS = 3_000
const MAX_BACKOFF_MS = 10_000
/** Keep a rolling window: an offset measured ten minutes ago is not this offset. */
const MAX_SAMPLES = 12

const el = (id) => document.getElementById(id)

const dom = {
	status: el("status"),
	landing: el("landing"),
	joinForm: el("joinForm"),
	stationName: el("stationName"),
	stationList: el("stationList"),
	stage: el("stage"),
	stationTitle: el("stationTitle"),
	listeners: el("listeners"),
	trackTitle: el("trackTitle"),
	trackArtist: el("trackArtist"),
	lateNotice: el("lateNotice"),
	progress: el("progress"),
	position: el("position"),
	duration: el("duration"),
	previous: el("previous"),
	playPause: el("playPause"),
	next: el("next"),
	mute: el("mute"),
	offset: el("offset"),
	rtt: el("rtt"),
	drift: el("drift"),
	cached: el("cached"),
	shareStation: el("shareStation"),
	simulateDrop: el("simulateDrop"),
	leaveStation: el("leaveStation"),
	log: el("log"),
}

const state = {
	clientId: null,
	stationName: "",
	stationId: null,
	snapshot: null,
	samples: [],
	offsetMs: 0,
	rttMs: null,
	socket: null,
	backoffMs: 500,
	reconnectTimer: null,
	inStation: false,
	leaving: false,
	tracks: [],
}

const engine = new AudioEngine(onEngineEvent)

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function log(message, tone = "") {
	const item = document.createElement("li")
	if (tone) item.dataset.tone = tone
	const stamp = document.createElement("time")
	stamp.textContent = new Date().toLocaleTimeString(undefined, { hour12: false })
	const text = document.createElement("span")
	text.textContent = message
	item.append(stamp, text)
	dom.log.prepend(item)
	while (dom.log.children.length > 60) dom.log.lastElementChild?.remove()
}

function setStatus(text, stateName) {
	dom.status.textContent = text
	dom.status.dataset.state = stateName
}

function clock(ms) {
	const total = Math.max(0, Math.floor(ms / 1000))
	const minutes = Math.floor(total / 60)
	const seconds = total % 60
	return `${minutes}:${String(seconds).padStart(2, "0")}`
}

function signed(ms) {
	const rounded = Math.round(ms)
	return `${rounded > 0 ? "+" : ""}${rounded}ms`
}

// ---------------------------------------------------------------------------
// Service worker
// ---------------------------------------------------------------------------

async function registerServiceWorker() {
	if (!("serviceWorker" in navigator)) {
		log("no service worker support: offline replay is off", "warn")
		return
	}
	// Service workers refuse to register outside a secure context, so testing over
	// http://192.168.x.x silently loses caching. Say so rather than look broken.
	if (!window.isSecureContext) {
		log("insecure context: service worker skipped, use https or localhost", "warn")
		return
	}
	try {
		await navigator.serviceWorker.register("/sw.js", { scope: "/" })
		log("service worker registered", "good")
		navigator.serviceWorker.addEventListener("message", (event) => {
			if (event.data?.type === "cache-status") {
				dom.cached.textContent = `${event.data.cachedAudio} files`
			}
		})
		await navigator.serviceWorker.ready
		askCacheStatus()
	} catch (error) {
		log(`service worker failed: ${error.message}`, "bad")
	}
}

function askCacheStatus() {
	navigator.serviceWorker?.controller?.postMessage({ type: "cache-status" })
}

/** Pull the rest of the playlist down while the first track plays. */
function prefetchAudio(tracks) {
	if (!tracks?.length) return
	navigator.serviceWorker?.controller?.postMessage({
		type: "cache-audio",
		urls: tracks.map((track) => track.src),
	})
}

// ---------------------------------------------------------------------------
// Clock offset
// ---------------------------------------------------------------------------

function sendPing() {
	if (state.socket?.readyState !== WebSocket.OPEN) return
	state.socket.send(JSON.stringify({ type: "ping", t0: Date.now() }))
}

function pingBurst(count) {
	for (let index = 0; index < count; index += 1) {
		setTimeout(sendPing, index * PING_SPACING_MS)
	}
}

function onPong(message) {
	// t3 first: anything between arrival and this line is measurement error.
	const sample = { t0: message.t0, t1: message.t1, t2: message.t2, t3: Date.now() }
	state.samples.push(sample)
	if (state.samples.length > MAX_SAMPLES) state.samples.shift()

	const estimate = estimateOffset(state.samples)
	state.offsetMs = estimate.offsetMs
	state.rttMs = estimate.rttMs

	// The only path by which the offset reaches scheduling.
	engine.setClockOffset(estimate.offsetMs)

	dom.offset.textContent = signed(estimate.offsetMs)
	dom.rtt.textContent = Number.isFinite(estimate.rttMs) ? `${Math.round(estimate.rttMs)}ms` : "—"
}

/**
 * The same measurement over HTTP, for when the socket is down. Less accurate — one
 * sample, and t1/t2 collapse into a single server stamp — but enough to reschedule
 * to roughly the right place while the socket is still reconnecting.
 */
async function measureOffsetOverHttp() {
	const t0 = Date.now()
	try {
		const response = await fetch("/api/time", { cache: "no-store" })
		const t3 = Date.now()
		const { serverNow } = await response.json()
		const sample = { t0, t1: serverNow, t2: serverNow, t3 }
		state.samples.push(sample)
		if (state.samples.length > MAX_SAMPLES) state.samples.shift()

		const estimate = estimateOffset(state.samples)
		state.offsetMs = estimate.offsetMs
		engine.setClockOffset(estimate.offsetMs)
		dom.offset.textContent = signed(estimate.offsetMs)
		return estimate.offsetMs
	} catch (error) {
		return state.offsetMs
	}
}

// ---------------------------------------------------------------------------
// Applying station state
// ---------------------------------------------------------------------------

async function apply(snapshot, reason) {
	if (!snapshot) return
	state.snapshot = snapshot
	state.stationId = snapshot.stationId
	state.stationName = snapshot.stationName

	dom.stationTitle.textContent = snapshot.stationName
	dom.listeners.textContent = `${snapshot.listeners} listening`
	dom.trackTitle.textContent = snapshot.track?.title ?? "—"
	dom.trackArtist.textContent = snapshot.track?.artist ?? "—"
	dom.duration.textContent = clock(snapshot.durationMs)
	dom.playPause.textContent = snapshot.paused ? "▶" : "‖"
	dom.playPause.dataset.playing = String(!snapshot.paused)

	const plan = await engine.applySnapshot(snapshot, reason)
	if (!plan) return

	dom.lateNotice.hidden = !plan.isLateJoin
	if (plan.isLateJoin) {
		log(`${reason}: picked up ${clock(plan.elapsedMs)} into "${snapshot.track?.title}"`, "good")
	} else {
		log(`${reason}: "${snapshot.track?.title}" from the top`)
	}
}

function onEngineEvent(event) {
	if (event.type === "drift-corrected") {
		log(`drift ${signed(event.driftMs)} — rescheduled`, "warn")
	}
}

// ---------------------------------------------------------------------------
// Socket
// ---------------------------------------------------------------------------

function connect() {
	const protocol = location.protocol === "https:" ? "wss:" : "ws:"
	const socket = new WebSocket(`${protocol}//${location.host}`)
	state.socket = socket

	socket.addEventListener("open", () => {
		state.backoffMs = 500
		setStatus("live", "live")
		pingBurst(PING_BURST)
		// Rejoining is the reconnect path: same name, flagged so the log is honest.
		if (state.inStation && state.stationName) {
			setTimeout(() => joinOverSocket(state.stationName, true), PING_SPACING_MS * 3)
		}
	})

	socket.addEventListener("message", (event) => {
		let message
		try {
			message = JSON.parse(event.data)
		} catch (error) {
			return
		}

		switch (message.type) {
			case "hello":
				state.clientId = message.clientId
				state.tracks = message.tracks ?? []
				prefetchAudio(state.tracks)
				break
			case "pong":
				onPong(message)
				break
			case "joined":
				state.inStation = true
				showStage()
				if (message.created) log(`created "${message.snapshot.stationName}"`, "good")
				apply(message.snapshot, message.reconnect ? "reconnected" : "joined")
				break
			case "station:state":
				// Listener counts change constantly; only reschedule when the timeline moved.
				if (isTimelineChange(message.snapshot)) apply(message.snapshot, message.reason)
				else updateListeners(message.snapshot)
				break
			case "error":
				log(`server: ${message.error}`, "bad")
				break
		}
	})

	// The drop. Music keeps playing; only the channel is gone.
	socket.addEventListener("close", (event) => {
		if (state.leaving) return
		setStatus("reconnecting", "reconnecting")
		log(`connection lost (${event.code}) — audio continues`, "warn")

		// Resync over HTTP straight away: often the network is back before the socket.
		if (state.inStation) resyncOverHttp()

		clearTimeout(state.reconnectTimer)
		state.reconnectTimer = setTimeout(connect, state.backoffMs)
		state.backoffMs = Math.min(MAX_BACKOFF_MS, Math.round(state.backoffMs * 1.8))
	})

	socket.addEventListener("error", () => {
		setStatus("offline", "offline")
	})
}

function isTimelineChange(snapshot) {
	const previous = state.snapshot
	if (!previous) return true
	return (
		snapshot.startedAt !== previous.startedAt ||
		snapshot.track?.id !== previous.track?.id ||
		snapshot.paused !== previous.paused
	)
}

function updateListeners(snapshot) {
	state.snapshot = { ...state.snapshot, listeners: snapshot.listeners }
	dom.listeners.textContent = `${snapshot.listeners} listening`
}

function joinOverSocket(name, reconnect = false) {
	if (state.socket?.readyState !== WebSocket.OPEN) return false
	state.socket.send(
		JSON.stringify({
			type: "join",
			stationName: name,
			reconnect,
			label: navigator.userAgentData?.mobile ? "phone" : "desktop",
		}),
	)
	return true
}

/**
 * Reconnect and resync path: ask where the station is now, and reschedule to that
 * point. Never restarts the track, and never touches anyone else's playback.
 */
async function resyncOverHttp() {
	if (!state.stationId) return
	try {
		await measureOffsetOverHttp()
		const response = await fetch(`/api/stations/${encodeURIComponent(state.stationId)}`, {
			cache: "no-store",
		})
		if (!response.ok) return
		const { snapshot } = await response.json()
		await apply(snapshot, "resynced over http")
	} catch (error) {
		log("offline: playing from cache", "warn")
	}
}

function sendControl(action, extra = {}) {
	if (state.socket?.readyState !== WebSocket.OPEN) {
		log("offline: controls need the connection back", "warn")
		return
	}
	state.socket.send(JSON.stringify({ type: "control", action, ...extra }))
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

function showStage() {
	dom.landing.hidden = true
	dom.stage.hidden = false
}

function showLanding() {
	dom.stage.hidden = true
	dom.landing.hidden = false
}

async function enterStation(name) {
	const trimmed = String(name ?? "").trim()
	if (!trimmed) return

	// Must happen inside the click: browsers only unlock audio on a real gesture.
	await engine.resume()

	state.stationName = trimmed
	state.inStation = true

	if (!joinOverSocket(trimmed, false)) {
		// Socket not up yet: create over HTTP so the station exists, then the open
		// handler will join properly.
		try {
			const response = await fetch("/api/stations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: trimmed }),
			})
			const data = await response.json()
			if (data.snapshot) {
				showStage()
				await apply(data.snapshot, "joined")
			}
		} catch (error) {
			log("could not reach the server", "bad")
		}
	}

	history.replaceState(null, "", `/s/${encodeURIComponent(trimmed)}`)
}

async function refreshStationList() {
	try {
		const response = await fetch("/api/stations", { cache: "no-store" })
		const { stations } = await response.json()
		dom.stationList.replaceChildren()

		if (!stations.length) {
			const empty = document.createElement("li")
			empty.className = "empty"
			empty.textContent = "Nothing playing yet. Start one."
			dom.stationList.append(empty)
			return
		}

		for (const station of stations) {
			const item = document.createElement("li")
			const button = document.createElement("button")
			const name = document.createElement("span")
			name.textContent = station.name
			const who = document.createElement("span")
			who.className = "who"
			who.textContent = `${station.listeners} listening · ${station.nowPlaying ?? "—"}`
			button.append(name, who)
			button.addEventListener("click", () => enterStation(station.name))
			item.append(button)
			dom.stationList.append(item)
		}
	} catch (error) {
		// Offline on the landing screen. The list is not worth an error.
	}
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

dom.joinForm.addEventListener("submit", (event) => {
	event.preventDefault()
	enterStation(dom.stationName.value)
})

dom.playPause.addEventListener("click", async () => {
	await engine.resume()
	sendControl(state.snapshot?.paused ? "play" : "pause")
})

dom.next.addEventListener("click", () => sendControl("next"))
dom.previous.addEventListener("click", () => sendControl("previous"))

dom.mute.addEventListener("click", () => {
	const muted = !engine.muted
	engine.setMuted(muted)
	dom.mute.dataset.muted = String(muted)
	dom.mute.textContent = muted ? "muted" : "mute"
})

dom.shareStation.addEventListener("click", async () => {
	const url = `${location.origin}/s/${encodeURIComponent(state.stationName)}`
	try {
		await navigator.clipboard.writeText(url)
		log("invite link copied", "good")
	} catch (error) {
		log(url)
	}
})

/** The demo button for acceptance criterion four. */
dom.simulateDrop.addEventListener("click", () => {
	log("simulating a dropped connection…", "warn")
	state.socket?.close(4000, "simulated drop")
})

dom.leaveStation.addEventListener("click", () => {
	state.leaving = true
	if (state.socket?.readyState === WebSocket.OPEN) {
		state.socket.send(JSON.stringify({ type: "leave" }))
	}
	engine.stop()
	state.inStation = false
	state.stationId = null
	state.snapshot = null
	showLanding()
	history.replaceState(null, "", "/")
	log("left the station")
	refreshStationList()
	setTimeout(() => {
		state.leaving = false
	}, 200)
})

// A tab that was backgrounded may have had its timers throttled for minutes.
document.addEventListener("visibilitychange", () => {
	if (document.visibilityState !== "visible") return
	pingBurst(PING_REFRESH)
	if (state.inStation) resyncOverHttp()
})

window.addEventListener("online", () => {
	log("network back", "good")
	if (state.socket?.readyState !== WebSocket.OPEN) connect()
	else if (state.inStation) resyncOverHttp()
})

window.addEventListener("offline", () => {
	setStatus("offline", "offline")
	log("network gone — playing from cache", "warn")
})

// Position readout. Cosmetic; the audio clock is the source of truth.
setInterval(() => {
	if (!state.snapshot || dom.stage.hidden) return
	const position = engine.positionMs()
	const duration = state.snapshot.durationMs || 1
	dom.position.textContent = clock(position)
	dom.progress.style.setProperty("--progress", `${Math.min(100, (position / duration) * 100)}%`)
}, 250)

setInterval(() => {
	if (!state.inStation) return
	const drift = engine.driftMs()
	dom.drift.textContent = signed(drift)
	engine.correctDriftIfNeeded()
}, DRIFT_CHECK_MS)

setInterval(() => pingBurst(PING_REFRESH), CLOCK_REFRESH_MS)
setInterval(refreshStationList, 8_000)
setInterval(askCacheStatus, 5_000)

// Deep link: /s/<name> prefills the name but still waits for a tap, because iOS
// will not start audio without one.
const deepLink = decodeURIComponent(location.pathname.replace(/^\/s\//, ""))
if (location.pathname.startsWith("/s/") && deepLink) {
	dom.stationName.value = deepLink
	dom.stationName.focus()
}

setStatus("connecting", "connecting")
registerServiceWorker()
connect()
refreshStationList()

/** For poking at sync from the console during a demo. */
window.__station = { state, engine, connect, resyncOverHttp }
