/**
 * Tests for the sync maths.
 *
 *   npm test
 *
 * The load-bearing cases are the mid-track joins: a client arriving 47 seconds
 * into a track must be handed 47 seconds, not zero. Everything else in the app
 * is plumbing around that number.
 */

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
	DEFAULT_SCHEDULE_LEAD_MS,
	DRIFT_TOLERANCE_MS,
	driftMs,
	elapsedAt,
	estimateOffset,
	planPlayback,
	sampleOffsetMs,
	sampleRoundTripMs,
	toLocalTime,
	toStationTime,
	type ClockSample,
} from "./clock.ts"

/** A fixed station clock instant, so failures read the same on every machine. */
const STARTED_AT = 1_786_000_000_000
const TRACK_MS = 210_000

/**
 * Build a round-trip sample for a device whose clock is `offset` ms ahead of the
 * station, with `up`/`down` ms of one-way network delay.
 */
function sampleFor(offset: number, up: number, down: number, t0: number): ClockSample {
	const t1 = t0 + up + offset
	const t2 = t1 + 1 // the station takes a moment to reply
	const t3 = t2 - offset + down
	return { t0, t1, t2, t3 }
}

describe("elapsedAt", () => {
	it("is zero at the exact moment the track starts", () => {
		assert.equal(elapsedAt(STARTED_AT, STARTED_AT), 0)
	})

	it("is zero for a client that arrives before the track starts", () => {
		// Scheduled for the future: wait at the top rather than seek negative.
		assert.equal(elapsedAt(STARTED_AT, STARTED_AT - 5_000), 0)
	})

	it("gives a mid-track joiner the elapsed position, not zero", () => {
		const joinedAt = STARTED_AT + 47_000
		assert.equal(elapsedAt(STARTED_AT, joinedAt, { durationMs: TRACK_MS }), 47_000)
	})

	it("handles an awkward mid-track join to the millisecond", () => {
		const joinedAt = STARTED_AT + 132_450
		assert.equal(elapsedAt(STARTED_AT, joinedAt, { durationMs: TRACK_MS }), 132_450)
	})

	it("clamps at the end of a track that does not loop", () => {
		const joinedAt = STARTED_AT + TRACK_MS + 30_000
		assert.equal(elapsedAt(STARTED_AT, joinedAt, { durationMs: TRACK_MS }), TRACK_MS)
	})

	it("wraps into the current pass when the track loops", () => {
		const joinedAt = STARTED_AT + TRACK_MS + 12_500
		assert.equal(elapsedAt(STARTED_AT, joinedAt, { durationMs: TRACK_MS, loop: true }), 12_500)
	})

	it("wraps repeatedly for a station that has been up for hours", () => {
		const joinedAt = STARTED_AT + TRACK_MS * 17 + 3_000
		assert.equal(elapsedAt(STARTED_AT, joinedAt, { durationMs: TRACK_MS, loop: true }), 3_000)
	})

	it("is unbounded when no duration is known", () => {
		assert.equal(elapsedAt(STARTED_AT, STARTED_AT + 999_999), 999_999)
	})

	it("refuses to produce nonsense from bad input", () => {
		assert.equal(elapsedAt(Number.NaN, STARTED_AT), 0)
		assert.equal(elapsedAt(STARTED_AT, Number.POSITIVE_INFINITY), 0)
		// A zero or negative duration is ignored rather than dividing by it.
		assert.equal(elapsedAt(STARTED_AT, STARTED_AT + 5_000, { durationMs: 0, loop: true }), 5_000)
	})
})

describe("round-trip samples", () => {
	it("recovers the offset from a symmetric round trip", () => {
		// Device 250ms ahead, 30ms each way.
		assert.equal(sampleOffsetMs(sampleFor(250, 30, 30, 1_000)), 250)
	})

	it("reports wire time without the station's thinking time", () => {
		assert.equal(sampleRoundTripMs(sampleFor(250, 30, 30, 1_000)), 60)
	})

	it("is fooled by an asymmetric round trip, which is why we take many", () => {
		// 12.4s stuck on the uplink turns a +5s clock error into -1.2s.
		assert.equal(sampleOffsetMs(sampleFor(5_000, 0, 12_400, 0)), -1_200)
	})
})

