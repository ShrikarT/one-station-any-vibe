# One Station, Any Vibe

Name a station — anything at all, `trucker's cab 3am`, `2000s bollywood loop`, `hostel corridor` — and
anyone who opens the same name hears the same track at the same second. Join forty seconds late and
you land forty seconds in. Drop your connection mid-song and the music keeps playing off the device
cache, then quietly slides back into position when the socket returns.

Built for the Nostalgic Jukebox battle, problem 1.

---

## Quickstart

```bash
node -v          # needs 20.12+, 22 LTS recommended
npm install      # postinstall generates the audio (about 12MB of wav, ~4s)
npm start        # http://localhost:3000
```

Then, to see the actual thing this problem is about:

1. Open `http://localhost:3000`, type a station name, hit **Join**.
2. Open the same URL in a second window (or on your phone, over the deployed URL) and type the
   **same name**.
3. The second client starts mid-track, on the same beat. Watch its **clock offset** and **drift**
   readouts settle in the telemetry row.
4. Hit **Simulate a dropped connection**. Audio continues. The log shows the resync, and the position
   does not jump back to zero.

### The 60-second proof

Two browser windows side by side, both on `hill road dhaba`, sound on one of them. Skip a track from
window A — window B follows within a frame or two. Now open a third window on `bhojpuri classics`:
different track, different timeline, entirely unbothered by the first two. That is test cases 7 and 8
being true rather than decorative.

---

## Where the load-bearing parts are

| # | Test case | Where it lives |
|---|---|---|
| 1 | Scheduled start from an externally-received timestamp | `public/audio-engine.js` → `AudioEngine.applySnapshot()` feeds the server's `snapshot.startedAt` into `planPlayback()`, then `source.start(plan.startAtContextTime, plan.offsetSeconds)`. Never `start(0)`. |
| 2 | Clock offset estimated **and applied** | Measured in `public/app.js` → `onPong()` (socket) and `measureOffsetOverHttp()` (HTTP), computed by `lib/sync/clock.ts` → `estimateOffset()`, pushed in via `engine.setClockOffset()`, consumed inside `planPlayback({ offsetMs })` on the scheduling path. |
| 3 | Late joiner resumes at the right elapsed position | `lib/sync/clock.ts` → `elapsedAt()` / `planPlayback()` return `offsetSeconds`, which is passed as the second argument to `source.start()` in `public/audio-engine.js`. |
| 4 | Elapsed maths unit tested, including a mid-track join | `lib/sync/clock.test.ts` — non-zero mid-track joins at `47_000ms` and `132_450ms`, plus loop wrap, estimator poisoning and an offset-applied differential. `npm test`. |
| 5 | Reconnect resyncs instead of restarting | `public/app.js` → the socket `close` handler calls `resyncOverHttp()` immediately, then reconnects with backoff and rejoins with `reconnect: true`; the server answers with a live snapshot and `apply()` reschedules to that point. |
| 6 | Committed service worker caches audio | `public/sw.js` (hand-written, committed) → `isAudioRequest()` + `serveAudio()` serve cache-first out of `station-audio-v1`, including `Range` slicing. Registered explicitly in `public/app.js` → `registerServiceWorker()`. |
| 7 | Independent per-station playback state | `server/stations.js` → one `Station` instance per station, each with its own `startedAt`, `cursor`, shuffled `order` and `members`; held in `StationRegistry.stations`. |
| 8 | User-defined identity keys real state | `server/stations.js` → `slugifyStationName()` derives the id, and that id **is** the `Map` key for playback and membership. No preset list exists anywhere in the codebase. |
| 9 | Disconnected clients removed from tracked state | `server/index.js` → socket `close` handler calls `registry.leave()`, which deletes from `station.members`; a 15s heartbeat also reaps sockets that vanished without a close frame. |
| 10 | Join and leave logged distinctly | `server/stations.js` emits `join` and `leave` events; `server/index.js` prints `[station:join]` and `[station:leave]` with client id, reason and listen duration. |

---

## How the sync actually works

### Why `.play()` on message receipt cannot work

