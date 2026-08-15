/**
 * Stations: one shared timeline per user-invented name.
 *
 * There is no list of stations in this file, or anywhere else. A station exists
 * because somebody typed a name; the id derived from that name is the key its
 * playback state and its membership are stored under. Two different names are two
 * different rooms, with unrelated tracks and unrelated clocks.
 *
 * The name does one more job: the words in it are matched against track tags, so
 * a station called "sangeet" opens on different music from one called "monsoon
 * window". That is seeding, not presetting - see tracksForName below.
 */

import { EventEmitter } from "node:events"

/**
 * When advancing to the next track, treat "a few ms early" as "now". Timers fire
 * late as often as they fire on time, and a station should not sit in a gap.
 */
const ADVANCE_GUARD_MS = 120

/** FNV-1a: small, fast, and stable across processes — unlike hashing an object. */
function fnv1a(text) {
	let hash = 2166136261
	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index)
		hash = Math.imul(hash, 16777619)
	}
	return hash >>> 0
}

/**
 * Turn whatever the user typed into a station id.
 *
 * "Hill Road Dhaba", "hill road dhaba" and "hill-road-dhaba" are deliberately the
 * same station: two people describing the same place differently should end up in
 * the same room. Names that slugify to nothing — emoji, Devanagari, Telugu — fall
 * back to a hash of the original, so they still get a stable, distinct id instead
 * of colliding with every other unslugifiable name.
 */
export function slugifyStationName(name) {
	const trimmed = String(name ?? "").trim()
	const slug = trimmed
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64)

	if (slug) return slug
	return `station-${fnv1a(trimmed).toString(36)}`
}

/** The words in a name, long enough to be worth matching on. */
function wordsIn(name) {
	return String(name ?? "")
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.split(/\s+/)
		.filter((word) => word.length > 2)
}

/**
 * Choose the pool of tracks a station opens with, from its name alone.
 *
 * "trucker's cab, 3am" leans on the late-night road tracks; "sangeet" leans on
 * the loud ones. Note what this is not: there is no table of known station names
 * anywhere. The name stays free text, the tags live on the tracks, and the match
 * is done at station-creation time.
 *
 * Two deliberate escape hatches, both of which matter more than the feature:
 *   - fewer than two matches falls back to the whole library, because a station
 *     that loops one song forever is worse than one that ignores its own name
 *   - a library with no tags is never filtered, so an install that has only the
 *     synthesised beds, or somebody's own folder of mp3s, behaves exactly as it
 *     did before this existed
 */
export function tracksForName(tracks, name) {
	const words = wordsIn(name)
	if (words.length === 0) return tracks

	const matched = tracks.filter((track) => {
		const tags = Array.isArray(track.tags) ? track.tags : []
		return tags.some((raw) => {
			const tag = String(raw).toLowerCase()
			return tag === word_match(tag, words)
		})
	})

	return matched.length >= 2 ? matched : tracks
}

/** True when any word in the name is the tag, a prefix of it, or extends it. */
function word_match(tag, words) {
	const hit = words.find((word) => tag === word || tag.startsWith(word) || word.startsWith(tag))
	return hit === undefined ? null : tag
}

/**
 * A play order that is shuffled, but the same shuffle every time for a given
 * station id. Two stations get genuinely different running orders; one station
 * survives a restart with its character intact.
 */
export function playlistOrderFor(stationId, trackCount) {
	const order = []
	for (let index = 0; index < trackCount; index += 1) order.push(index)

	let seed = fnv1a(String(stationId)) || 1
	const random = () => {
		// xorshift32
		seed ^= seed << 13
		seed >>>= 0
		seed ^= seed >>> 17
		seed ^= seed << 5
		seed >>>= 0
		return seed / 4294967296
	}

	for (let index = order.length - 1; index > 0; index -= 1) {
		const swapWith = Math.floor(random() * (index + 1))
		const held = order[index]
		order[index] = order[swapWith]
		order[swapWith] = held
	}
	return order
}

/**
 * One station's state. Every field here is per-instance — that is what makes two
 * stations independent rather than two views of one global player.
 */
export class Station {
	constructor(id, name, tracks, now = Date.now()) {
		this.id = id
		this.name = name
		this.tracks = tracks
		this.order = playlistOrderFor(id, tracks.length)
		this.cursor = 0
		this.createdAt = now
		/** Station-clock timestamp the current track started at. The shared reference. */
		this.startedAt = now
		this.paused = false
		/** Where the track was frozen, so resuming does not jump. */
		this.pausedElapsedMs = 0
		/** clientId -> membership record. Shrinks on disconnect. */
		this.members = new Map()
		this.emptySince = now
		this.advanceTimer = null
	}

	get currentTrack() {
		if (this.tracks.length === 0) return null
		return this.tracks[this.order[this.cursor % this.order.length]] ?? null
	}

	get durationMs() {
		return this.currentTrack?.durationMs ?? 0
	}

	get listenerCount() {
		return this.members.size
	}

	/** How far into the current track this station is, on the station clock. */
	elapsedMs(now = Date.now()) {
		if (this.paused) return this.pausedElapsedMs
		const duration = this.durationMs
		const raw = Math.max(0, now - this.startedAt)
		// Wrap rather than clamp: a station is always playing something.
		return duration > 0 ? raw % duration : raw
	}

	/**
	 * Everything a client needs to schedule playback for itself. `startedAt` and
	 * `serverNow` are both on the station clock; the client compares them against
	 * its own and works out the rest.
	 */
	snapshot(now = Date.now()) {
		return {
			stationId: this.id,
			stationName: this.name,
			track: this.currentTrack,
			trackIndex: this.cursor,
			trackCount: this.tracks.length,
			startedAt: this.startedAt,
			paused: this.paused,
			elapsedMs: this.elapsedMs(now),
			durationMs: this.durationMs,
			serverNow: now,
			listeners: this.listenerCount,
		}
	}