describe("estimateOffset", () => {
	it("says zero, with no confidence, before any measurement", () => {
		const estimate = estimateOffset([])
		assert.equal(estimate.offsetMs, 0)
		assert.equal(estimate.rttMs, Number.POSITIVE_INFINITY)
		assert.equal(estimate.usedSamples, 0)
	})

	it("finds the offset from a burst of clean samples", () => {
		const samples = [
			sampleFor(420, 18, 22, 0),
			sampleFor(420, 20, 20, 500),
			sampleFor(420, 25, 15, 1_000),
			sampleFor(420, 15, 25, 1_500),
			sampleFor(420, 22, 18, 2_000),
		]
		const estimate = estimateOffset(samples)
		assert.equal(estimate.offsetMs, 420)
		assert.ok(estimate.usedSamples >= 1 && estimate.usedSamples <= samples.length)
	})

	it("discards the slow half, so one bad packet cannot move the answer", () => {
		const poisoned = sampleFor(5_000, 0, 12_400, 0)
		assert.equal(sampleOffsetMs(poisoned), -1_200) // what it would have claimed

		const samples = [
			poisoned,
			sampleFor(5_000, 20, 20, 500),
			sampleFor(5_000, 18, 22, 1_000),
			sampleFor(5_000, 25, 15, 1_500),
		]
		const estimate = estimateOffset(samples)
		// This is an estimator, not an oracle: assert it lands within a few ms of the
		// truth and nowhere near what the poisoned sample alone would have claimed.
		assert.ok(Math.abs(estimate.offsetMs - 5_000) <= 5, `expected about 5000, got ${estimate.offsetMs}`)
		assert.ok(estimate.offsetMs > 4_000, "the asymmetric sample must not drag the estimate down")
		assert.ok(estimate.usedSamples < samples.length, "the slow half must actually be discarded")
	})

	it("ignores malformed samples", () => {
		const samples = [
			{ t0: 0, t1: Number.NaN, t2: 1, t3: 40 },
			sampleFor(-90, 20, 20, 500),
		] as ClockSample[]
		assert.equal(estimateOffset(samples).offsetMs, -90)
	})
})

describe("clock conversion", () => {
	it("round trips between local and station time", () => {
		const local = 1_786_000_123_456
		assert.equal(toLocalTime(toStationTime(local, 350), 350), local)
		assert.equal(toStationTime(local, -80), local - 80)
	})
})

describe("planPlayback", () => {
	const base = {
		startedAt: STARTED_AT,
		offsetMs: 0,
		localNowMs: STARTED_AT,
		contextNow: 12.5,
		durationMs: TRACK_MS,
	}

	it("schedules in the near future rather than immediately", () => {
		const plan = planPlayback(base)
		assert.ok(plan.startAtContextTime > base.contextNow, "must not schedule for now")
		assert.equal(plan.startAtContextTime, base.contextNow + DEFAULT_SCHEDULE_LEAD_MS / 1000)
	})

	it("starts a fresh station at the top", () => {
		const plan = planPlayback(base)
		// Only the scheduling lead, so still "from the top" as far as a listener cares.
		assert.equal(plan.elapsedMs, DEFAULT_SCHEDULE_LEAD_MS)
		assert.equal(plan.isLateJoin, false)
	})

	it("hands a late joiner a seek position, in seconds, for start()", () => {
		const plan = planPlayback({ ...base, localNowMs: STARTED_AT + 47_000 })
		assert.equal(plan.elapsedMs, 47_000 + DEFAULT_SCHEDULE_LEAD_MS)
		assert.equal(plan.offsetSeconds, (47_000 + DEFAULT_SCHEDULE_LEAD_MS) / 1000)
		assert.equal(plan.isLateJoin, true)
	})

	it("applies the measured clock offset to the scheduling path", () => {
		// Same instant, same station; this device's clock is 5s behind the station.
		const corrected = planPlayback({ ...base, localNowMs: STARTED_AT + 47_000, offsetMs: 5_000 })
		const ignoringOffset = planPlayback({ ...base, localNowMs: STARTED_AT + 47_000, offsetMs: 0 })

		// If the offset never reached the maths, these would be identical.
		assert.notEqual(corrected.elapsedMs, ignoringOffset.elapsedMs)
		assert.equal(corrected.elapsedMs - ignoringOffset.elapsedMs, 5_000)
		assert.ok(
			Math.abs(corrected.offsetSeconds - ignoringOffset.offsetSeconds - 5) < 1e-6,
			"the seek position must move by the offset too",
		)
	})

	it("wraps a joiner into the current pass of a looping track", () => {
		const plan = planPlayback({
			...base,
			localNowMs: STARTED_AT + TRACK_MS + 9_000,
			loop: true,
		})
		assert.equal(plan.elapsedMs, 9_000 + DEFAULT_SCHEDULE_LEAD_MS)
	})

	it("survives a nonsense lead", () => {
		const plan = planPlayback({ ...base, leadMs: Number.NaN })
		assert.equal(plan.startAtContextTime, base.contextNow + DEFAULT_SCHEDULE_LEAD_MS / 1000)
	})
})

describe("driftMs", () => {
	const base = {
		startedAt: STARTED_AT,
		offsetMs: 0,
		localNowMs: STARTED_AT + 60_000,
		durationMs: TRACK_MS,
	}

	it("is zero when the audio clock agrees with the station", () => {
		assert.equal(driftMs({ ...base, actualElapsedMs: 60_000 }), 0)
	})

	it("is positive when this device is running ahead", () => {
		assert.equal(driftMs({ ...base, actualElapsedMs: 60_400 }), 400)
	})

	it("is negative when this device is lagging", () => {
		assert.equal(driftMs({ ...base, actualElapsedMs: 59_700 }), -300)
	})

	it("does not report a whole track of drift either side of the loop point", () => {
		const drift = driftMs({
			...base,
			localNowMs: STARTED_AT + TRACK_MS - 100,
			actualElapsedMs: 50, // just wrapped
			loop: true,
		})
		assert.equal(drift, 150)
		assert.ok(Math.abs(drift) > DRIFT_TOLERANCE_MS === false || Math.abs(drift) < TRACK_MS / 2)
	})
})