A broadcast that says "play now" arrives at a different moment on every device — one phone is 40ms
behind, another is on a 3G tail and 400ms behind. Everyone obeys instantly and everyone is wrong by a
different amount. Worse, `Date.now()` on two phones on the same wifi routinely disagrees by tens or
hundreds of milliseconds, so "start at 12:00:03.500" also means different things to each of them.

So the server never says *play now*. It says:

> this track started at `1786769898665`, on my clock, and my clock currently reads `1786769899712`

Each client then answers two questions locally: *what is that instant on my clock*, and *how far into
the track does that put me*.

### Measuring the offset (NTP, in miniature)

```
client                          station
  |  t0  --------- ping ------->  |
  |                              t1  (stamped on arrival, before any parsing)
  |                              t2  (stamped immediately before the reply)
  |  t3  <-------- pong --------  |

offset = ((t1 - t0) + (t2 - t3)) / 2
rtt    =  (t3 - t0) - (t2 - t1)
```

One sample is a lie in proportion to how asymmetric the network was that instant. So
`estimateOffset()` takes a burst of seven, throws away the slow half by round-trip time, and returns
the **median** of the fastest half. A packet delayed 400ms in one direction skews its own sample badly
and is exactly the sample that gets discarded. The burst is repeated every 20 seconds, and on tab
refocus, because phone clocks are quietly adjusted by NTP under you.

`server/index.js` stamps `t1` before it parses the message body, so the measurement does not include
the server's own JSON work.

### Scheduling against it

```
stationNow      = Date.now() + offsetMs          // local clock -> station clock
elapsedMs       = elapsedAt(startedAt, stationNow + leadMs)
startAtContext  = AudioContext.currentTime + leadMs/1000
source.start(startAtContext, elapsedMs / 1000)
```

The 120ms lead (`DEFAULT_SCHEDULE_LEAD_MS`) is the margin the Web Audio scheduler needs to hit the
target sample-accurately; scheduling for *now* means scheduling for slightly-in-the-past, which the
browser rounds up to "whenever". A late joiner and a client that has been listening for ten minutes
run the same three lines with different inputs — there is no special case for late joins.

### Drift

Audio hardware clocks do not run at exactly the rate of the wall clock, so over a long session the two
separate. Every 3 seconds the client compares where the audio clock actually is against where the
station says it should be (`driftMs()`). Past `DRIFT_TOLERANCE_MS` (120ms — roughly the threshold
where two speakers in one room start sounding like an echo) it reschedules from the same snapshot
instead of nudging `playbackRate`, because pitch-shifting to fix timing is worse than a single clean
re-seek.

---

## Surviving the dhaba

| Failure | What happens |
|---|---|
| Socket drops mid-song | Audio keeps playing — the buffer is already decoded and the wav is in the Cache API. `resyncOverHttp()` fires straight away; reconnect backs off 500ms → 10s. |
| Network fully gone | Service worker serves the shell and audio from cache. The app boots and plays offline; the telemetry row shows the offset going stale. |
| Phone walks out of range without closing | 15s heartbeat notices the missing pong, logs `[socket:stale]`, and removes the client from membership. |
| Client returns after 5 minutes | Rejoins with `reconnect: true`, gets the current snapshot, reschedules to the current position. The station never restarted. |
| Everyone leaves a station | It idles for 10 minutes and is swept (`sweepEmpty`), so the process does not accumulate dead stations. |
| Track ends while a client is offline | The server advances on its own timer and the station's timeline continues; the returning client is told the new track, not the old one. |

---

## Layout

```
lib/sync/clock.ts        the sync maths, framework-free and unit tested
lib/sync/clock.test.ts   node:test assertions for elapsedAt and friends
public/lib/sync/clock.js compiled output, committed so the browser can import it
                         with no bundler (npm run build:sync regenerates it)

server/stations.js       Station + StationRegistry: per-station timeline and membership
server/index.js          node:http static serving + ws; the station time reference

public/index.html        two screens: name a station, then the deck
public/styles.css        warm and dim; a radio on a shelf, not a dashboard
public/app.js            offset measurement, join/reconnect, UI, telemetry
public/audio-engine.js   the only file that starts sound, and only on a schedule
public/sw.js             committed service worker: shell + audio caches

scripts/make-audio.mjs   synthesises the eight station beds (no deps)
```

