# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Shadow Loop is a YouTube English-shadowing web app. Users pick a sample (or paste a YouTube URL), and the app splits the video into 30–60 second segments for repeat listening, shadowing, and memorization practice. The UI is in Korean; the shadowing content is English.

No build step, no framework, no dependencies, no backend logic — vanilla ES-module JavaScript and a static file server. It deploys as a pure static site (e.g. Vercel; see `vercel.json`). There is no in-app transcript: English captions come from YouTube's own CC (the player is configured to auto-enable them). The app's job is curated/segmented looping, playback-speed control, and voice recording — not displaying caption text.

## Commands

```bash
npm run dev      # start the server (node server.js) at http://localhost:4173
npm run check    # syntax-check server.js and app.js via node --check (this is the only "test")
PORT=3000 npm run dev   # override the port
```

There is no test suite, linter, or bundler. `npm run check` is the full verification story; run it after editing `server.js` or `app.js`.

## Architecture

**`server.js`** — a static file server only (no API). `serveStatic` confines reads to the project root (path-normalization check) and sends `Cache-Control: no-store`. It exists for local dev (`npm run dev`); in production the static files are served directly (Vercel). All app logic lives in the client.

**`app.js`** — the entire client. Drives the YouTube IFrame Player API and a single mutable `state` object; `render()` re-renders the segment list and now-playing panel from `state` on every change (no virtual DOM, no reactivity — call `render()` after mutating state).

Key client mechanics:
- `samples` (top of file) are five curated TED-style talks pre-split into good 30–60s segments. Each segment still carries a `text` field (kept from when captions were shown), but it is no longer rendered anywhere — only the `start`/`end` timings are used.
- The YouTube player is created with `cc_load_policy: 1` / `cc_lang_pref: "en"` so English CC auto-loads (the user toggles it in the player otherwise).
- `loadVideo()` sets up state and the player. Selecting a sample loads its curated segments; pasting a non-sample URL builds time-only segments via `makeFallbackSegments(duration)` (`state.source === "custom"`).
- The segment-looping engine is `tick()`, a `requestAnimationFrame` loop that polls `player.getCurrentTime()` and, when playback passes the current segment's end, either repeats the segment (when repeat is on), advances, or pauses. Each frame it also drives the **loop ring** (`updateRing`): the segment's elapsed fraction is written to the `#ringProgress` SVG circle's `stroke-dashoffset`, so the amber ring around the play button fills over the segment and snaps back on each loop. This is the page's signature element.
- The UI is mobile-first: a single column (masthead → source → player → console card → segment list) that becomes a two-column layout (player+console left, sticky segment list right) at `min-width: 880px`. Fonts are loaded from CDN (`<link>` only): Pretendard for Korean UI, Space Grotesk for the wordmark/labels, DM Mono for timecodes and segment indices.
- Keyboard shortcuts: space = play/pause, ←/→ = prev/next segment, `r` = toggle repeat.

The app was deliberately trimmed to the core looping flow — there is **no** voice recording, no per-segment progress/localStorage, and no listen/shadow mode tabs. Repeat is the only loop toggle (on by default).

`index.html` wires DOM IDs that `app.js` queries by selector (the `els` object) — renaming an element ID requires updating `els` in `app.js`.
