#!/usr/bin/env node
/**
 * Rebuild public/audio/tracks.json from whatever is actually sitting in
 * public/audio.
 *
 * The generated beds are there so the repo works on a clean clone with no
 * network and no licensing questions. They are not what you want playing in a
 * demo. Drop your own files in public/audio, run this, restart the server:
 *
 *   npm run audio:scan
 *
 * Durations are read out of the files themselves — wrong durations mean wrong
 * sync, so this never guesses. WAV and MP3 are parsed directly; anything else
 * needs ffprobe on your PATH.
 */

import { spawnSync } from "node:child_process"
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { extname, join } from "node:path"
import { fileURLToPath } from "node:url"

const AUDIO_DIR = fileURLToPath(new URL("../public/audio/", import.meta.url))
const MANIFEST = join(AUDIO_DIR, "tracks.json")
const PLAYABLE = new Set([".mp3", ".wav", ".m4a", ".ogg", ".opus", ".flac"])

// --------------------------------------------------------------------------
// durations
// --------------------------------------------------------------------------

/** WAV: byteRate from the fmt chunk, bytes from the data chunk. Exact. */
function wavDurationMs(buffer) {
	if (buffer.toString("ascii", 0, 4) !== "RIFF") return null
	let position = 12
	let byteRate = 0
	let dataBytes = 0
	while (position + 8 <= buffer.length) {
		const id = buffer.toString("ascii", position, position + 4)
		const size = buffer.readUInt32LE(position + 4)
		if (id === "fmt ") byteRate = buffer.readUInt32LE(position + 16)
		if (id === "data") dataBytes = Math.min(size, buffer.length - position - 8)
		position += 8 + size + (size % 2)
	}
	if (!byteRate || !dataBytes) return null
	return Math.round((dataBytes / byteRate) * 1000)
}

const MPEG1_LAYER3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
const MPEG2_LAYER3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]
const SAMPLE_RATES = {
	3: [44100, 48000, 32000], // MPEG 1
	2: [22050, 24000, 16000], // MPEG 2
	0: [11025, 12000, 8000], // MPEG 2.5
}

/**
 * MP3: prefer the Xing/Info frame count, which is exact for VBR too. Fall back to
 * file size over bitrate, which is only right for constant bitrate.
 */
function mp3DurationMs(buffer) {
	let start = 0
	if (buffer.toString("ascii", 0, 3) === "ID3") {
		const size =
			((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) | ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f)
		start = 10 + size
	}

	let frame = -1
	for (let index = start; index < Math.min(buffer.length - 4, start + 200_000); index += 1) {
		if (buffer[index] === 0xff && (buffer[index + 1] & 0xe0) === 0xe0) {
			frame = index
			break
		}
	}
	if (frame === -1) return null

	const b1 = buffer[frame + 1]
	const b2 = buffer[frame + 2]
	const b3 = buffer[frame + 3]
	const versionBits = (b1 >> 3) & 3
	const layerBits = (b1 >> 1) & 3
	if (versionBits === 1 || layerBits !== 1) return null // reserved, or not layer 3

	const sampleRate = SAMPLE_RATES[versionBits]?.[(b2 >> 2) & 3]
	const table = versionBits === 3 ? MPEG1_LAYER3 : MPEG2_LAYER3
	const bitrate = table[(b2 >> 4) & 0xf] * 1000
	const samplesPerFrame = versionBits === 3 ? 1152 : 576
	if (!sampleRate || !bitrate) return null

	const mono = ((b3 >> 6) & 3) === 3
	const sideInfo = versionBits === 3 ? (mono ? 17 : 32) : mono ? 9 : 17
	const tagAt = frame + 4 + sideInfo
	const tag = buffer.toString("ascii", tagAt, tagAt + 4)

	if (tag === "Xing" || tag === "Info") {
		const flags = buffer.readUInt32BE(tagAt + 4)
		if (flags & 1) {
			const frames = buffer.readUInt32BE(tagAt + 8)
			if (frames > 0) return Math.round((frames * samplesPerFrame * 1000) / sampleRate)
		}
	}

	return Math.round(((buffer.length - frame) * 8 * 1000) / bitrate)
}

/** Everything else. Needs ffprobe, which ships with ffmpeg. */
function ffprobeDurationMs(path) {
	const probe = spawnSync(
		"ffprobe",
		["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
		{ encoding: "utf8" },
	)
	if (probe.status !== 0) return null
	const seconds = Number.parseFloat(String(probe.stdout).trim())
	return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null
}

function durationOf(path, extension) {
	try {
		if (extension === ".wav") return wavDurationMs(readFileSync(path))
		if (extension === ".mp3") return mp3DurationMs(readFileSync(path)) ?? ffprobeDurationMs(path)
		return ffprobeDurationMs(path)
	} catch (error) {
		return null
	}
}

// --------------------------------------------------------------------------
// naming
// --------------------------------------------------------------------------

function slug(value) {
	return (
		value
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[\u0300-\u036f]/g, "")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 64) || "track"
	)
}

function titleCase(value) {
	return value.replace(/\b[a-z]/g, (character) => character.toUpperCase())
}

/** "Ilaiyaraaja - Kannullo Nee Roopame.mp3" splits into artist and title. */
function nameParts(fileName) {
	const bare = fileName.slice(0, fileName.length - extname(fileName).length).replace(/[_]+/g, " ").trim()
	const dash = bare.split(/\s+-\s+/)
	if (dash.length >= 2) {
		return { artist: titleCase(dash[0].trim()), title: titleCase(dash.slice(1).join(" - ").trim()) }
	}
	return { artist: "Your library", title: titleCase(bare) }
}

// --------------------------------------------------------------------------
// run
// --------------------------------------------------------------------------

const files = readdirSync(AUDIO_DIR)
	.filter((name) => PLAYABLE.has(extname(name).toLowerCase()))
	.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

if (files.length === 0) {
	console.error(`no audio in ${AUDIO_DIR}`)
	console.error("drop some mp3s in there, or run: npm run audio")
	process.exit(1)
}

const tracks = []
const skipped = []

for (const fileName of files) {
	const path = join(AUDIO_DIR, fileName)
	const extension = extname(fileName).toLowerCase()
	const durationMs = durationOf(path, extension)

	if (!durationMs || durationMs < 1000) {
		skipped.push(fileName)
		continue
	}

	const { artist, title } = nameParts(fileName)
	tracks.push({
		id: slug(fileName.slice(0, fileName.length - extension.length)),
		title,
		artist,
		src: `/audio/${encodeURIComponent(fileName)}`,
		durationMs,
		sizeBytes: statSync(path).size,
	})
}

if (tracks.length === 0) {
	console.error("could not read a duration from any of those files")
	console.error("install ffmpeg (which brings ffprobe) and try again")
	process.exit(1)
}

writeFileSync(
	MANIFEST,
	JSON.stringify({ generatedBy: "scripts/use-my-audio.mjs", tracks }, null, "\t") + "\n",
)

console.log(`${tracks.length} tracks written to public/audio/tracks.json\n`)
for (const track of tracks) {
	const seconds = (track.durationMs / 1000).toFixed(1).padStart(7)
	console.log(`${seconds}s  ${track.title}  \u2014 ${track.artist}`)
}
if (skipped.length > 0) {
	console.log(`\nskipped (no readable duration): ${skipped.join(", ")}`)
}
console.log("\nrestart the server to pick these up")