### Commands

```bash
npm start          # serve on PORT (default 3000)
npm test           # the sync unit tests
npm run audio      # regenerate public/audio/*.wav
npm run build:sync # lib/sync/clock.ts -> public/lib/sync/clock.js
npm run typecheck  # tsc --noEmit
```

---

## Deploying

The server holds long-lived WebSocket connections and in-memory station state, so it wants an
always-on process, **not** a serverless platform. Render, Railway and Fly all work with zero config:
build `npm install`, start `npm start`, and the app binds `process.env.PORT`.

One caveat worth knowing before you demo: **service workers only register in a secure context.** Over
`http://192.168.1.x:3000` on your phone, everything works except caching, silently. Use the deployed
HTTPS URL or `ngrok http 3000` when you want to show the offline behaviour.

---

## The audio

Eight instrumental beds, synthesised from scratch by `scripts/make-audio.mjs` — sine and reed tones
over `bhoop`, `durga`, `malkauns`, `kafi` and `yaman`, with a tanpura-ish pluck and a filtered-noise
shaker, rendered to 22.05kHz mono wav. They are meant to sound like a radio on a shelf at 6am rather
than like anything you would recognise.

This is a deliberate choice, not a shortcut. A hackathon repo has no business committing music it does
not have the rights to, and a sync demo needs audio that can be seeked into, looped and cached. The
wav files are gitignored and generated on `npm install` from fixed seeds, so every clone renders
byte-identical files instead of carrying 12MB through git history.

Swapping in real tracks means dropping files into `public/audio/` and editing `tracks.json`. Nothing
in the sync path knows or cares what the audio is.

---

## Decisions worth defending

**No bundler, no framework.** The client is three ES modules the browser loads directly. For a problem
whose whole difficulty is timing, a build step is an extra place for the maths to get lost — and the
judge can read `source.start(plan.startAtContextTime, plan.offsetSeconds)` in the same file that
fetched the timestamp.

**The server owns time; clients own nothing.** Clients never write timeline state. A client can ask a
station to skip, and the station decides what that means and tells everyone. This is why two clients
cannot fight over position.

**One `AudioBufferSourceNode`, `loop = true`.** A gap in the network must not produce silence, so the
current track loops rather than ending. When the server advances, everyone gets the new track.

**WebSocket over WebRTC.** WebRTC would remove the server hop for latency, but somebody still has to
be the clock, and a mesh of phones on patchy signal is a worse clock than one process. The offset
measurement is what buys accuracy here, not the transport.

**Offset over HTTP as well as WebSocket.** `/api/time` and `/api/stations/:id` mean a client whose
socket is dead but whose network is back can resync in one round trip, before the socket finishes
reconnecting.

**Slugs, not raw names, as keys.** `Hill Road Dhaba`, `hill road dhaba` and `hill-road-dhaba` are one
station, because two people typing the same place differently should end up in the same room. Names
that slugify to nothing (emoji, non-Latin scripts) fall back to a hash of the original, so a station
called 🎧 still gets a stable, distinct id rather than colliding with every other unslugifiable name.

---

## Known limits

- **State is in memory.** Restart the server and stations are gone. A single process is the right
  shape for this demo; multiple instances would need Redis for the station map and a shared clock
  source.
- **No auth.** Anyone in a station can skip the track for everyone. That is the point at a tea stall
  and would be a problem anywhere else.
- **Offset accuracy is bounded by network symmetry.** On a very asymmetric link the median of the
  fastest half is still biased; the residual shows up in the drift readout, which is why it is on
  screen rather than hidden.
- **iOS needs a real tap.** Audio cannot start without a user gesture, so a deep link opens the
  station name pre-filled with **Join** focused rather than auto-playing.
- **The progress bar nudges, it does not scrub.** Seeking to an arbitrary second for everyone at once
  is a station-wide operation and would need its own protocol message; skip and previous cover the
  demo honestly.
