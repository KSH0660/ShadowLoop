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
segment. Run from the repo root. `yt-dlp` is needed at build time — locally it's usually on
PATH; in a remote/cloud session it may not be, see **Environment setup** below.

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

## Environment setup (do this first in a remote/cloud session)

Locally `yt-dlp` is usually already on PATH and YouTube serves captions fine — skip this
section. But in Claude Code's **remote/cloud environment** two things bite, and you should
fix both up front (one-time per container) instead of rediscovering them mid-run:

1. **`yt-dlp` is not installed.** Install it and call it via the module: `pip install -q
   yt-dlp` then `python3 -m yt_dlp …`. (Also pass `--no-check-certificates` — the proxy uses
   a self-signed CA that yt-dlp's bundled certs reject.)
2. **YouTube bot-blocks caption downloads from the datacenter IP** — search/metadata work,
   but per-video subtitle requests fail with *"Sign in to confirm you're not a bot"* on the
   `web`/`ios`/`android`/`tv_embedded` clients. The fix is the **`web_embedded`** player
   client, which bypasses the check and still exposes the manual `en` track. It returns no
   video formats, so also add `--ignore-no-formats-error` (otherwise yt-dlp aborts with
   "Requested format is not available" even with `--skip-download`). `mweb`/`web` bypass the
   check too but report "has no subtitles", so they're useless here.

The build script (`scripts/build-transcripts.mjs`) calls a bare `yt-dlp`, and the skill must
not edit it. So make a **PATH shim** named `yt-dlp` that injects all of the above and
delegates to the module — then both your manual checks *and* `npm run build:transcripts`
just work:
```bash
pip install -q yt-dlp
mkdir -p ~/.local/bin
cat > ~/.local/bin/yt-dlp <<'EOF'
#!/usr/bin/env bash
exec python3 -m yt_dlp \
  --no-check-certificates \
  --ignore-no-formats-error \
  --extractor-args "youtube:player_client=web_embedded" \
  "$@"
EOF
chmod +x ~/.local/bin/yt-dlp
export PATH="$HOME/.local/bin:$PATH"; hash -r
yt-dlp --version   # confirm the shim resolves
```
The shim lives only in the container (not committed) and is invisible to local rebuilds. All
`yt-dlp` commands below then run as written. If `web_embedded` ever stops bypassing the bot
check, the remaining options are passing cookies (`--cookies`) or a PO-token provider —
neither is available by default here, so report the blocker to the user.

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
Edit `data/glossary.json`, keyed by video id then **segment index** (a string). Each entry
has three **required** fields plus optional **rich** fields:

```json
"VIDEOID": {
  "3": [
    {
      "term": "pull it off",
      "ko": "해내다, 성공시키다",
      "type": "idiom",
      "easy": "어렵거나 위험해 보이는 일을 끝내 성공시키다",
      "nuance": "그냥 'do it'이 아니라, 남들이 못 할 거라 본 걸 멋지게 해냈다는 느낌.",
      "when": "어려운 발표·계획·공연을 결국 성공시켰을 때.",
      "ex": "I didn't think the plan would work, but she pulled it off.",
      "exKo": "그 계획이 될 줄 몰랐는데, 그녀가 결국 해냈다.",
      "vs": "succeed는 담백하게 '성공하다', pull off는 '어려운데도 해내다'의 뉘앙스.",
      "tip": "pull off the road(차를 길가에 대다)와 다르다 — 목적어가 일/성과면 '해내다'."
    },
    { "term": "albeit", "ko": "비록 ~이긴 하지만", "type": "word" }
  ],
  "7": [{ "term": "infant", "ko": "갓난아기", "type": "word" }]
}
```

**Required** (always present — these form the inline chip under the caption):
- `term` — the English as it appears (use `...` for a span, e.g. `"welcomed ... into the world"`).
- `ko` — a short Korean gloss in context (the meaning *here*, not a dictionary dump).
- `type` ∈ `idiom` | `phrase` | `word`.

**Rich** (all optional, all shown in the tap-to-open word-detail sheet — write at a
**TOEIC 700 수준 쉬운 한국어**, 풀어 쓰고 사전 덤프 금지). Add as many as genuinely help; a
plain word may need none, a tricky idiom may use all:
- `easy` — 쉬운 뜻을 아주 풀어 쓴 **한 줄** (어려운 한자어·전문용어 피하기).
- `nuance` — 실제 뉘앙스/느낌 (비슷한 쉬운 말과 무엇이 다른지).
- `when` — 자주 쓰는 상황 (어떤 장면에서 튀어나오는 말인지).
- `ex` — 쉬운 **영어** 예문 (해당 영상 문장 말고, 짧고 일상적인 새 예문).
- `exKo` — 그 예문의 자연스러운 한국어 해석.
- `vs` — 헷갈리는 비슷한 단어와의 차이.
- `tip` — 외우거나 헷갈릴 때의 포인트 (어원·형태·흔한 실수 등).

Guidance: prioritize the rich fields on **idioms / phrasal verbs / tricky polysemes** (where
a learner most needs the extra help) and keep truly simple words to `{ term, ko, type }`.
Don't pad every field with filler — an empty field is better than noise. New videos should be
glossed in this rich format from the start; the older `{ term, ko, type }`-only entries stay
valid and render fine (header only).

Keep `data/glossary.json` valid JSON; the leading `"//"` / `"//schema"` notes stay.

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
