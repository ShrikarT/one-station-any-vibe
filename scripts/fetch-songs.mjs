/**
 * Fill public/audio/ with real songs.
 *
 * The station beds that ship with this repo are synthesised, which is fine for
 * proving sync and hopeless for atmosphere. This pulls a real library down with
 * yt-dlp and writes a manifest with a `tags` field, which is what makes a station
 * name mean something: see tracksForName() in server/stations.js.
 *
 *   node scripts/fetch-songs.mjs                 everything below
 *   node scripts/fetch-songs.mjs --tag party     just one vibe
 *   node scripts/fetch-songs.mjs --limit 6       just the first six
 *   node scripts/fetch-songs.mjs --force         re-download what is already here
 *
 * Needs yt-dlp and ffmpeg:
 *   winget install yt-dlp.yt-dlp && winget install Gyan.FFmpeg     (Windows)
 *   brew install yt-dlp ffmpeg                                     (macOS)
 *   pipx install yt-dlp                                            (anywhere else)
 *
 * They do not have to be on PATH — see locate(). If they are somewhere unusual:
 *   YT_DLP=/path/to/yt-dlp FFPROBE=/path/to/ffprobe node scripts/fetch-songs.mjs
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const AUDIO_DIR = join(ROOT, "public", "audio")
const MANIFEST = join(AUDIO_DIR, "tracks.json")
const IS_WINDOWS = process.platform === "win32"

/**
 * The library, in four moods.
 *
 * `tags` are matched against the words in whatever the user names their station,
 * so "trucker's cab, 3am" leans on road/night/highway and "sangeet" leans on
 * party/wedding/dance. Nothing here is a preset station: a name that matches
 * nothing simply gets the whole library, shuffled per station.
 */
