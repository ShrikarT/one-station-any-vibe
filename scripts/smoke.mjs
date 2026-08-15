#!/usr/bin/env node
/**
 * End-to-end smoke test.
 *
 * Boots the real server on a spare port, drives it with real WebSocket clients,
 * and asserts the behaviour the scored cases describe: a late joiner lands
 * mid-track, a dropped client is removed from membership, a reconnecting client
 * resumes instead of restarting, two differently-named stations hold different
 * timelines, and join and leave produce distinct log lines.
 *
 *   npm run smoke
 *
 * Exits non-zero if anything fails, so it can go straight into CI.
 */

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"

import WebSocket from "ws"

import { elapsedAt } from "../public/lib/sync/clock.js"

const PORT = Number(process.env.SMOKE_PORT ?? 3999)
const HTTP = `http://127.0.0.1:${PORT}`
const ROOT = fileURLToPath(new URL("..", import.meta.url))

const NAME_A = "chai stall, 3am"
const NAME_B = "trucker's cab on the ghat"

const results = []
let serverLog = ""

async function step(name, fn) {
	try {
		const detail = await fn()
		results.push({ ok: true, name, detail: detail ?? "" })
	} catch (error) {
		results.push({ ok: false, name, detail: error.message })
	}
}

async function getJson(path, init) {
	const response = await fetch(HTTP + path, init)
	const text = await response.text()
	let body = null
	try {
		body = JSON.parse(text)
	} catch (error) {
		body = null
	}
	return { status: response.status, headers: response.headers, body, text }
}

// --------------------------------------------------------------------------
// websocket helpers
// --------------------------------------------------------------------------

function connect(label) {
	const socket = new WebSocket(`ws://127.0.0.1:${PORT}`)
	socket.label = label
	socket.inbox = []
	socket.waiters = new Set()
	socket.on("message", (raw) => {
		let message
		try {
			message = JSON.parse(String(raw))
		} catch (error) {
			return
		}
		const index = socket.inbox.push(message) - 1
		for (const waiter of [...socket.waiters]) {
			if (waiter.type === message.type && index >= waiter.since) {
				clearTimeout(waiter.timer)
				socket.waiters.delete(waiter)
				waiter.resolve(message)
			}
		}
	})
	return socket
}

function opened(socket) {
	return new Promise((resolve, reject) => {
		socket.once("open", resolve)
		socket.once("error", reject)
	})
}

function waitFor(socket, type, since = 0, timeoutMs = 8000) {
	const found = socket.inbox.findIndex((message, index) => index >= since && message.type === type)
	if (found !== -1) return Promise.resolve(socket.inbox[found])
	return new Promise((resolve, reject) => {
		const waiter = { type, since, resolve }
		waiter.timer = setTimeout(() => {
			socket.waiters.delete(waiter)
			reject(new Error(`timed out waiting for "${type}" on ${socket.label}`))
		}, timeoutMs)
		socket.waiters.add(waiter)
	})
}

function send(socket, payload) {
	socket.send(JSON.stringify(payload))
}

async function join(socket, stationName, reconnect = false) {
	const mark = socket.inbox.length
	send(socket, { type: "join", stationName, reconnect, label: socket.label })
	return waitFor(socket, "joined", mark)
}

// --------------------------------------------------------------------------
// boot
// --------------------------------------------------------------------------

console.log(`booting server on :${PORT}\n`)

const server = spawn(process.execPath, ["server/index.js"], {
	cwd: ROOT,
	env: { ...process.env, PORT: String(PORT) },
	stdio: ["ignore", "pipe", "pipe"],
})

server.stdout.on("data", (chunk) => {
	serverLog += String(chunk)
})
server.stderr.on("data", (chunk) => {
	serverLog += String(chunk)
})

let booted = false
for (let attempt = 0; attempt < 60; attempt += 1) {
	try {
		const response = await fetch(`${HTTP}/api/time`)
		if (response.ok) {
			booted = true
			break
		}
	} catch (error) {
		// not up yet
	}
	await sleep(100)
}

