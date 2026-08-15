/**
 * The only file in the app that starts sound.
 *
 * It never calls start(0), and it never plays on message receipt. Every playback
 * decision goes through planPlayback(), which converts the station's startedAt
 * timestamp into a moment on this device's audio clock using the measured offset.
 */

import { DRIFT_TOLERANCE_MS, driftMs, planPlayback } from "/lib/sync/clock.js"

export class AudioEngine {
	constructor(onEvent = () => {}) {
		this.context = null
		this.gain = null
		this.source = null
		/** src -> decoded AudioBuffer */
		this.buffers = new Map()
		/** src -> in-flight decode, so two joins do not fetch the same track twice */
		this.pending = new Map()
		/** stationClock - localClock, pushed in from the offset measurement */
		this.clockOffsetMs = 0
		this.current = null
		this.muted = false
		this.onEvent = onEvent
	}

	ensureContext() {
		if (this.context) return this.context
		const Context = window.AudioContext ?? window.webkitAudioContext
		this.context = new Context({ latencyHint: "interactive" })
		this.gain = this.context.createGain()
		this.gain.gain.value = 0.9
		this.gain.connect(this.context.destination)
		return this.context
	}

	/** Browsers start the context suspended until a real user gesture. */
	async resume() {
		const context = this.ensureContext()
		if (context.state === "suspended") await context.resume()
		return context.state
	}

	async load(track) {
		if (!track?.src) return null
		const cached = this.buffers.get(track.src)
		if (cached) return cached

		const inFlight = this.pending.get(track.src)
		if (inFlight) return inFlight

		const context = this.ensureContext()
		const work = (async () => {
			// Goes through the service worker, so this succeeds with no network once cached.
			const response = await fetch(track.src)
			if (!response.ok) throw new Error(`audio ${response.status}`)
			const bytes = await response.arrayBuffer()
			const buffer = await context.decodeAudioData(bytes)
			this.buffers.set(track.src, buffer)
			this.pending.delete(track.src)
			return buffer
		})()

		this.pending.set(track.src, work)
		return work
	}

	setClockOffset(offsetMs) {
		if (Number.isFinite(offsetMs)) this.clockOffsetMs = offsetMs
	}

	/**
	 * Put this device where the station says it should be.
	 *
	 * This is the whole sync mechanism, and it is the same three lines whether the
	 * client is joining fresh, joining late, or coming back from a dropped socket —
	 * there is no special case, because the maths does not need one.
	 */
	async applySnapshot(snapshot, reason = "sync") {
		if (!snapshot?.track) return null
		const context = this.ensureContext()
		const buffer = await this.load(snapshot.track)
		if (!buffer) return null

		const plan = planPlayback({
			// Externally received: the station's clock, not this device's.
			startedAt: snapshot.startedAt,
			// Measured, not assumed.
			offsetMs: this.clockOffsetMs,
			localNowMs: Date.now(),
			contextNow: context.currentTime,
			durationMs: snapshot.durationMs || buffer.duration * 1000,
			loop: true,
		})

		this.stop()

		if (snapshot.paused) {
			this.current = { snapshot, plan, startedAtContextTime: null }
			this.onEvent({ type: "paused", reason, plan })
			return plan
		}

		const source = context.createBufferSource()
		source.buffer = buffer
		// Loop rather than end: a gap in the network must not become silence.
		source.loop = true
		source.connect(this.gain)
		// Scheduled for a moment in the near future, seeking to the elapsed position.
		source.start(plan.startAtContextTime, plan.offsetSeconds)

		this.source = source
		this.current = {
			snapshot,
			plan,
			startedAtContextTime: plan.startAtContextTime,
			startedAtOffsetMs: plan.elapsedMs,
		}

		this.onEvent({ type: "scheduled", reason, plan })
		return plan
	}

	stop() {
		if (!this.source) return
		try {
			this.source.onended = null
			this.source.stop()
			this.source.disconnect()
		} catch (error) {
			// Already stopped. Nothing to do.
		}
		this.source = null
	}

	setMuted(muted) {
		this.muted = muted
		if (!this.gain || !this.context) return
		// A short ramp instead of a jump, so muting does not click.
		this.gain.gain.setTargetAtTime(muted ? 0 : 0.9, this.context.currentTime, 0.015)
	}

	/** Where this device actually is, according to its audio clock. */
	positionMs() {
		if (!this.current || !this.context) return 0
		const { snapshot, startedAtContextTime, startedAtOffsetMs } = this.current
		if (startedAtContextTime === null) return snapshot.elapsedMs

		const duration = snapshot.durationMs || 0
		const played = (this.context.currentTime - startedAtContextTime) * 1000
		const position = startedAtOffsetMs + Math.max(0, played)
		return duration > 0 ? position % duration : position
	}

	/** Where the station says it should be, right now. */
	expectedPositionMs() {
		if (!this.current) return 0
		const { snapshot } = this.current
		if (snapshot.paused) return snapshot.elapsedMs
		const duration = snapshot.durationMs || 0
		const stationNow = Date.now() + this.clockOffsetMs
		const raw = Math.max(0, stationNow - snapshot.startedAt)
		return duration > 0 ? raw % duration : raw
	}

	driftMs() {
		if (!this.current || !this.source) return 0
		const { snapshot } = this.current
		return driftMs({
			startedAt: snapshot.startedAt,
			offsetMs: this.clockOffsetMs,
			localNowMs: Date.now(),
			actualElapsedMs: this.positionMs(),
			durationMs: snapshot.durationMs,
			loop: true,
		})
	}

	/**
	 * Audio hardware does not run at exactly wall-clock rate, so devices separate
	 * over a long session. Past the tolerance, reschedule from the same snapshot —
	 * a single clean re-seek, rather than pitch-shifting via playbackRate.
	 */
	async correctDriftIfNeeded() {
		if (!this.current || !this.source) return 0
		const drift = this.driftMs()
		if (Math.abs(drift) <= DRIFT_TOLERANCE_MS) return drift
		await this.applySnapshot(this.current.snapshot, "drift")
		this.onEvent({ type: "drift-corrected", driftMs: drift })
		return drift
	}

	static isAudioUrl(url) {
		return /[.](wav|mp3|m4a|ogg|opus|flac)$/i.test(String(url))
	}
}