const CATALOGUE = [
	// --- purani yaadein: the cassette-deck era -------------------------------
	{ id: "chura-liya", title: "Chura Liya Hai Tumne", artist: "Asha Bhosle, Mohammed Rafi", search: "Chura Liya Hai Tumne Jo Dil Ko Yaadon Ki Baaraat audio", tags: ["nostalgia", "retro", "old", "cassette", "radio", "hindi", "love"] },
	{ id: "yeh-shaam-mastani", title: "Yeh Shaam Mastani", artist: "Kishore Kumar", search: "Yeh Shaam Mastani Kati Patang Kishore Kumar audio", tags: ["nostalgia", "retro", "old", "radio", "road", "evening", "hindi"] },
	{ id: "roop-tera-mastana", title: "Roop Tera Mastana", artist: "Kishore Kumar", search: "Roop Tera Mastana Aradhana Kishore Kumar audio", tags: ["nostalgia", "retro", "old", "night", "rain", "hindi"] },
	{ id: "kabhi-kabhie", title: "Kabhi Kabhie Mere Dil Mein", artist: "Mukesh", search: "Kabhi Kabhie Mere Dil Mein Mukesh audio", tags: ["nostalgia", "retro", "old", "night", "love", "hindi", "slow"] },
	{ id: "kya-hua-tera-wada", title: "Kya Hua Tera Wada", artist: "Mohammed Rafi", search: "Kya Hua Tera Wada Hum Kisise Kum Naheen Rafi audio", tags: ["nostalgia", "retro", "old", "sad", "radio", "hindi"] },
	{ id: "musafir-hoon-yaaron", title: "Musafir Hoon Yaaron", artist: "Kishore Kumar", search: "Musafir Hoon Yaaron Parichay Kishore Kumar audio", tags: ["nostalgia", "retro", "old", "road", "highway", "trucker", "travel", "night"] },

	// --- the nineties --------------------------------------------------------
	{ id: "pehla-nasha", title: "Pehla Nasha", artist: "Udit Narayan, Sadhana Sargam", search: "Pehla Nasha Jo Jeeta Wohi Sikandar audio", tags: ["nostalgia", "90s", "retro", "hindi", "love", "dream", "college"] },
	{ id: "tujhe-dekha-to", title: "Tujhe Dekha To Ye Jaana Sanam", artist: "Lata Mangeshkar, Kumar Sanu", search: "Tujhe Dekha To Ye Jaana Sanam DDLJ audio", tags: ["nostalgia", "90s", "retro", "hindi", "love"] },
	{ id: "ek-ladki-ko-dekha", title: "Ek Ladki Ko Dekha", artist: "Kumar Sanu", search: "Ek Ladki Ko Dekha Toh Aisa Laga 1942 A Love Story audio", tags: ["nostalgia", "90s", "retro", "hindi", "love", "slow"] },
	{ id: "chaiyya-chaiyya", title: "Chaiyya Chaiyya", artist: "Sukhwinder Singh, Sapna Awasthi", search: "Chaiyya Chaiyya Dil Se A R Rahman audio", tags: ["nostalgia", "90s", "road", "highway", "train", "dance", "trucker", "hindi"] },

	// --- 2000s: the ipod shuffle years ---------------------------------------
	{ id: "kal-ho-naa-ho", title: "Kal Ho Naa Ho", artist: "Sonu Nigam", search: "Kal Ho Naa Ho title track Sonu Nigam audio", tags: ["2000s", "nostalgia", "bollywood", "hindi", "sad", "slow"] },
	{ id: "woh-lamhe", title: "Woh Lamhe", artist: "Atif Aslam", search: "Woh Lamhe Woh Baatein Zeher Atif Aslam audio", tags: ["2000s", "nostalgia", "night", "rain", "sad", "hostel"] },
	{ id: "tumse-milke-dil-ka", title: "Tumse Milke Dil Ka Jo Haal", artist: "Sonu Nigam", search: "Tumse Milke Dil Ka Jo Haal Main Hoon Na audio", tags: ["2000s", "bollywood", "hindi", "love"] },
	{ id: "kabhi-kabhi-aditi", title: "Kabhi Kabhi Aditi", artist: "Rashid Ali", search: "Kabhi Kabhi Aditi Zindagi Jaane Tu Ya Jaane Na audio", tags: ["2000s", "road", "friends", "college", "sunshine", "trip"] },
	{ id: "pehli-nazar-mein", title: "Pehli Nazar Mein", artist: "Atif Aslam", search: "Pehli Nazar Mein Race Atif Aslam audio", tags: ["2000s", "night", "love", "slow", "hindi"] },
	{ id: "aankhon-mein-teri", title: "Aankhon Mein Teri", artist: "K.K.", search: "Aankhon Mein Teri Ajab Si Om Shanti Om KK audio", tags: ["2000s", "nostalgia", "love", "hindi", "slow"] },

	// --- naya, chatpata ------------------------------------------------------
	{ id: "kesariya", title: "Kesariya", artist: "Arijit Singh", search: "Kesariya Brahmastra Arijit Singh audio", tags: ["new", "2020s", "bollywood", "love", "hindi"] },
	{ id: "apna-bana-le", title: "Apna Bana Le", artist: "Arijit Singh", search: "Apna Bana Le Bhediya Arijit Singh audio", tags: ["new", "2020s", "night", "love", "slow"] },
	{ id: "jhoome-jo-pathaan", title: "Jhoome Jo Pathaan", artist: "Arijit Singh, Sukriti Kakar", search: "Jhoome Jo Pathaan full song audio", tags: ["new", "party", "dance", "chatpate", "club", "bollywood", "gym"] },
	{ id: "what-jhumka", title: "What Jhumka?", artist: "Arijit Singh, Jonita Gandhi", search: "What Jhumka Rocky Aur Rani Kii Prem Kahaani audio", tags: ["new", "party", "dance", "chatpate", "wedding", "sangeet", "baraat"] },
	{ id: "chaleya", title: "Chaleya", artist: "Arijit Singh, Shilpa Rao", search: "Chaleya Jawan Arijit Singh audio", tags: ["new", "2020s", "dance", "love", "bollywood"] },
	{ id: "arjan-vailly", title: "Arjan Vailly", artist: "Bhupinder Babbal", search: "Arjan Vailly Animal full song audio", tags: ["new", "party", "chatpate", "gym", "punjabi", "dance", "club"] },
	{ id: "naatu-naatu", title: "Naatu Naatu", artist: "Rahul Sipligunj, Kaala Bhairava", search: "Naatu Naatu RRR full song audio", tags: ["new", "party", "dance", "chatpate", "telugu", "south", "gym"] },

	// --- telugu, for the home crowd ------------------------------------------
	{ id: "kannullo-nee-roopame", title: "Kannullo Nee Roopame", artist: "A.R. Rahman", search: "Kannullo Nee Roopame Prema Desam audio", tags: ["telugu", "south", "nostalgia", "90s", "rain", "love"] },
	{ id: "cheliya-cheliya", title: "Cheliya Cheliya", artist: "Mani Sharma", search: "Cheliya Cheliya Kushi Telugu audio", tags: ["telugu", "south", "nostalgia", "2000s", "love"] },
	{ id: "manasu-palike", title: "Manasu Palike", artist: "Koti", search: "Manasu Palike Mouna Raagam Nuvve Kavali Telugu audio", tags: ["telugu", "south", "nostalgia", "2000s", "slow", "love"] },
]

