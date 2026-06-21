# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Shadow Loop is a YouTube English-shadowing web app. Users pick one of a curated set of videos and the app loops it in short, sentence-based segments (at most two sentences each) for repeat listening, shadowing, and memorization. Each segment shows its **real transcript** (English captions with timestamps), which stays fixed while the segment loops and reveals itself progressively over the repeats (see the reveal mechanic below). The UI is mobile-first and single-focus — built for glanceable phone use (e.g. driving, eating). The UI is in Korean; the shadowing content is English.

The transcript data is produced by a **local build step** (`npm run build:transcripts`), committed to git, and shipped as a static JSON file — the deployed site never fetches captions at runtime. There is no framework, no runtime dependencies, no backend logic: vanilla JavaScript plus a static file server. It deploys as a pure static site (e.g. Vercel; see `vercel.json`). The app's job is curated/segmented looping, synced caption display, and playback-speed control — not voice recording (there is none).

## Data pipeline (offline / admin)

Runtime has no backend, so captions are pre-extracted:

1. `videos.json` — the admin-managed list of curated videos (`id`, `tag`, optional `title`, optional `category`). Edit this to add/remove videos. `category` is the group label videos are bucketed under in the video-picker sheet (videos sharing the same string form one section, e.g. `"TED 강연"` vs `"예능 · 타블로"`); it defaults to `"기타"`.
2. `npm run build:transcripts` runs `scripts/build-transcripts.mjs`: for each video it shells out to **`yt-dlp`** to download the English VTT captions, parses them into cleaned timestamped lines, merges caption cues into whole sentences (`mergeIntoSentences`), groups them into segments of at most two sentences, and writes `data/transcripts.json`.
3. Commit both `videos.json` and `data/transcripts.json`. The app loads only `data/transcripts.json`.

Requires `yt-dlp` on PATH (build-time only, not a runtime/npm dependency). Segment tuning constants (`SENTENCES_PER_SEG`, `MAX_SEG_SECONDS` — the latter both caps a segment's length and force-breaks a punctuation-less auto-caption run) live at the top of the build script.

The build script auto-detects caption format per video: manual/clean captions are parsed cue-by-cue, while YouTube auto-captions (ASR — detected by per-word `<…><c>` inline timestamps) are reconstructed word-by-word to remove the rolling-window duplication.

**`.claude/skills/youtube-curator/SKILL.md`** is a skill that, given a YouTube channel (or topic/drama), finds videos with *manual* English captions, picks good shadowing candidates, appends them to `videos.json`, and runs the build. It runs in the main conversation (not a subagent), so it can use interactive permission prompts for `yt-dlp`/`npm`. Invoke it via `/youtube-curator` or by asking (e.g. "@TED 채널에서 3개 추가해줘"). It only adds manual-caption videos (clean transcripts) and never commits.

## Commands

```bash
npm run dev               # start the server (node server.js) at http://localhost:4173
npm run build:transcripts # regenerate data/transcripts.json from videos.json (needs yt-dlp)
npm run check             # node --check on server.js, app.js, and the build script (the only "test")
PORT=3000 npm run dev     # override the port
```

There is no test suite, linter, or bundler. `npm run check` is the full verification story; run it after editing `server.js`, `app.js`, or `scripts/build-transcripts.mjs`.

## Architecture

**`server.js`** — a static file server only (no API). `serveStatic` confines reads to the project root (path-normalization check) and sends `Cache-Control: no-store`. It exists for local dev (`npm run dev`); in production the static files are served directly (Vercel). All app logic lives in the client.

**`data/transcripts.json`** — the generated runtime data: `{ generatedAt, videos: [{ id, url, title, tag, category, segments: [{ start, end, lines: [{ text, start, end }] }] }] }`. Do not hand-edit; regenerate via the build step.

**`app.js`** — the entire client. `init()` fetches `data/transcripts.json` into the module-level `videos` array, renders the video list, and loads the first video. It drives the YouTube IFrame Player API and a single mutable `state`; `render()` re-renders the caption, loop dots, segment position, and segment list from `state` (no virtual DOM — call `render()` after mutating state).

Key client mechanics:
- `loadVideo(video)` sets up `state.segments` from the video's pre-built segments and points the player at the **resume** segment — the furthest one the user has reached before (or the first segment if it's new or was finished). There is no URL-paste / fallback path: only curated videos (they're the only ones with transcripts).
- **Watch progress** is the one persisted bit of state. `recordProgress()`/`getVideoProgress()` keep, per video, the furthest segment index reached in `localStorage` (key `shadowloop:v1:progress`; per device — there is no backend/account). It drives resume-on-reopen (`loadVideo`) and the YouTube-style red `.card-progress` bar on each home thumbnail. `selectSegment()` records the position (the value only ever increases); finishing a video leaves the bar full but restarts playback from the top.
- The YouTube player uses `cc_load_policy: 0` (the in-player CC overlay is off — captions are rendered by our own panel instead).
- **Progressive reveal** is the signature interaction. A segment loops while its caption reveals itself: the first listen is fully invisible, then the caption fades in (`--reveal` → `.caption` opacity) while blanked words (`.cap-word.is-hidden` redaction bars) uncover left-to-right, fully clear by the last repeat. The repeat count `state.target` scales with caption length and the **pace** mode (`segmentTarget()` + the `PACE` table: `slow` 3–10 reps, `fast` 2–4, chosen via the 학습 빠르게/천천히 toggle), shown as that many loop dots. The 👁 **peek** button force-shows the full caption while held (`state.peek`, honored by `applyReveal()`) without touching the loop count. There is no plain/fade/cloze or manual repeat toggle.
- The segment-looping + reveal engine is `tick()`, a `requestAnimationFrame` loop that polls `player.getCurrentTime()`. When playback passes the segment's end it either repeats (incrementing `state.loops` and calling `applyReveal()`) or, once `loops + 1 >= target` (fully revealed), **auto-advances** to the next segment (pausing at the last). Each frame it also drives the **loop ring** (`updateRing`): the segment's elapsed fraction is written to the `#ringProgress` SVG circle's `stroke-dashoffset`, so the amber ring around the play button fills over the segment and snaps back on each loop.
- The UI is single-focus "video mode": top bar (`☰` segment list / current-video pill) → player → caption → transport. Navigation lives in two bottom sheets, one open at a time via `openSheet()`: `#segSheet` (segments of the current video) and `#videoSheet` (switch video). Fonts are loaded from CDN (`<link>` only): Pretendard for Korean UI, Space Grotesk for the wordmark/labels, DM Mono for timecodes and indices.
- Keyboard shortcuts: space = play/pause, ←/→ = prev/next segment, Esc = close sheet.

There is **no** voice recording and no listen/shadow mode tabs. The only persisted state is the per-video watch position described above (furthest segment reached, in `localStorage`).

`index.html` wires DOM IDs that `app.js` queries by selector (the `els` object) — renaming an element ID requires updating `els` in `app.js`. The video list, segment list, and caption words are rendered dynamically by `app.js`.
