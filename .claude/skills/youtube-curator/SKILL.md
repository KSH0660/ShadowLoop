---
name: youtube-curator
description: >-
  Add YouTube videos to Shadow Loop from a given channel — find videos that have
  human-written (manual) English captions, pick good shadowing candidates, add them to
  videos.json, and rebuild the transcripts. Use on requests like "이 채널에서 동영상 적당히
  추가해줘", "add some videos from <channel>", "<채널>에서 쓸만한 영상 골라서 넣어줘", or asking to
  add specific videos/dramas. Only add videos with MANUAL captions (not auto-generated),
  because those give clean transcripts for shadowing.
---

# Shadow Loop video curator

Given a YouTube channel (or topic/drama), find videos that have **manual (human) English
captions**, choose ones that are good for English shadowing, add them to `videos.json`,
and rebuild `data/transcripts.json`. Run from the repo root; `yt-dlp` is on PATH.

## Why "manual captions only" matters

Manual captions are clean, sentence-formed, and accurately timed — ideal for shadowing.
Auto (ASR) captions are rolling and messy. The build script falls back to auto, but this
skill must NOT add auto-only videos. The reliable test: download **manual** subs only (no
`--write-auto-subs`); if a file appears, the video has manual English captions and the
build step will use them.

## Inputs

The user gives a channel (handle like `@TED`, a channel/`/videos` URL, or a plain name),
or a topic/drama, and optionally how many videos. Defaults if unspecified:
- Count: add **3** good videos.
- Duration: prefer **2–25 min** (120–1500s); skip Shorts (<60s) and very long videos
  (>2400s, e.g. full events) unless the user asks otherwise.
- Audio must be **spoken English** (the captions being English isn't enough — a Korean
  talk show with English subs is not shadowing material; judge from titles/known channel).

If the channel/topic is ambiguous and you can't resolve a handle, do a quick WebSearch or
try `yt-dlp "ytsearch3:<name> channel"`; only ask the user if still unsure.

## Workflow

### 1. List candidate videos (fast, flat)
For a channel, use the `/videos` tab:
```bash
yt-dlp --no-warnings --no-update --flat-playlist -I 1:40 \
  --print "%(id)s | %(duration)s | %(title)s" "https://www.youtube.com/@HANDLE/videos"
```
For a topic/drama without a known channel, search:
```bash
yt-dlp --no-warnings --no-update --flat-playlist \
  --print "%(id)s | %(title)s" "ytsearch20:<topic> clip"
```
`-I 1:40` caps the scan; widen only if needed. Duration is in seconds. Shortlist
candidates by duration window + English-spoken + the user's topic. Shortlist more than you
need (e.g. 8–10) since some will lack manual captions. Official network/channel uploads
are the most likely to carry manual captions.

### 2. Check each candidate for MANUAL English captions
For a candidate id:
```bash
T=$(mktemp -d)
yt-dlp --no-warnings --no-update --skip-download --write-subs --sub-langs en \
  --sub-format vtt -o "$T/%(id)s.%(ext)s" "https://www.youtube.com/watch?v=ID" >/dev/null 2>&1
if [ -f "$T/ID.en.vtt" ] && ! grep -q '<c>' "$T/ID.en.vtt"; then echo "ID MANUAL"; else echo "ID skip"; fi
rm -rf "$T"
```
- A file at `ID.en.vtt` means a manual `en` track exists (note: only the plain `en` track
  counts — that's what the build step downloads; regional-only tracks like `en-US` would
  make the build fall back to auto, so skip those).
- The `grep -q '<c>'` guard rejects anything with per-word ASR tags (auto).
- Go down the shortlist until you have the target count of MANUAL videos. To avoid rate
  limits, only request `--sub-langs en` (never `en.*`), and space out calls if you hit
  HTTP 429 (sleep a few seconds and retry).

### 3. Add to videos.json (skip duplicates)
Read `videos.json`. For each chosen video append an entry to the `videos` array:
```json
{ "id": "VIDEOID", "category": "그룹 라벨", "tag": "Short label", "title": "Readable title" }
```
- Skip any `id` already present.
- `category` is the group label videos are bucketed under in the picker (same string = one
  section, e.g. `"TED 강연"`, `"미드 · 모던 패밀리"`). Reuse an existing category when it fits, or
  make a new Korean label when the user is adding a distinct group. Omitting it defaults to
  `"기타"`.
- `tag` is the chip label — keep it short (≈ ≤18 chars), human, and distinct (a topic or
  speaker, not the full title). `title` is a clean, readable title (trim channel
  boilerplate / emoji).
- Use the Edit tool; keep the JSON valid (comma placement, the leading `"//"` note stays).

### 4. Build and verify
```bash
npm run build:transcripts
```
Then confirm each new id produced real segments:
```bash
node -e 'const d=require("./data/transcripts.json");for(const id of process.argv.slice(1)){const v=d.videos.find(v=>v.id===id);console.log(id, v?`${v.segments.length} segs, first: "${v.segments[0].lines[0].text}"`:"MISSING")}' ID1 ID2 ID3
```
The "first line" should read like a real, clean sentence. If a video came out empty or
messy (e.g. it slipped through as auto), remove it from `videos.json`, rebuild, and pick
another candidate.

## Report back
Summarize: the videos added (title · url · #segments · tag · category), any strong
candidates skipped for lacking manual captions, and the count scanned. Mention that
`videos.json` and `data/transcripts.json` changed and are ready for the user to
review/commit.

## Guardrails
- Never add auto-only videos. Verified manual `en` captions are required.
- Keep `videos.json` valid JSON at all times.
- Don't touch `app.js`, `index.html`, `styles.css`, or the build script — this is data
  curation only.
- Don't commit, push, or deploy unless the user explicitly asks. Leave the working tree
  changes for the user.