	/** The short form used in the "live now" list. */
	publicInfo() {
		return {
			id: this.id,
			name: this.name,
			listeners: this.listenerCount,
			nowPlaying: this.currentTrack?.title ?? null,
			createdAt: this.createdAt,
		}
	}
}

/**
 * Every station in the process, keyed by the id derived from its user-given name.
 *
 * Extends EventEmitter so join and leave are emitted as distinct events rather
 * than only printed: the server logs them, and anything else that cares can
 * listen without this file knowing about it.
 */
export class StationRegistry extends EventEmitter {
	constructor(tracks) {
		super()
		this.tracks = tracks ?? []
		/** stationId -> Station */
		this.stations = new Map()
	}

	/** Join by name; the station is created on first mention. No preset list. */
	createOrGet(name, now = Date.now()) {
		const id = slugifyStationName(name)
		const existing = this.stations.get(id)
		if (existing) return { station: existing, created: false }

		// The name picks the music as well as the room.
		const pool = tracksForName(this.tracks, name)
		const station = new Station(id, String(name).trim(), pool, now)
		this.stations.set(id, station)
		this.scheduleAdvance(station)
		this.emit("station:created", { id: station.id, name: station.name })
		return { station, created: true }
	}

	get(stationId) {
		if (!stationId) return null
		return this.stations.get(stationId) ?? null
	}

	list() {
		return [...this.stations.values()]
			.sort((a, b) => b.listenerCount - a.listenerCount || a.createdAt - b.createdAt)
			.map((station) => station.publicInfo())
	}

	membersOf(station) {
		return station ? [...station.members.values()] : []
	}

	join(station, clientId, socket, label = "listener", now = Date.now()) {
		station.members.set(clientId, { clientId, socket, label, joinedAt: now })
		station.emptySince = null

		const event = {
			stationId: station.id,
			stationName: station.name,
			clientId,
			label,
			listeners: station.listenerCount,
			at: now,
		}
		this.emit("join", event)
		return event
	}

	/**
	 * Remove a client from the station's membership. Called on close, on heartbeat
	 * timeout, and on an explicit leave — so a phone that walks out of range is
	 * forgotten just like one that taps the button.
	 */
	leave(stationId, clientId, options = {}) {
		const { reason = "left", now = Date.now() } = options
		const station = this.get(stationId)
		if (!station) return null

		const membership = station.members.get(clientId)
		if (!membership) return null // already gone; leaving twice is not an event

		station.members.delete(clientId)
		if (station.listenerCount === 0) station.emptySince = now

		const event = {
			stationId: station.id,
			stationName: station.name,
			clientId,
			label: membership.label,
			reason,
			listenedForMs: Math.max(0, now - membership.joinedAt),
			listeners: station.listenerCount,
			at: now,
		}
		this.emit("leave", event)
		return event
	}

	/** Resume from where it was frozen, by moving startedAt rather than the track. */
	play(station, now = Date.now()) {
		if (!station.paused) return station
		station.startedAt = now - station.pausedElapsedMs
		station.paused = false
		station.pausedElapsedMs = 0
		this.scheduleAdvance(station, now)
		return station
	}

	pause(station, now = Date.now()) {
		if (station.paused) return station
		station.pausedElapsedMs = station.elapsedMs(now)
		station.paused = true
		this.clearAdvance(station)
		return station
	}

	/** Move the whole station, not one listener: everyone lands on the same second. */
	skip(station, delta = 1, now = Date.now()) {
		const count = station.order.length || 1
		station.cursor = (((station.cursor + delta) % count) + count) % count
		station.startedAt = now
		station.pausedElapsedMs = 0
		this.scheduleAdvance(station, now)
		return station
	}

	select(station, cursor, now = Date.now()) {
		if (!Number.isFinite(cursor)) return station
		const count = station.order.length || 1
		station.cursor = ((Math.trunc(cursor) % count) + count) % count
		station.startedAt = now
		station.pausedElapsedMs = 0
		this.scheduleAdvance(station, now)
		return station
	}

	clearAdvance(station) {
		if (station.advanceTimer) {
			clearTimeout(station.advanceTimer)
			station.advanceTimer = null
		}
	}

	/**
	 * The station's timeline moves on its own, whether or not anyone is connected.
	 * A client that was offline for two tracks comes back to the right one.
	 */
	scheduleAdvance(station, now = Date.now()) {
		this.clearAdvance(station)
		if (station.paused) return

		const duration = station.durationMs
		if (!duration) return

		const remaining = Math.max(0, duration - station.elapsedMs(now))
		station.advanceTimer = setTimeout(() => {
			station.advanceTimer = null
			this.skip(station, 1)
			this.emit("advance", station.id)
		}, remaining + ADVANCE_GUARD_MS)

		// Never hold the process open just to turn a record over.
		station.advanceTimer.unref?.()
	}

	/** Forget stations nobody has listened to for a while. */
	sweepEmpty(maxIdleMs, now = Date.now()) {
		const closed = []
		for (const [id, station] of this.stations) {
			if (station.listenerCount > 0 || station.emptySince === null) continue
			if (now - station.emptySince < maxIdleMs) continue
			this.clearAdvance(station)
			this.stations.delete(id)
			closed.push(id)
			this.emit("station:closed", { stationId: id, name: station.name })
		}
		return closed
	}
}
