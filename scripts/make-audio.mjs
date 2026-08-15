/**
 * Synthesise the station beds.
 *
 * Eight short instrumental loops, rendered from scratch with no dependencies and
 * no samples. A sync demo needs audio that can be seeked into, looped and cached,
 * and a public hackathon repo has no business committing music it does not have
 * the rights to. Fixed seeds mean every clone renders byte-identical files, so the
 * wavs are gitignored and regenerated on npm install instead of living in git.
 *
 *   npm run audio
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, "..", "public", "audio")

/** Low rate on purpose: these are warm, dull loops, and 12MB beats 40MB. */
const SAMPLE_RATE = 22_050
const PEAK = 0.89

/** Scale degrees in semitones. Enough character to tell the stations apart. */
const SCALES = {
	bhoop: [0, 2, 4, 7, 9],
	durga: [0, 2, 5, 7, 9],
	malkauns: [0, 3, 5, 8, 10],
	kafi: [0, 2, 3, 5, 7, 9, 10],
	yaman: [0, 2, 4, 6, 7, 9, 11],
}

const TRACKS = [
	{ id: "chai-stall-morning", title: "Chai Stall Morning", seconds: 32, seed: 101, rootMidi: 57, scale: "bhoop", bpm: 84, brightness: 3400 },
	{ id: "hill-road-dhaba", title: "Hill Road Dhaba", seconds: 36, seed: 202, rootMidi: 55, scale: "durga", bpm: 76, brightness: 3000 },
	{ id: "truckers-cab-night", title: "Trucker's Cab, 3AM", seconds: 40, seed: 303, rootMidi: 50, scale: "malkauns", bpm: 68, brightness: 2400 },
	{ id: "barber-shop-radio", title: "Barber Shop Radio", seconds: 30, seed: 404, rootMidi: 60, scale: "kafi", bpm: 92, brightness: 3800 },
	{ id: "platform-four", title: "Platform Four", seconds: 34, seed: 505, rootMidi: 58, scale: "yaman", bpm: 88, brightness: 3200 },
	{ id: "monsoon-window", title: "Monsoon Window", seconds: 38, seed: 606, rootMidi: 53, scale: "kafi", bpm: 72, brightness: 2600 },
	{ id: "cassette-side-b", title: "Cassette, Side B", seconds: 28, seed: 707, rootMidi: 62, scale: "bhoop", bpm: 96, brightness: 3600 },
	{ id: "long-drive-ghat", title: "Long Drive, Ghat Road", seconds: 42, seed: 808, rootMidi: 48, scale: "malkauns", bpm: 64, brightness: 2200 },
]