if (!booted) {
	console.error("server never came up\n")
	console.error(serverLog)
	server.kill("SIGKILL")
	process.exit(1)
}

// --------------------------------------------------------------------------
// http surface
// --------------------------------------------------------------------------

await step("GET /api/time returns the station clock", async () => {
	const { status, body } = await getJson("/api/time")
	assert.equal(status, 200)
	assert.equal(typeof body.serverNow, "number")
	const skew = Math.abs(body.serverNow - Date.now())
	assert.ok(skew < 5000, `server clock is ${skew}ms from ours`)
	return `serverNow within ${skew}ms of local`
})

let trackCount = 0
await step("GET /api/tracks returns a playlist", async () => {
	const { status, body } = await getJson("/api/tracks")
	assert.equal(status, 200)
	assert.ok(Array.isArray(body.tracks), "tracks is not an array")
	assert.ok(body.tracks.length > 0, "no tracks \u2014 run: npm run audio")
	trackCount = body.tracks.length
	return `${trackCount} tracks`
})

let stationA = null
await step("POST /api/stations creates a station under an arbitrary name", async () => {
	const { status, body } = await getJson("/api/stations", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: NAME_A }),
	})
	assert.equal(status, 201)
	assert.equal(body.created, true)
	assert.ok(body.snapshot.stationId, "no station id")
	stationA = body.snapshot.stationId
	return `"${NAME_A}" -> ${stationA}`
})

await step("the same name, differently cased, resolves to the same station", async () => {
	const { status, body } = await getJson("/api/stations", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: NAME_A.toUpperCase() }),
	})
	assert.equal(status, 200)
	assert.equal(body.created, false, "a second station was created")
	assert.equal(body.snapshot.stationId, stationA)
	return "no duplicate station"
})

await step("an empty station name is rejected", async () => {
	const { status, body } = await getJson("/api/stations", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: "   " }),
	})
	assert.equal(status, 400)
	assert.equal(body.error, "station-name-required")
	return "400 station-name-required"
})

await step("GET /api/stations/:id on an unknown station is a 404", async () => {
	const { status, body } = await getJson("/api/stations/no-such-station")
	assert.equal(status, 404)
	assert.equal(body.error, "unknown-station")
	return "404 unknown-station"
})

await step("a missing script 404s instead of quietly serving index.html", async () => {
	const response = await fetch(`${HTTP}/missing.js`, { headers: { accept: "text/javascript" } })
	assert.equal(response.status, 404)
	return "404, not an HTML fallback"
})

await step("path traversal out of public/ is refused", async () => {
	const response = await fetch(`${HTTP}/../package.json`, { headers: { accept: "text/javascript" } })
	assert.ok(response.status === 404 || response.status === 400, `got ${response.status}`)
	return `${response.status} on /../package.json`
})

