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
rebuild `data/transcripts.json`, and write Korean glosses for the hard words/idioms in each
segment. Run from the repo root; `yt-dlp` is on PATH.

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
- Duration: prefer **2–12 min** (120–720s); skip Shorts (<60s). Keep videos short because
  you have to read **every segment** to gloss it (next section), and a segment is ≤2
  sentences — so prefer videos that land **under ~30 segments**. Longer videos (12+ min /
  30+ segments) are out of scope unless the user explicitly asks for one.
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
- **Estimate segment count from the VTT you just downloaded** and skip videos over ~30.
  A segment is ≤2 sentences, so segments ≈ (number of sentence-enders) ÷ 2:
  ```bash
  S=$(grep -oE '[.!?]"?[)\]]?(\s|$)' "$T/ID.en.vtt" | wc -l); echo "ID ~$((S/2)) segs"
  ```
  This is a rough proxy (good enough to reject the obviously-too-long); the exact count
  comes from the build in step 4. If it's clearly over 30, drop the candidate.
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
another candidate. Also check the real segment count here: if a video built to **more than
30 segments**, remove it (too long to gloss well) unless the user asked for it.

### 5. Write Korean glosses for learners (target: OPIC IH / TOEIC 800)
For each newly added video, read its built segments and gloss every expression an
**upper-intermediate Korean learner (OPIC IH / TOEIC 800)** would find worth studying —
**idioms, phrasal verbs, collocations, and any B2+ / less-common vocabulary**, including
tricky polysemes whose meaning *here* differs from the basic one (e.g. `content` 만족하는,
`singular` 각별한, `storied` 화려한 이력의). Be **generous**: cover these thoroughly rather than
picking only the single hardest item. This is **not** a full translation — keep skipping
truly basic words (run, happy, ship, …), and leave low-value segments empty. In practice
that lands around **2–5 entries on substantive segments**, with plenty of segments at 0;
across a talk expect roughly **1–1.7 glosses per segment** (a ~33-segment TED talk ≈ 50–60
glosses). These show up in the app under the caption on the later loops, so each one should
be genuine help, not noise. Dump a video's segments to read them:
```bash
node -e 'const d=require("./data/transcripts.json");const v=d.videos.find(v=>v.id===process.argv[1]);v.segments.forEach((s,i)=>console.log(i+":", s.lines.map(l=>l.text).join(" ")))' VIDEOID
```
Edit `data/glossary.json`, keyed by video id then **segment index** (a string), each entry
`{ term, ko, type }` (`type` ∈ `idiom` | `phrase` | `word`):
```json
"VIDEOID": {
  "3": [
    { "term": "pull it off", "ko": "해내다, 성공시키다", "type": "idiom" },
    { "term": "albeit", "ko": "비록 ~이긴 하지만", "type": "word" }
  ],
  "7": [{ "term": "infant", "ko": "갓난아기", "type": "word" }]
}
```
- `term` is the English as it appears (use `...` for a span, e.g. `"welcomed ... into the world"`).
- `ko` is a short Korean gloss in context — the meaning *here*, not a dictionary dump.
- Keep `data/glossary.json` valid JSON; the leading `"//"` note stays.

Then merge the glosses into the built data **without re-downloading**:
```bash
npm run build:glossary
```
Verify a couple landed:
```bash
node -e 'const d=require("./data/transcripts.json");const v=d.videos.find(v=>v.id===process.argv[1]);v.segments.forEach((s,i)=>s.glossary&&console.log(i, s.glossary.map(g=>g.term+"→"+g.ko).join(" | ")))' VIDEOID
```

## Report back
Summarize: the videos added (title · url · #segments · tag · category · #glosses), any
strong candidates skipped for lacking manual captions or for being too long (>30 segments),
and the count scanned. Mention that `videos.json`, `data/transcripts.json`, and
`data/glossary.json` changed and are ready for the user to review/commit.

## Guardrails
- Never add auto-only videos. Verified manual `en` captions are required.
- Skip videos over ~30 segments (too long to gloss) unless the user asks for one.
- Keep `videos.json` and `data/glossary.json` valid JSON at all times.
- You may edit `videos.json` and `data/glossary.json` only. Don't touch `app.js`,
  `index.html`, `styles.css`, or the build script — this is data curation only.
- Don't commit, push, or deploy unless the user explicitly asks. Leave the working tree
  changes for the user.