function arg(flag) {
	const index = process.argv.indexOf(flag)
	return index === -1 ? null : process.argv[index + 1]
}

/** Does this command actually run? The only test that means anything. */
function runsOk(command, args) {
	try {
		return spawnSync(command, args, { stdio: "ignore" }).status === 0
	} catch (error) {
		return false
	}
}

/** Depth-limited hunt for an executable. Returns the first match. */
function findUnder(dir, filename, depth = 4) {
	if (depth < 0 || !existsSync(dir)) return null

	let entries
	try {
		entries = readdirSync(dir, { withFileTypes: true })
	} catch (error) {
		return null // permissions, junctions, OneDrive placeholders — just move on
	}

	// Files before directories: the shallowest match wins.
	for (const entry of entries) {
		if (entry.isFile() && entry.name.toLowerCase() === filename) return join(dir, entry.name)
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue
		const found = findUnder(join(dir, entry.name), filename, depth - 1)
		if (found) return found
	}
	return null
}

/**
 * Find a binary without trusting PATH.
 *
 * winget installs these happily and then adds its shim directory to PATH by
 * editing the user environment, which a shell that is already open never sees —
 * and neither does an editor that was launched before the install. Opening a new
 * terminal inside that editor does not help either, because it inherits the
 * editor's environment. Rather than explain that to everyone who clones this,
 * look in the places winget actually puts things.
 */
function locate(name, versionArgs, envVar) {
	const override = process.env[envVar]
	if (override && runsOk(override, versionArgs)) return override

	// The normal case, and the fast one.
	if (runsOk(name, versionArgs)) return name

	const filename = IS_WINDOWS ? `${name}.exe` : name
	const localAppData = process.env.LOCALAPPDATA ?? ""
	const searchRoots = [
		ROOT, // dropped next to the project
		join(ROOT, "bin"),
	]

	if (IS_WINDOWS && localAppData) {
		searchRoots.unshift(
			join(localAppData, "Microsoft", "WinGet", "Links"), // the shims
			join(localAppData, "Microsoft", "WinGet", "Packages"), // the real thing
		)
	}

	for (const root of searchRoots) {
		const found = findUnder(root, filename.toLowerCase())
		if (found && runsOk(found, versionArgs)) return found
	}
	return null
}

