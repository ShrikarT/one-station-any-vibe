/**
 * The sync maths.
 *
 * No DOM, no network, no framework — on purpose. Everything here is a pure
 * function of numbers, so there is exactly one place where "where should this
 * device be in the track right now" is decided, and that place is unit tested.
 *
 * Vocabulary used throughout:
 *   local clock    this device's Date.now(), which is wrong in its own way
 *   station clock  the server's Date.now(), the single reference for a station
 *   offsetMs       stationClock - localClock
 *
 * GENERATED from lib/sync/clock.ts by `npm run build:sync`. Committed on purpose:
 * the browser imports it directly, so there is no bundler between the tested
 * maths and the code that actually schedules audio. Edit the .ts file.
 */
/**
 * Web Audio needs a moment of runway to hit a start time sample-accurately.
 * Scheduling for "now" means scheduling for slightly-in-the-past, which the
 * browser rounds up to "whenever it gets round to it" — the exact sloppiness
 * this whole file exists to avoid.
 */
export const DEFAULT_SCHEDULE_LEAD_MS = 120;
/**
 * Past this much separation between two devices, a listener hears an echo rather
 * than one room. Below it, resyncing would be more disruptive than the error.
 */
export const DRIFT_TOLERANCE_MS = 120;
/** Below this, a joiner is "at the top" and does not need a mid-track notice. */
const LATE_JOIN_THRESHOLD_MS = 250;
const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
function median(values) {
    if (values.length === 0)
        return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
/**
 * The offset implied by one sample.
 *
 * Derivation: the outbound leg took (t1 - t0) as measured across the two clocks,
 * the inbound leg took (t3 - t2). If the network were perfectly symmetric the
 * clock error would be the average of those two, one signed each way — which is
 * what this is. Asymmetry is the entire error term, which is why a single sample
 * is never trusted alone.
 */
export function sampleOffsetMs(sample) {
    return (sample.t1 - sample.t0 + (sample.t2 - sample.t3)) / 2;
}
/** Time on the wire, with the station's own processing time removed. */
export function sampleRoundTripMs(sample) {
    return sample.t3 - sample.t0 - (sample.t2 - sample.t1);
}
/**
 * Estimate this device's clock offset from the station reference.
 *
 * A sample delayed asymmetrically — one leg stuck behind a slow uplink — lies
 * about the clock in proportion to how late it was, and patchy signal produces
 * exactly those. So: sort by round-trip time, keep the fastest half, take the
 * median of that half. Fast round trips have less room to hide asymmetry, and the
 * median survives a single outlier that slipped through.
 */
export function estimateOffset(samples) {
    const usable = (samples ?? []).filter((sample) => sample &&
        isFiniteNumber(sample.t0) &&
        isFiniteNumber(sample.t1) &&
        isFiniteNumber(sample.t2) &&
        isFiniteNumber(sample.t3) &&
        sample.t3 >= sample.t0);
    if (usable.length === 0) {
        // No measurement yet. Zero is the honest answer, and Infinity says "do not
        // trust this" rather than pretending to a confident zero.
        return {
            offsetMs: 0,
            rttMs: Number.POSITIVE_INFINITY,
            sampleCount: samples?.length ?? 0,
            usedSamples: 0,
        };
    }
    const measured = usable
        .map((sample) => ({ offsetMs: sampleOffsetMs(sample), rttMs: sampleRoundTripMs(sample) }))
        .sort((a, b) => a.rttMs - b.rttMs);
    const keep = Math.max(1, Math.ceil(measured.length / 2));
    const fastest = measured.slice(0, keep);
    return {
        offsetMs: median(fastest.map((entry) => entry.offsetMs)),
        rttMs: median(fastest.map((entry) => entry.rttMs)),
        sampleCount: samples.length,
        usedSamples: fastest.length,
    };
}
/** Local timestamp to station timestamp. */
export function toStationTime(localMs, offsetMs) {
    return localMs + offsetMs;
}
/** Station timestamp to local timestamp. */
export function toLocalTime(stationMs, offsetMs) {
    return stationMs - offsetMs;
}
/**
 * How far into the track a client should be at `now`.
 *
 * Both arguments are on the station clock. Convert first with `toStationTime` if
 * you are holding a local timestamp — mixing the two is the bug this signature is
 * shaped to prevent.
 *
 * This is the function a late joiner depends on: it is what turns "the track
 * started at 1786769898665" into "start 47 seconds in".
 */
export function elapsedAt(startedAt, now, options = {}) {
    if (!isFiniteNumber(startedAt) || !isFiniteNumber(now))
        return 0;
    const raw = now - startedAt;
    // The track has not started yet: a client that joins early waits at zero rather
    // than seeking to a negative position, which Web Audio would reject.
    if (raw <= 0)
        return 0;
    const { durationMs, loop = false } = options;
    if (!isFiniteNumber(durationMs) || durationMs <= 0)
        return raw;
    // A looping station is still playing something; a finished one sits at the end.
    return loop ? raw % durationMs : Math.min(raw, durationMs);
}
/**
 * Turn a station timestamp into the two numbers Web Audio actually wants.
 *
 * The whole point: `startAtContextTime` is in the near future on this device's
 * audio clock, and `offsetSeconds` is how far into the buffer to begin. Every
 * client runs this with the same `startedAt` and its own `offsetMs`, and they all
 * land on the same moment of the same track.
 */
export function planPlayback(input) {
    const { startedAt, offsetMs, localNowMs, contextNow, durationMs, loop = false, leadMs = DEFAULT_SCHEDULE_LEAD_MS, } = input;
    const safeLead = isFiniteNumber(leadMs) && leadMs >= 0 ? leadMs : DEFAULT_SCHEDULE_LEAD_MS;
    // Local clock -> station clock. This is where the measured offset earns its keep:
    // drop it and every device is wrong by its own clock error.
    const stationNow = toStationTime(localNowMs, isFiniteNumber(offsetMs) ? offsetMs : 0);
    // Aim at the instant playback will really begin, not the instant we planned it.
    const stationAtStart = stationNow + safeLead;
    const elapsedMs = elapsedAt(startedAt, stationAtStart, { durationMs, loop });
    return {
        startAtContextTime: contextNow + safeLead / 1000,
        offsetSeconds: elapsedMs / 1000,
        elapsedMs,
        isLateJoin: elapsedMs > LATE_JOIN_THRESHOLD_MS,
    };
}
/**
 * How far this device has slipped: positive means running ahead of the station.
 *
 * Wrapped into plus or minus half a track so that, on a looping station, being
 * 200ms before the wrap is not reported as being a whole track behind.
 */
export function driftMs(input) {
    const { startedAt, offsetMs, localNowMs, actualElapsedMs, durationMs, loop = false } = input;
    if (!isFiniteNumber(actualElapsedMs))
        return 0;
    const expected = elapsedAt(startedAt, toStationTime(localNowMs, offsetMs), { durationMs, loop });
    let drift = actualElapsedMs - expected;
    if (loop && isFiniteNumber(durationMs) && durationMs > 0) {
        const half = durationMs / 2;
        while (drift > half)
            drift -= durationMs;
        while (drift < -half)
            drift += durationMs;
    }
    return drift;
}