/** Deterministic PRNG, so the same seed always renders the same file. */
function mulberry32(seed) {
	let state = seed >>> 0
	return () => {
		state = (state + 0x6d2b79f5) >>> 0
		let t = state
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

const midiToHz = (midi) => 440 * Math.pow(2, (midi - 69) / 12)

/** Odd harmonics only: a hollow, reedy tone rather than a pure sine. */
function reed(phase, harmonics = 7) {
	let value = 0
	for (let h = 1; h <= harmonics; h += 2) {
		value += Math.sin(phase * h) / h
	}
	return value * 0.62
}

/** One-pole lowpass. Takes the fizz off the noise layer. */
function lowpass(samples, cutoffHz) {
	const rc = 1 / (2 * Math.PI * cutoffHz)
	const dt = 1 / SAMPLE_RATE
	const alpha = dt / (rc + dt)
	let last = 0
	for (let i = 0; i < samples.length; i += 1) {
		last += alpha * (samples[i] - last)
		samples[i] = last
	}
	return samples
}

function render(track) {
	const random = mulberry32(track.seed)
	const scale = SCALES[track.scale]
	const frames = Math.round(track.seconds * SAMPLE_RATE)
	const out = new Float32Array(frames)

	const root = midiToHz(track.rootMidi)
	const fifth = midiToHz(track.rootMidi + 7)
	const beatSeconds = 60 / track.bpm

	// Layer 1: a drone, root plus fifth, breathing slightly.
	for (let i = 0; i < frames; i += 1) {
		const t = i / SAMPLE_RATE
		const breathe = 0.82 + 0.18 * Math.sin(2 * Math.PI * 0.06 * t)
		out[i] += 0.28 * breathe * Math.sin(2 * Math.PI * root * t)
		out[i] += 0.16 * breathe * Math.sin(2 * Math.PI * fifth * t + 0.7)
	}

	// Layer 2: a slow melody wandering up and down the scale, one note per two beats.
	const noteSeconds = beatSeconds * 2
	const noteCount = Math.ceil(track.seconds / noteSeconds)
	let degree = 0
	for (let n = 0; n < noteCount; n += 1) {
		const step = random()
		degree += step < 0.42 ? 1 : step < 0.78 ? -1 : 0
		if (degree < 0) degree += scale.length
		const octave = degree >= scale.length ? 12 : 0
		const semitone = scale[degree % scale.length] + octave
		const hz = midiToHz(track.rootMidi + 12 + semitone)

		const start = Math.round(n * noteSeconds * SAMPLE_RATE)
		const length = Math.round(noteSeconds * SAMPLE_RATE)
		for (let i = 0; i < length; i += 1) {
			const index = start + i
			if (index >= frames) break
			const progress = i / length
			// Slow swell in, long tail out.
			const envelope = Math.min(1, progress * 6) * Math.pow(1 - progress, 1.4)
			out[index] += 0.3 * envelope * reed((2 * Math.PI * hz * i) / SAMPLE_RATE)
		}
	}

	// Layer 3: a tanpura-ish pluck on the beat, decaying fast.
	const pluckCount = Math.floor(track.seconds / beatSeconds)
	for (let p = 0; p < pluckCount; p += 1) {
		if (random() < 0.35) continue // leave gaps, so it does not tick like a metronome
		const semitone = scale[Math.floor(random() * scale.length)]
		const hz = midiToHz(track.rootMidi + semitone)
		const start = Math.round(p * beatSeconds * SAMPLE_RATE)
		const length = Math.round(0.9 * SAMPLE_RATE)
		for (let i = 0; i < length; i += 1) {
			const index = start + i
			if (index >= frames) break
			const envelope = Math.exp(-4.2 * (i / SAMPLE_RATE))
			out[index] += 0.22 * envelope * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE)
		}
	}

	// Layer 4: filtered noise, so the room has air in it.
	const shaker = new Float32Array(frames)
	for (let i = 0; i < frames; i += 1) shaker[i] = random() * 2 - 1
	lowpass(shaker, track.brightness)
	for (let i = 0; i < frames; i += 1) {
		const pulse = 0.5 + 0.5 * Math.sin((2 * Math.PI * i) / (beatSeconds * SAMPLE_RATE))
		out[i] += 0.05 * pulse * shaker[i]
	}

	// Normalise, then fade the edges so the loop point is not a click.
	let loudest = 0
	for (let i = 0; i < frames; i += 1) loudest = Math.max(loudest, Math.abs(out[i]))
	const gain = loudest > 0 ? PEAK / loudest : 1
	const fade = Math.round(0.04 * SAMPLE_RATE)
	for (let i = 0; i < frames; i += 1) {
		let value = out[i] * gain
		if (i < fade) value *= i / fade
		if (i > frames - fade) value *= (frames - i) / fade
		out[i] = value
	}
	return out
}

/** 16-bit mono PCM. Written by hand; no encoder to install. */
function toWav(samples) {
	const dataBytes = samples.length * 2
	const buffer = Buffer.alloc(44 + dataBytes)
	buffer.write("RIFF", 0)
	buffer.writeUInt32LE(36 + dataBytes, 4)
	buffer.write("WAVE", 8)
	buffer.write("fmt ", 12)
	buffer.writeUInt32LE(16, 16)
	buffer.writeUInt16LE(1, 20) // PCM
	buffer.writeUInt16LE(1, 22) // mono
	buffer.writeUInt32LE(SAMPLE_RATE, 24)
	buffer.writeUInt32LE(SAMPLE_RATE * 2, 28)
	buffer.writeUInt16LE(2, 32)
	buffer.writeUInt16LE(16, 34)
	buffer.write("data", 36)
	buffer.writeUInt32LE(dataBytes, 40)
	for (let i = 0; i < samples.length; i += 1) {
		const clamped = Math.max(-1, Math.min(1, samples[i]))
		buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2)
	}
	return buffer
}

mkdirSync(OUT_DIR, { recursive: true })

const manifest = { generatedBy: "scripts/make-audio.mjs", tracks: [] }
for (const track of TRACKS) {
	const wav = toWav(render(track))
	writeFileSync(join(OUT_DIR, `${track.id}.wav`), wav)
	manifest.tracks.push({
		id: track.id,
		title: track.title,
		artist: "Station Bed",
		src: `/audio/${track.id}.wav`,
		// Exact, not measured: the client schedules against this number.
		durationMs: track.seconds * 1000,
	})
	console.log(`  ${track.id}.wav  ${track.seconds}s  ${(wav.length / 1024).toFixed(0)}KB`)
}

writeFileSync(join(OUT_DIR, "tracks.json"), `${JSON.stringify(manifest, null, "\t")}\n`)
console.log(`\n${manifest.tracks.length} tracks written to public/audio`)