function durationMsOf(ffprobe, file) {
	const probe = spawnSync(
		ffprobe,
		["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
		{ encoding: "utf8" },
	)
	const seconds = Number.parseFloat(String(probe.stdout ?? "").trim())
	return Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0
}

function existingFileFor(id) {
	if (!existsSync(AUDIO_DIR)) return null
	const match = readdirSync(AUDIO_DIR).find((name) => name === `${id}.mp3` || name === `${id}.m4a`)
	return match ? join(AUDIO_DIR, match) : null
}

function installHint(missing) {
	console.error(`${missing} could not be found, on PATH or anywhere obvious.\n`)
	console.error("  Windows:  winget install yt-dlp.yt-dlp")
	console.error("            winget install Gyan.FFmpeg")
	console.error("  macOS:    brew install yt-dlp ffmpeg")
	console.error("  else:     pipx install yt-dlp   (and install ffmpeg)")
	console.error("")
	console.error("Already installed? Point at it directly, no PATH needed:")
	console.error("  Windows:  $env:YT_DLP=\"C:\\path\\to\\yt-dlp.exe\"; npm run songs")
	console.error("  else:     YT_DLP=/path/to/yt-dlp npm run songs")
	console.error("")
	console.error("Or skip it entirely \u2014 the synthesised beds already work: npm start")
	console.error("Or drop your own mp3s into public/audio/ and run: npm run audio:scan")
}

function download(ytDlp, ffmpegDir, entry) {
	const target = join(AUDIO_DIR, `${entry.id}.%(ext)s`)
	const args = [
		"--no-playlist",
		"--extract-audio",
		"--audio-format", "mp3",
		"--audio-quality", "0",
		// A search, not a hardcoded id: ids rot, titles do not.
		"--default-search", "ytsearch1",
		"--match-filter", "duration < 900",
		"--no-warnings",
		"--quiet",
		"--progress",
		"-o", target,
	]

	// yt-dlp does the download itself but shells out to ffmpeg to make the mp3. If
	// we found ffmpeg somewhere off PATH, yt-dlp will not find it on its own.
	if (ffmpegDir) args.push("--ffmpeg-location", ffmpegDir)

	args.push(entry.search)
	return spawnSync(ytDlp, args, { stdio: ["ignore", "inherit", "inherit"] }).status === 0
}

async function main() {
	const only = arg("--tag")
	const limit = Number(arg("--limit") ?? CATALOGUE.length)
	const force = process.argv.includes("--force")

	const ytDlp = locate("yt-dlp", ["--version"], "YT_DLP")
	if (!ytDlp) {
		installHint("yt-dlp")
		process.exit(1)
	}

	// -version, one dash: ffprobe rejects the GNU-style spelling.
	const ffprobe = locate("ffprobe", ["-version"], "FFPROBE")
	if (!ffprobe) {
		installHint("ffmpeg/ffprobe")
		process.exit(1)
	}

	if (ytDlp !== "yt-dlp") console.log(`yt-dlp:  ${ytDlp}`)
	if (ffprobe !== "ffprobe") console.log(`ffmpeg:  ${dirname(ffprobe)}`)
	const ffmpegDir = ffprobe === "ffprobe" ? null : dirname(ffprobe)

	mkdirSync(AUDIO_DIR, { recursive: true })

	const wanted = CATALOGUE.filter((entry) => (only ? entry.tags.includes(only) : true)).slice(0, limit)
	if (wanted.length === 0) {
		console.error(`nothing tagged "${only}". tags in use: ${[...new Set(CATALOGUE.flatMap((e) => e.tags))].sort().join(", ")}`)
		process.exit(1)
	}

	console.log(`${wanted.length} songs into public/audio/\n`)

	const tracks = []
	let failed = 0

	for (const [index, entry] of wanted.entries()) {
		const position = `${String(index + 1).padStart(2, " ")}/${wanted.length}`
		let file = existingFileFor(entry.id)

		if (file && !force) {
			console.log(`${position}  have   ${entry.title}`)
		} else {
			console.log(`${position}  fetch  ${entry.title} \u2014 ${entry.artist}`)
			if (!download(ytDlp, ffmpegDir, entry)) {
				console.log(`      \u2717 could not fetch, skipping`)
				failed += 1
				continue
			}
			file = existingFileFor(entry.id)
			if (!file) {
				console.log(`      \u2717 nothing landed on disk, skipping`)
				failed += 1
				continue
			}
		}

		const durationMs = durationMsOf(ffprobe, file)
		if (!durationMs) {
			console.log(`      \u2717 unreadable duration, skipping`)
			failed += 1
			continue
		}

		tracks.push({
			id: entry.id,
			title: entry.title,
			artist: entry.artist,
			src: `/audio/${file.split(/[\\/]/).pop()}`,
			durationMs,
			tags: entry.tags,
		})
	}

	if (tracks.length === 0) {
		console.error("\nnothing downloaded, leaving the existing manifest alone.")
		process.exit(1)
	}

	writeFileSync(
		MANIFEST,
		`${JSON.stringify({ generatedBy: "scripts/fetch-songs.mjs", tracks }, null, "\t")}\n`,
	)

	const minutes = Math.round(tracks.reduce((sum, track) => sum + track.durationMs, 0) / 60000)
	console.log(`\n${tracks.length} tracks, about ${minutes} minutes, written to public/audio/tracks.json`)
	if (failed) console.log(`${failed} could not be fetched \u2014 re-run to retry just those`)
	console.log("restart the server to pick them up:  npm start")
	console.log("note: npm install regenerates the synth beds' manifest, so re-run this after installing.")
}

main()