await step("the shell, the sync maths and the service worker are all served", async () => {
	const shell = await fetch(`${HTTP}/`, { headers: { accept: "text/html" } })
	assert.equal(shell.status, 200)
	assert.match(shell.headers.get("content-type") ?? "", /text\/html/)

	const clock = await fetch(`${HTTP}/lib/sync/clock.js`, { headers: { accept: "text/javascript" } })
	assert.equal(clock.status, 200)
	assert.match(clock.headers.get("content-type") ?? "", /javascript/)
	const clockSource = await clock.text()
	assert.match(clockSource, /estimateOffset/, "clock.js is not the compiled sync module")

	const worker = await fetch(`${HTTP}/sw.js`, { headers: { accept: "text/javascript" } })
	assert.equal(worker.status, 200)
	const workerSource = await worker.text()
	assert.match(workerSource, /addEventListener\("fetch"/, "the worker has no fetch handler")
	assert.match(workerSource, /caches/, "the worker never touches the Cache API")
	return "index.html, clock.js, sw.js"
})

await step("audio is served immutable so the cache can keep it", async () => {
	const { body } = await getJson("/api/tracks")
	const first = body.tracks[0]
	const response = await fetch(HTTP + first.src, { headers: { range: "bytes=0-1023" } })
	assert.ok(response.status === 200 || response.status === 206, `got ${response.status}`)
	const cacheControl = response.headers.get("cache-control") ?? ""
	assert.match(cacheControl, /immutable/)
	return `${first.src} ${cacheControl}`
})

// --------------------------------------------------------------------------
// live sockets
// --------------------------------------------------------------------------

const alice = connect("alice")
await opened(alice)

await step("a new socket is greeted with the clock and the playlist", async () => {
	const hello = await waitFor(alice, "hello")
	assert.ok(hello.clientId, "no client id")
	assert.equal(typeof hello.serverNow, "number")
	assert.equal(hello.tracks.length, trackCount)
	return `client ${hello.clientId}`
})

await step("ping is answered with a stamped pong", async () => {
	const t0 = Date.now()
	const mark = alice.inbox.length
	send(alice, { type: "ping", t0 })
	const pong = await waitFor(alice, "pong", mark)
	const t3 = Date.now()
	assert.equal(pong.t0, t0, "t0 was not echoed back")
	assert.ok(pong.t1 >= t0 - 5000 && pong.t2 >= pong.t1, "stamps are out of order")
	assert.ok(t3 >= t0, "impossible round trip")
	return `rtt ${t3 - t0}ms`
})

let joinedAtA = null
await step("a first listener joins and the station starts", async () => {
	const joined = await join(alice, NAME_A)
	joinedAtA = joined.snapshot
	assert.equal(joined.snapshot.stationId, stationA)
	assert.equal(typeof joined.snapshot.startedAt, "number")
	assert.ok(joined.snapshot.track, "no track selected")
	assert.ok(joined.snapshot.listeners >= 1)
	return `"${joined.snapshot.track.title}", ${joined.snapshot.listeners} listening`
})

console.log("waiting 2.5s so the next joiner is genuinely late\u2026")
await sleep(2500)

const bob = connect("bob")
await opened(bob)
await waitFor(bob, "hello")

let bobElapsed = 0
await step("a late joiner is handed a non-zero elapsed position [case 3]", async () => {
	const joined = await join(bob, NAME_A)
	bobElapsed = joined.snapshot.elapsedMs
	assert.equal(joined.snapshot.stationId, stationA, "landed in a different station")
	assert.equal(joined.snapshot.startedAt, joinedAtA.startedAt, "the timeline was reset for the new joiner")
	assert.ok(bobElapsed >= 2000, `elapsed was only ${bobElapsed}ms`)
	return `joined ${(bobElapsed / 1000).toFixed(1)}s into the track`
})

await step("the server's elapsed agrees with lib/sync/clock.js", async () => {
	const { body } = await getJson(`/api/stations/${encodeURIComponent(stationA)}`)
	const snapshot = body.snapshot
	const mine = elapsedAt(snapshot.startedAt, snapshot.serverNow, {
		durationMs: snapshot.durationMs,
		loop: true,
	})
	const gap = Math.abs(mine - snapshot.elapsedMs)
	assert.ok(gap <= 2, `server said ${snapshot.elapsedMs}ms, clock.js said ${mine}ms`)
	return `both say ${snapshot.elapsedMs}ms`
})

await step("both listeners are counted in the same station", async () => {
	const { body } = await getJson(`/api/stations/${encodeURIComponent(stationA)}`)
	assert.equal(body.snapshot.listeners, 2)
	return "2 listening"
})

// -------- independence --------

const carol = connect("carol")
await opened(carol)
await waitFor(carol, "hello")

let stationB = null
await step("a second, differently-named station is independent [cases 7 and 8]", async () => {
	const joined = await join(carol, NAME_B)
	stationB = joined.snapshot.stationId
	assert.notEqual(stationB, stationA, "both names collapsed to one station")

	const before = await getJson(`/api/stations/${encodeURIComponent(stationA)}`)

	// Move station B forward. Station A must not notice.
	const mark = carol.inbox.length
	send(carol, { type: "control", action: "next" })
	await waitFor(carol, "station:state", mark)
	await sleep(150)

	const after = await getJson(`/api/stations/${encodeURIComponent(stationA)}`)
	const b = await getJson(`/api/stations/${encodeURIComponent(stationB)}`)

	assert.equal(after.body.snapshot.startedAt, before.body.snapshot.startedAt, "skipping B moved A's timeline")
	assert.equal(after.body.snapshot.track.id, before.body.snapshot.track.id, "skipping B changed A's track")
	assert.notEqual(b.body.snapshot.startedAt, after.body.snapshot.startedAt, "the two stations share a timeline")
	return `${stationA} and ${stationB} on separate timelines`
})

// -------- the drop --------

await step("a dropped client is removed from membership [case 9]", async () => {
	bob.close(4000, "simulated drop")
	await sleep(500)
	const { body } = await getJson(`/api/stations/${encodeURIComponent(stationA)}`)
	assert.equal(body.snapshot.listeners, 1, "the dropped listener is still counted")
	return "listeners 2 -> 1"
})

await step("the music kept running while that client was away [case 5]", async () => {
	await sleep(1200)
	const { body } = await getJson(`/api/stations/${encodeURIComponent(stationA)}`)
	assert.equal(body.snapshot.startedAt, joinedAtA.startedAt, "the station restarted when someone left")
	assert.ok(body.snapshot.elapsedMs > bobElapsed, "the timeline froze")
	return `now ${(body.snapshot.elapsedMs / 1000).toFixed(1)}s in`
})

await step("the reconnecting client resumes mid-track, not from zero [case 5]", async () => {
	const bobAgain = connect("bob-again")
	await opened(bobAgain)
	await waitFor(bobAgain, "hello")
	const joined = await join(bobAgain, NAME_A, true)
	assert.equal(joined.reconnect, true, "the reconnect flag was lost")
	assert.equal(joined.snapshot.startedAt, joinedAtA.startedAt, "the track was restarted on reconnect")
	assert.ok(
		joined.snapshot.elapsedMs > bobElapsed,
		`resumed at ${joined.snapshot.elapsedMs}ms, which is not after ${bobElapsed}ms`,
	)
	bobAgain.close(1000, "done")
	return `resumed at ${(joined.snapshot.elapsedMs / 1000).toFixed(1)}s`
})

// -------- leaving --------

await step("an explicit leave drops the listener count", async () => {
	send(alice, { type: "leave" })
	await sleep(400)
	const { body } = await getJson(`/api/stations/${encodeURIComponent(stationA)}`)
	assert.equal(body.snapshot.listeners, 0)
	return "0 listening"
})

await step("join and leave are logged distinctly [case 10]", async () => {
	assert.match(serverLog, /\[station:created\]/, "no station:created log")
	assert.match(serverLog, /\[station:join\]/, "no station:join log")
	assert.match(serverLog, /\[station:leave\]/, "no station:leave log")
	const joins = (serverLog.match(/\[station:join\]/g) ?? []).length
	const leaves = (serverLog.match(/\[station:leave\]/g) ?? []).length
	assert.ok(joins >= 3, `only ${joins} join lines`)
	assert.ok(leaves >= 2, `only ${leaves} leave lines`)
	return `${joins} joins, ${leaves} leaves, separate prefixes`
})

// --------------------------------------------------------------------------
// done
// --------------------------------------------------------------------------

alice.close(1000, "done")
carol.close(1000, "done")
await sleep(200)
server.kill("SIGTERM")
await sleep(400)
server.kill("SIGKILL")

const failed = results.filter((result) => !result.ok)

console.log("\n" + "\u2500".repeat(78))
for (const result of results) {
	const mark = result.ok ? "PASS" : "FAIL"
	console.log(`${mark}  ${result.name}${result.detail ? `\n      ${result.detail}` : ""}`)
}
console.log("\u2500".repeat(78))
console.log(`${results.length - failed.length}/${results.length} checks passed`)

if (failed.length > 0) {
	console.log("\nserver log\n" + "\u2500".repeat(78) + "\n" + serverLog)
	process.exit(1)
}

process.exit(0)
