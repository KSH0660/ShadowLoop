// Shadow Loop client. All video + transcript data is pre-built into
// data/transcripts.json by scripts/build-transcripts.mjs; this file only loads
// that JSON and drives the YouTube player, the segment loop, and the synced
// caption. There is no runtime caption fetching.
//
// The app has two views, like a video site: a HOME browse grid of thumbnail
// cards, and a DETAIL page that plays one video and runs the shadowing loop.
// Clicking a card opens its detail page; the back button returns home. The two
// are wired to the URL hash (#/ = home, #/v/<id> = detail) so the browser's
// back button and deep links work.
//
// Each segment is at most two sentences. It loops while the caption reveals
// itself progressively: the first listen shows nothing, then the text fades in
// with many words still blanked out, and by the last repeat it is fully clear.
// The number of repeats scales with caption length (short → 3, long → 10).
// Once a segment is fully revealed it auto-advances to the next one.

let player;
let playerReady = false;
let videos = [];
let lineEls = [];
let wordEls = [];
let _prevTime = null;    // last polled getCurrentTime(), for user-seek detection
let _seekCooldown = 0;   // performance.now() deadline — suppress seek detection until then
let pendingSegment = null; // segment index to jump to once the next video finishes loading

let state = {
  view: "home",   // "home" (browse grid) | "library" | "words" (vocab) | "detail" (player)
  videoId: null,
  title: "영상을 불러오는 중…",
  segments: [],
  current: 0,
  line: -1,
  speed: 1,
  loops: 0,       // completed repeats of the current segment
  target: 3,      // repeats until fully revealed, scaled by caption length + pace
  cloze: [],      // maskable word indices, in reading order
  pace: "slow",   // slow (3–10 reps) | fast (2–4 reps)
  peek: false,    // holding the peek button → show the full caption
  sheet: null,    // null | "seg" | "notes" | "word"
  bookmarks: new Set(), // current video's saved segment indices (fast lookup for UI)
  wordRecord: null, // the vocab-shaped record currently shown in the #wordSheet
  // 단어장 (vocab) tab state — all transient (rebuilt on demand from localStorage):
  wordsMode: "list",   // "list" | "review" (flashcards) | "quiz"
  wordsFilter: "all",  // "all" | "word" | "phrase" | "idiom" | "wrong" (난이도=type filter)
  reviewToken: 0,      // bumped to reshuffle the flashcard deck
  review: { sig: null, deck: [], pos: 0, flipped: false },
  quiz: null,          // null | { questions, index, score, picked, done }
};

// Korean labels for the gloss `type` (used as the "난이도" axis in the vocab tab).
const TYPE_LABEL = { word: "단어", phrase: "구", idiom: "관용구" };

// Repeats until full reveal, by pace. "slow" drills deeper, "fast" skims.
const PACE = {
  slow: { min: 3, max: 10, base: 3, slope: 0.07 },
  fast: { min: 2, max: 4, base: 2, slope: 0.02 },
};
const RING_CIRCUMFERENCE = 2 * Math.PI * 54;

const els = {
  homeView: document.querySelector("#homeView"),
  libraryView: document.querySelector("#libraryView"),
  wordsView: document.querySelector("#wordsView"),
  detailView: document.querySelector("#detailView"),
  wordsModes: document.querySelector("#wordsModes"),
  wordsBody: document.querySelector("#wordsBody"),
  wordsCount: document.querySelector("#wordsCount"),
  tabWords: document.querySelector("#tabWords"),
  wordSheet: document.querySelector("#wordSheet"),
  wordTerm: document.querySelector("#wordTerm"),
  wordKo: document.querySelector("#wordKo"),
  wordType: document.querySelector("#wordType"),
  wordBody: document.querySelector("#wordBody"),
  wordSaveBtn: document.querySelector("#wordSaveBtn"),
  homeFeed: document.querySelector("#homeFeed"),
  libraryFeed: document.querySelector("#libraryFeed"),
  homeFilters: document.querySelector("#homeFilters"),
  homeCount: document.querySelector("#homeCount"),
  tabHome: document.querySelector("#tabHome"),
  tabLibrary: document.querySelector("#tabLibrary"),
  backBtn: document.querySelector("#backBtn"),
  segBtn: document.querySelector("#segBtn"),
  topbarTitle: document.querySelector("#topbarTitle"),
  videoTitle: document.querySelector("#videoTitle"),
  videoSub: document.querySelector("#videoSub"),
  emptyPlayer: document.querySelector("#emptyPlayer"),
  caption: document.querySelector("#caption"),
  glossary: document.querySelector("#glossary"),
  glossList: document.querySelector("#glossList"),
  segmentList: document.querySelector("#segmentList"),
  segmentCount: document.querySelector("#segmentCount"),
  segPos: document.querySelector("#segPos"),
  loopDots: document.querySelector("#loopDots"),
  timeRange: document.querySelector("#timeRange"),
  prevSegment: document.querySelector("#prevSegment"),
  nextSegment: document.querySelector("#nextSegment"),
  playPause: document.querySelector("#playPause"),
  ringProgress: document.querySelector("#ringProgress"),
  peekBtn: document.querySelector("#peekBtn"),
  paceGroup: document.querySelector("#paceGroup"),
  paceButtons: [...document.querySelectorAll("[data-pace]")],
  speedButtons: [...document.querySelectorAll("[data-speed]")],
  segSheet: document.querySelector("#segSheet"),
  sheetBackdrop: document.querySelector("#sheetBackdrop"),
  aiPromptBtn: document.querySelector("#aiPromptBtn"),
  toast: document.querySelector("#toast"),
  saveSegBtn: document.querySelector("#saveSegBtn"),
  notesBtn: document.querySelector("#notesBtn"),
  notesSheet: document.querySelector("#notesSheet"),
  notesList: document.querySelector("#notesList"),
  notesCount: document.querySelector("#notesCount"),
  notesEmpty: document.querySelector("#notesEmpty"),
};

function onYouTubeIframeAPIReady() {
  player = new YT.Player("player", {
    height: "390",
    width: "640",
    videoId: "",
    playerVars: {
      controls: 1,
      modestbranding: 1,
      rel: 0,
      playsinline: 1,
      cc_load_policy: 0,
      cc_lang_pref: "en",
    },
    events: {
      onReady: () => {
        playerReady = true;
        if (state.view === "detail" && state.videoId) {
          player.loadVideoById({
            videoId: state.videoId,
            startSeconds: state.segments[state.current]?.start || 0,
          });
          player.setPlaybackRate(state.speed);
        }
      },
      onStateChange: handlePlayerState,
    },
  });
}

window.onYouTubeIframeAPIReady = onYouTubeIframeAPIReady;

async function init() {
  try {
    const response = await fetch("data/transcripts.json");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    videos = data.videos || [];
  } catch (error) {
    els.homeFeed.innerHTML = `<p class="home-empty">자막 데이터를 불러오지 못했습니다</p>`;
    return;
  }

  renderHome();
  route(); // open whatever the current hash points to (home or a deep-linked video)
}

// YouTube thumbnail for a video id. hqdefault is 4:3 with letterbox bars; the
// card crops them off with object-fit: cover for a clean 16:9 image.
function thumbnailUrl(id) {
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

// --- Progress (resume + thumbnail bar) -------------------------------------
// The one piece of persisted state: per video, the furthest segment index the
// user has reached, stored in localStorage (per device — there is no backend).
// Used to resume where they left off and to draw the home thumbnail bar.
const PROGRESS_KEY = "shadowloop:v1:progress";

function loadProgress() {
  try {
    return JSON.parse(localStorage.getItem(PROGRESS_KEY)) || {};
  } catch {
    return {};
  }
}

function getVideoProgress(videoId) {
  const entry = loadProgress()[videoId];
  return entry && typeof entry.seg === "number" ? entry : null;
}

// Record the furthest segment reached. Never moves backward, so stepping back
// or finishing-then-restarting doesn't erase how far the user actually got.
function recordProgress(videoId, segIndex, total) {
  if (!videoId || !total) return;
  try {
    const all = loadProgress();
    const prev = all[videoId];
    const seg = prev ? Math.max(prev.seg, segIndex) : segIndex;
    // `at` records the last-touched time so the home "이어보기" row can order
    // in-progress videos most-recent-first. Older entries lack it (treated as 0).
    all[videoId] = { seg, total, at: Date.now() };
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(all));
  } catch {
    // localStorage unavailable (e.g. private mode) — resume/bars just won't persist.
  }
}

// --- Bookmarks (saved segments → personal notes) ---------------------------
// Per video, a list of segments the learner saved to revisit. Stored in
// localStorage alongside progress (per device — no backend). Each entry keeps a
// snapshot of the caption text + timecodes, so it stays self-describing even if
// a transcript rebuild shifts segment indices, and so it's easy to migrate to a
// server later. The `seg` index is used for fast lookup and to jump back.
const BOOKMARKS_KEY = "shadowloop:v1:bookmarks";

function loadBookmarks() {
  try {
    return JSON.parse(localStorage.getItem(BOOKMARKS_KEY)) || {};
  } catch {
    return {};
  }
}

function saveBookmarks(map) {
  try {
    localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(map));
  } catch {
    // localStorage unavailable (e.g. private mode) — saves just won't persist.
  }
}

// The saved segments for one video, ordered by segment index.
function getVideoBookmarks(videoId) {
  const list = loadBookmarks()[videoId];
  return Array.isArray(list) ? list : [];
}

// Toggle a segment's saved state. Returns true if it is now saved, false if removed.
function toggleBookmark(videoId, seg, segment) {
  if (!videoId || !segment) return false;
  const all = loadBookmarks();
  const list = Array.isArray(all[videoId]) ? all[videoId] : [];
  const at = list.findIndex((b) => b.seg === seg);
  let saved;
  if (at >= 0) {
    list.splice(at, 1);
    saved = false;
  } else {
    list.push({
      seg,
      text: segment.lines.map((l) => l.text).join(" ").trim(),
      start: segment.start,
      end: segment.end,
      at: Date.now(),
    });
    list.sort((a, b) => a.seg - b.seg);
    saved = true;
  }
  if (list.length) all[videoId] = list;
  else delete all[videoId];
  saveBookmarks(all);
  return saved;
}

// Remove a saved segment regardless of whether its segment still exists (a
// transcript rebuild can drift indices, leaving an orphaned bookmark).
function removeBookmark(videoId, seg) {
  const all = loadBookmarks();
  const list = Array.isArray(all[videoId]) ? all[videoId] : [];
  const next = list.filter((b) => b.seg !== seg);
  if (next.length) all[videoId] = next;
  else delete all[videoId];
  saveBookmarks(all);
}

// --- Study activity (daily learning heatmap) -------------------------------
// A learning-streak record: per local calendar day, how many segments the user
// finished revealing. Stored in localStorage (per device — no backend), so the
// 보관함 heatmap can show which days were active. Keyed by *local* YYYY-MM-DD
// (NOT UTC) so a late-night session counts toward the right wall-clock day. The
// shape is deliberately self-describing (plain date → count) to make a future
// server migration trivial, mirroring the bookmarks design.
const ACTIVITY_KEY = "shadowloop:v1:activity";

function loadActivity() {
  try {
    const raw = JSON.parse(localStorage.getItem(ACTIVITY_KEY));
    return raw && typeof raw === "object" && raw.days ? raw : { days: {} };
  } catch {
    return { days: {} };
  }
}

// Local-calendar day key, e.g. "2026-06-24". Local (not UTC) so the day boundary
// lines up with the user's clock rather than jumping at UTC midnight.
function dayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Count one completed segment toward today's activity. Called when a segment is
// fully revealed in tick(). Only ever increases the day's tally.
function recordStudy() {
  try {
    const data = loadActivity();
    const k = dayKey();
    data.days[k] = (data.days[k] || 0) + 1;
    localStorage.setItem(ACTIVITY_KEY, JSON.stringify(data));
  } catch {
    // localStorage unavailable (e.g. private mode) — the heatmap just won't fill.
  }
}

// Map a day's completed-segment count to a heatmap intensity level (0–3).
function activityLevel(count) {
  if (count <= 0) return 0;
  if (count >= 6) return 3;
  if (count >= 3) return 2;
  return 1;
}

// Derive the heatmap day map plus the three headline metrics from the stored
// counts. Everything here is computed on read (never persisted) so the metrics
// can't drift out of sync with the raw day tallies.
function activityStats() {
  const days = loadActivity().days;

  // Total distinct days with any activity.
  const total = Object.values(days).filter((n) => n > 0).length;

  // Current streak: walk backward from today while each day has activity. A
  // today that hasn't been studied *yet* doesn't break a streak that ran
  // through yesterday, so start the walk from yesterday in that case.
  let streak = 0;
  const cursor = new Date();
  if (!(days[dayKey(cursor)] > 0)) cursor.setDate(cursor.getDate() - 1);
  while (days[dayKey(cursor)] > 0) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }

  // This week (Sunday-start, matching the heatmap columns): active days so far.
  const weekStart = new Date();
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  let thisWeek = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    if (days[dayKey(d)] > 0) thisWeek += 1;
  }

  return { days, total, streak, thisWeek };
}

// --- Vocabulary (단어장) ----------------------------------------------------
// The learner's saved words, the data behind the 단어장 tab (list / flashcard
// review / quiz). Stored in localStorage (per device — no backend), shaped like
// the bookmarks/activity records so a future server migration stays trivial.
// Each word keeps a snapshot of its gloss (term/ko/type + the optional rich
// fields) plus its source (video/seg) and quiz tallies, so it stays
// self-describing even if a transcript/glossary rebuild shifts indices.
const VOCAB_KEY = "shadowloop:v1:vocab";

function loadVocab() {
  try {
    const raw = JSON.parse(localStorage.getItem(VOCAB_KEY));
    return raw && Array.isArray(raw.words) ? raw : { words: [] };
  } catch {
    return { words: [] };
  }
}

function saveVocab(vocab) {
  try {
    localStorage.setItem(VOCAB_KEY, JSON.stringify(vocab));
  } catch {
    // localStorage unavailable (e.g. private mode) — saves just won't persist.
  }
}

// Stable identity for a saved word: its source video + segment + term. Used for
// dedupe, the save/unsave toggle, and recording quiz results.
function vocabId(videoId, seg, term) {
  return `${videoId}:${seg}:${term}`;
}

function isInVocab(id) {
  return loadVocab().words.some((w) => w.id === id);
}

// Toggle a word's saved state. Returns true if it is now saved, false if removed.
function toggleVocab(record) {
  if (!record || !record.id) return false;
  const vocab = loadVocab();
  const at = vocab.words.findIndex((w) => w.id === record.id);
  let saved;
  if (at >= 0) {
    vocab.words.splice(at, 1);
    saved = false;
  } else {
    vocab.words.push({ ...record, addedAt: Date.now(), correct: 0, wrong: 0 });
    saved = true;
  }
  saveVocab(vocab);
  return saved;
}

function removeVocab(id) {
  const vocab = loadVocab();
  vocab.words = vocab.words.filter((w) => w.id !== id);
  saveVocab(vocab);
}

// Record one quiz answer against a saved word (drives the "자주 틀림" view).
function recordQuizResult(id, correct) {
  const vocab = loadVocab();
  const word = vocab.words.find((w) => w.id === id);
  if (!word) return;
  if (correct) word.correct = (word.correct || 0) + 1;
  else word.wrong = (word.wrong || 0) + 1;
  saveVocab(vocab);
}

// HOME — a browse grid of thumbnail cards, grouped into labelled sections by
// `category` (강연 vs 예능 등). Groups appear in first-seen order; videos keep
// their order within a group. Each card carries its index into `videos`.
//
// Home stays discovery-focused: a sticky category filter-chip row narrows the
// grid to one category, and a thin horizontal "이어보기" strip at the top brings
// the learner straight back to whatever they were drilling (the app's core
// return trigger). The personal collection — saved expressions plus the full
// in-progress list — lives in the separate 보관함 (library) tab, so the home
// doesn't get crowded out as that grows. Finished videos (pct 100) get a check
// badge wherever they appear.
const HOME_ALL = "전체";
let homeFilter = HOME_ALL;

// In-progress videos (0 < pct < 100), most-recently-watched first. Shared by the
// home "이어보기" strip and the library's full "이어보기" grid.
function resumeList(progressMap) {
  return videos
    .map((video, index) => ({
      video,
      index,
      pct: videoPercent(progressMap, video.id),
      at: progressMap[video.id]?.at || 0,
    }))
    .filter((x) => x.pct > 0 && x.pct < 100)
    .sort((a, b) => b.at - a.at);
}

// Every saved segment across all videos, most-recently-saved first. Drives the
// library's "저장한 표현" list.
function savedExpressions() {
  const bm = loadBookmarks();
  const saved = [];
  videos.forEach((video, index) => {
    (bm[video.id] || []).forEach((b) => saved.push({ video, index, b }));
  });
  return saved.sort((a, b) => (b.b.at || 0) - (a.b.at || 0));
}

// One compact saved-expression row (no thumbnail); taps deep-link to the segment.
function noteRowHtml({ video, index, b }) {
  return `
    <button type="button" class="note-row" data-video="${index}" data-seg="${b.seg}">
      <span class="note-row-text">${escapeHtml(b.text)}</span>
      <span class="note-row-meta">${escapeHtml(video.tag || video.title || "")} · ${formatTime(b.start)}</span>
    </button>`;
}

// Per-video progress as a 0–100 percentage of segments reached (0 when unseen).
function videoPercent(progressMap, videoId) {
  const p = progressMap[videoId];
  return p && p.total
    ? Math.min(100, Math.round(((p.seg + 1) / p.total) * 100))
    : 0;
}

// One thumbnail card. `index` is the position into `videos` (used by the click
// handler); `cat` is the fallback meta label.
function cardHtml(video, index, cat, pct) {
  const title = video.title || video.tag || "제목 없음";
  const segCount = (video.segments || []).length;
  const done = pct >= 100;
  return `
    <button type="button" class="card" data-video="${index}">
      <span class="card-thumb">
        <img src="${thumbnailUrl(video.id)}" alt="" loading="lazy" />
        <span class="card-badge">${segCount}구간</span>
        ${done ? `<span class="card-done" aria-label="완료">✓</span>` : ""}
        ${pct > 0 ? `<span class="card-progress"><span style="width:${pct}%"></span></span>` : ""}
      </span>
      <span class="card-body">
        <span class="card-title">${escapeHtml(title)}</span>
        <span class="card-meta">${escapeHtml(video.tag || cat)}</span>
      </span>
    </button>`;
}

function renderHome() {
  els.homeCount.textContent = videos.length ? `${videos.length}개 영상` : "";

  if (!videos.length) {
    els.homeFilters.innerHTML = "";
    els.homeFeed.innerHTML = `<p class="home-empty">영상이 없습니다</p>`;
    return;
  }

  const progressMap = loadProgress(); // read the stored positions once for all cards
  const order = [];
  const byCat = new Map();
  videos.forEach((video, index) => {
    const cat = video.category || "기타";
    if (!byCat.has(cat)) { byCat.set(cat, []); order.push(cat); }
    byCat.get(cat).push({ video, index });
  });

  // A filter that no longer matches any category (e.g. its videos were removed)
  // falls back to "전체" so the feed never renders empty.
  if (homeFilter !== HOME_ALL && !byCat.has(homeFilter)) homeFilter = HOME_ALL;

  // Filter chips: "전체" + one per category, each with its video count.
  els.homeFilters.innerHTML = [[HOME_ALL, videos.length], ...order.map((c) => [c, byCat.get(c).length])]
    .map(([cat, n]) => `
      <button type="button" class="chip${cat === homeFilter ? " is-active" : ""}" data-cat="${escapeHtml(cat)}">
        ${escapeHtml(cat)}<span class="chip-count">${n}</span>
      </button>`)
    .join("");

  const sections = [];

  // 이어보기 — a thin horizontal strip of in-progress videos (most-recent-first)
  // so reopening the app lands the learner back on what they were drilling. Only
  // in the unfiltered view; selecting a category narrows to that grid alone. The
  // full list (and saved expressions) live in the 보관함 tab.
  if (homeFilter === HOME_ALL) {
    const resume = resumeList(progressMap);
    if (resume.length) {
      const cards = resume.map((x) => cardHtml(x.video, x.index, x.video.category || "기타", x.pct)).join("");
      sections.push(`
        <section class="feed-group">
          <h2 class="feed-group-title">이어보기</h2>
          <div class="resume-strip">${cards}</div>
        </section>`);
    }
  }

  // Category sections (all, or just the selected one).
  order
    .filter((cat) => homeFilter === HOME_ALL || cat === homeFilter)
    .forEach((cat) => {
      const cards = byCat.get(cat)
        .map(({ video, index }) => cardHtml(video, index, cat, videoPercent(progressMap, video.id)))
        .join("");
      sections.push(`
        <section class="feed-group">
          <h2 class="feed-group-title">${escapeHtml(cat)}</h2>
          <div class="card-grid">${cards}</div>
        </section>`);
    });

  els.homeFeed.innerHTML = sections.join("");
}

// The three headline metrics (연속 / 총 / 이번 주) shown above the heatmap.
function statsHtml(stats) {
  return `
    <div class="study-stats">
      <div class="stat">
        <span class="stat-num">🔥 ${stats.streak}</span>
        <span class="stat-label">연속 학습일</span>
      </div>
      <div class="stat">
        <span class="stat-num">${stats.total}</span>
        <span class="stat-label">총 학습일</span>
      </div>
      <div class="stat">
        <span class="stat-num">${stats.thisWeek}<span class="stat-sub">/7</span></span>
        <span class="stat-label">이번 주</span>
      </div>
    </div>`;
}

// A GitHub-style contribution grid trimmed to the last 12 weeks so it fits a
// phone screen without horizontal scrolling. Built column-by-column (one column
// per week, 7 day-rows Sun→Sat); the CSS lays it out in column-major order. Days
// after today render as empty "future" cells to keep the current week's shape.
function heatmapHtml(days) {
  const WEEKS = 12;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // Sunday of 11 weeks ago → the grid spans 12 weeks ending with this week.
  const start = new Date(today);
  start.setDate(today.getDate() - today.getDay() - (WEEKS - 1) * 7);

  const cells = [];
  for (let w = 0; w < WEEKS; w++) {
    for (let d = 0; d < 7; d++) {
      const date = new Date(start);
      date.setDate(start.getDate() + w * 7 + d);
      if (date > today) {
        cells.push(`<span class="hm-cell" data-lvl="f"></span>`);
        continue;
      }
      const key = dayKey(date);
      const count = days[key] || 0;
      const label = `${key} · ${count}구간 완료`;
      cells.push(
        `<span class="hm-cell" data-lvl="${activityLevel(count)}" title="${label}" aria-label="${label}"></span>`
      );
    }
  }
  return `<div class="heatmap" role="img" aria-label="최근 12주 학습 기록">${cells.join("")}</div>`;
}

// LIBRARY (보관함) — the learner's personal collection, kept off the home so the
// home stays discovery-focused. Sections, top to bottom: the study-activity
// heatmap (학습 기록), saved expressions (저장한 표현), and the full in-progress
// list (이어보기). The expression/resume blocks reuse the home's row/card markup
// and click handling.
function renderLibrary() {
  const sections = [];

  // Study heatmap — always first, even with no data: it doubles as the library's
  // empty-state hero and the app's main day-to-day return motivator.
  const stats = activityStats();
  sections.push(`
    <section class="feed-group study-group">
      <h2 class="feed-group-title">학습 기록</h2>
      ${statsHtml(stats)}
      ${heatmapHtml(stats.days)}
      ${stats.total === 0
        ? `<p class="study-hint">아직 학습 기록이 없어요. 오늘 첫 구간을 완료해 잔디를 심어보세요 🌱</p>`
        : ""}
    </section>`);

  const saved = savedExpressions();
  if (saved.length) {
    sections.push(`
      <section class="feed-group">
        <h2 class="feed-group-title">저장한 표현</h2>
        <div class="note-rows">${saved.map(noteRowHtml).join("")}</div>
      </section>`);
  }

  const resume = resumeList(loadProgress());
  if (resume.length) {
    const cards = resume.map((x) => cardHtml(x.video, x.index, x.video.category || "기타", x.pct)).join("");
    sections.push(`
      <section class="feed-group">
        <h2 class="feed-group-title">이어보기</h2>
        <div class="card-grid">${cards}</div>
      </section>`);
  }

  // The study section is always present, so the feed never renders empty; its
  // own 학습 기록 hint covers the brand-new-user case.
  els.libraryFeed.innerHTML = sections.join("");
}

// WORDS (단어장) — the saved-vocabulary tab. Three modes share one view via a
// segmented control: 목록 (list, with a 난이도=type filter + "자주 틀림" sort),
// 복습 (flashcards: tap to flip), and 퀴즈 (4-choice meaning quiz that tallies
// correct/wrong onto each word). Each mode renders the whole #wordsBody; clicks
// are handled by one delegated listener (see wiring below). Mobile single-focus
// is preserved: one mode on screen at a time, no nested scroll panes.
const WORDS_FILTERS = [
  ["all", "전체"],
  ["word", "단어"],
  ["phrase", "구"],
  ["idiom", "관용구"],
  ["wrong", "자주 틀림"],
];

// Fisher–Yates shuffle (in place); used by the flashcard deck and the quiz.
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Apply the current 난이도/type filter to a word list. "wrong" keeps only words
// missed at least once, ordered most-missed first; the type filters keep that
// `type`; "all" passes everything through.
function filterWords(words) {
  if (state.wordsFilter === "wrong") {
    return words.filter((w) => (w.wrong || 0) > 0).sort((a, b) => (b.wrong || 0) - (a.wrong || 0));
  }
  if (state.wordsFilter === "all") return words;
  return words.filter((w) => (w.type || "word") === state.wordsFilter);
}

// The shared 난이도 filter chip row (목록 + 복습 use it).
function wordsFilterChips() {
  return `
    <div class="words-filters" id="wordsFilters">
      ${WORDS_FILTERS.map(([val, label]) =>
        `<button type="button" class="chip${val === state.wordsFilter ? " is-active" : ""}" data-wfilter="${val}">${label}</button>`
      ).join("")}
    </div>`;
}

function renderWords() {
  const words = loadVocab().words;
  els.wordsCount.textContent = words.length ? `${words.length}개` : "";
  els.wordsModes.querySelectorAll(".wmode").forEach((b) =>
    b.classList.toggle("is-active", b.dataset.mode === state.wordsMode));

  if (!words.length) {
    els.wordsBody.innerHTML = `
      <div class="words-empty">
        <p class="words-empty-title">아직 저장한 단어가 없어요</p>
        <p class="words-empty-sub">영상을 보다가 자막 아래 단어 칩을 눌러 ‘단어장에 저장’을 눌러 보세요.</p>
      </div>`;
    return;
  }

  if (state.wordsMode === "review") renderReview(words);
  else if (state.wordsMode === "quiz") renderQuiz(words);
  else renderWordsList(words);
}

// 목록 — filtered word rows (recent-first, or most-missed-first for 자주 틀림).
// Tapping a row opens its detail sheet; × removes it from the 단어장.
function renderWordsList(words) {
  const list = state.wordsFilter === "wrong"
    ? filterWords(words)
    : filterWords(words).slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

  const rows = list.length
    ? list.map((w) => {
        const stats = [];
        if (w.correct) stats.push(`✓${w.correct}`);
        if (w.wrong) stats.push(`✗${w.wrong}`);
        const meta = [w.videoTitle, stats.join(" ")].filter(Boolean).join(" · ");
        return `
          <div class="word-row" data-id="${escapeHtml(w.id)}">
            <button type="button" class="word-row-main">
              <span class="word-row-top">
                <span class="word-row-term">${escapeHtml(w.term)}</span>
                <span class="word-row-type">${TYPE_LABEL[w.type] || "단어"}</span>
              </span>
              <span class="word-row-ko">${escapeHtml(w.ko || "")}</span>
              ${meta ? `<span class="word-row-meta">${escapeHtml(meta)}</span>` : ""}
            </button>
            <button type="button" class="word-del" data-del="${escapeHtml(w.id)}" aria-label="단어장에서 삭제">×</button>
          </div>`;
      }).join("")
    : `<p class="words-empty-sub">이 조건에 해당하는 단어가 없어요.</p>`;

  els.wordsBody.innerHTML = `
    ${wordsFilterChips()}
    <div class="word-rows">${rows}</div>`;
}

// Rebuild the flashcard deck when the filter, vocab size, or shuffle token
// changes (signature compare), so flipping/advancing doesn't reshuffle.
function ensureDeck(words) {
  const filtered = filterWords(words);
  const sig = `${state.wordsFilter}:${filtered.length}:${state.reviewToken}`;
  if (state.review.sig === sig && state.review.deck.length) return;
  state.review = { sig, deck: shuffle(filtered.slice()), pos: 0, flipped: false };
}

// 복습 — one flashcard at a time. Front: the word; tap to flip to the back
// (easy meaning + example). Prev/next walk the shuffled deck; 섞기 reshuffles.
function renderReview(words) {
  ensureDeck(words);
  const deck = state.review.deck;

  if (!deck.length) {
    els.wordsBody.innerHTML = `
      ${wordsFilterChips()}
      <p class="words-empty-sub">이 조건에 해당하는 단어가 없어요.</p>`;
    return;
  }

  const pos = Math.min(state.review.pos, deck.length - 1);
  state.review.pos = pos;
  const w = deck[pos];
  const flipped = state.review.flipped;

  const back = [
    w.easy && `<p class="fc-easy">${escapeHtml(w.easy)}</p>`,
    w.ko && `<p class="fc-ko">${escapeHtml(w.ko)}</p>`,
    w.ex && `<p class="fc-ex">${escapeHtml(w.ex)}</p>`,
    w.exKo && `<p class="fc-exko">${escapeHtml(w.exKo)}</p>`,
  ].filter(Boolean).join("");

  els.wordsBody.innerHTML = `
    ${wordsFilterChips()}
    <button type="button" class="flashcard ${flipped ? "is-flipped" : ""}" data-flip>
      ${flipped
        ? `<span class="fc-side fc-back">${back || `<p class="fc-ko">${escapeHtml(w.ko || "")}</p>`}</span>`
        : `<span class="fc-side fc-front"><span class="fc-type">${TYPE_LABEL[w.type] || "단어"}</span><span class="fc-term">${escapeHtml(w.term)}</span><span class="fc-hint">탭하면 뜻 보기</span></span>`}
    </button>
    <div class="fc-nav">
      <button type="button" class="fc-btn" data-review-nav="prev" ${pos === 0 ? "disabled" : ""}>이전</button>
      <span class="fc-progress">${pos + 1} / ${deck.length}</span>
      <button type="button" class="fc-btn" data-review-nav="next" ${pos === deck.length - 1 ? "disabled" : ""}>다음</button>
    </div>
    <button type="button" class="fc-shuffle" data-review-shuffle>🔀 다시 섞기</button>`;
}

// Build a fresh quiz: up to 10 words, each asked "이 단어의 뜻은?" with the
// correct 뜻 plus 3 distractor 뜻 (from other saved words), all shuffled.
function buildQuiz(words) {
  const pool = shuffle(words.slice()).slice(0, 10);
  const questions = pool.map((w) => {
    const distractors = shuffle(words.filter((x) => x.id !== w.id && x.ko && x.ko !== w.ko))
      .slice(0, 3)
      .map((d) => ({ ko: d.ko, correct: false }));
    const options = shuffle([{ ko: w.ko, correct: true }, ...distractors]);
    return { id: w.id, term: w.term, type: w.type, options };
  });
  state.quiz = { questions, index: 0, score: 0, picked: null, done: false };
}

// 퀴즈 — needs ≥4 words (for 4 distinct options). Renders a start screen, the
// active question (with answer feedback), or the results screen.
function renderQuiz(words) {
  if (words.length < 4) {
    els.wordsBody.innerHTML = `
      <div class="words-empty">
        <p class="words-empty-title">퀴즈는 단어 4개부터</p>
        <p class="words-empty-sub">단어를 ${4 - words.length}개 더 저장하면 퀴즈를 풀 수 있어요.</p>
      </div>`;
    return;
  }

  const q = state.quiz;
  if (!q) {
    els.wordsBody.innerHTML = `
      <div class="quiz-start">
        <p class="quiz-start-title">뜻 맞히기 퀴즈</p>
        <p class="quiz-start-sub">저장한 단어 중 최대 10개가 출제돼요. 결과는 단어별 정답·오답에 기록됩니다.</p>
        <button type="button" class="quiz-go" data-quiz-start>퀴즈 시작</button>
      </div>`;
    return;
  }

  if (q.done) {
    const total = q.questions.length;
    els.wordsBody.innerHTML = `
      <div class="quiz-result">
        <p class="quiz-result-score">${q.score} / ${total}</p>
        <p class="quiz-result-sub">${q.score === total ? "완벽해요! 🎉" : "틀린 단어는 ‘자주 틀림’에서 다시 복습해요."}</p>
        <button type="button" class="quiz-go" data-quiz-start>다시 풀기</button>
        <button type="button" class="quiz-go ghost" data-wfilter="wrong" data-quiz-wrong>자주 틀린 단어 보기</button>
      </div>`;
    return;
  }

  const cur = q.questions[q.index];
  const picked = q.picked;
  const options = cur.options.map((o, i) => {
    let cls = "quiz-opt";
    if (picked !== null) {
      if (o.correct) cls += " is-correct";
      else if (i === picked) cls += " is-wrong";
    }
    return `<button type="button" class="${cls}" data-opt="${i}" ${picked !== null ? "disabled" : ""}>${escapeHtml(o.ko)}</button>`;
  }).join("");

  els.wordsBody.innerHTML = `
    <div class="quiz">
      <div class="quiz-progress">
        <span>${q.index + 1} / ${q.questions.length}</span>
        <span class="quiz-score">${q.score}점</span>
      </div>
      <p class="quiz-q">이 단어의 뜻은?</p>
      <p class="quiz-term">${escapeHtml(cur.term)}</p>
      <div class="quiz-opts">${options}</div>
      ${picked !== null
        ? `<button type="button" class="quiz-go" data-quiz-next>${q.index === q.questions.length - 1 ? "결과 보기" : "다음 문제"}</button>`
        : ""}
    </div>`;
}

// --- Routing ---------------------------------------------------------------
// #/            → home
// #/library     → 보관함 (saved expressions + in-progress)
// #/words       → 단어장 (saved vocab: list / review / quiz)
// #/v/<videoId> → that video's detail page
function route() {
  const hash = location.hash || "#/";
  const match = hash.match(/^#\/v\/(.+)$/);
  if (match) {
    const video = videos.find((v) => v.id === decodeURIComponent(match[1]));
    if (video) { showDetail(video); return; }
  }
  if (hash === "#/library") { showLibrary(); return; }
  if (hash === "#/words") { showWords(); return; }
  showHome();
}

function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash; // triggers hashchange → route()
}

function openVideo(video) {
  navigate(`#/v/${encodeURIComponent(video.id)}`);
}

function goHome() {
  navigate("#/");
}

// Reflect the active top-level view in the bottom tab bar (detail hides it).
function setActiveTab(which) {
  [["home", els.tabHome], ["library", els.tabLibrary], ["words", els.tabWords]].forEach(([name, el]) => {
    const on = name === which;
    el.classList.toggle("is-active", on);
    if (on) el.setAttribute("aria-current", "page");
    else el.removeAttribute("aria-current");
  });
}

function showHome() {
  state.view = "home";
  closeSheet();
  if (playerReady && player && typeof player.pauseVideo === "function") player.pauseVideo();
  renderHome(); // refresh thumbnail progress bars with the latest watched position
  els.homeView.hidden = false;
  els.libraryView.hidden = true;
  els.wordsView.hidden = true;
  els.detailView.hidden = true;
  document.body.classList.remove("is-detail");
  setActiveTab("home");
  window.scrollTo(0, 0);
}

function showLibrary() {
  state.view = "library";
  closeSheet();
  if (playerReady && player && typeof player.pauseVideo === "function") player.pauseVideo();
  renderLibrary(); // refresh saved/in-progress with the latest state
  els.homeView.hidden = true;
  els.libraryView.hidden = false;
  els.wordsView.hidden = true;
  els.detailView.hidden = true;
  document.body.classList.remove("is-detail");
  setActiveTab("library");
  window.scrollTo(0, 0);
}

function showWords() {
  state.view = "words";
  closeSheet();
  if (playerReady && player && typeof player.pauseVideo === "function") player.pauseVideo();
  renderWords(); // rebuild list/review/quiz from the latest saved vocab
  els.homeView.hidden = true;
  els.libraryView.hidden = true;
  els.wordsView.hidden = false;
  els.detailView.hidden = true;
  document.body.classList.remove("is-detail");
  setActiveTab("words");
  window.scrollTo(0, 0);
}

function showDetail(video) {
  state.view = "detail";
  els.homeView.hidden = true;
  els.libraryView.hidden = true;
  els.wordsView.hidden = true;
  els.detailView.hidden = false;
  document.body.classList.add("is-detail");
  window.scrollTo(0, 0);
  if (state.videoId !== video.id) {
    loadVideo(video);
  } else if (pendingSegment != null) {
    // Same video already loaded — jump straight to the requested segment.
    const seg = pendingSegment;
    pendingSegment = null;
    selectSegment(seg, true);
  }
}

function loadVideo(video) {
  state.videoId = video.id;
  state.title = video.title || video.tag || "";
  state.segments = video.segments || [];
  // Resume at the furthest segment reached, unless the video was finished
  // (reached the last segment) — then start over from the top, like YouTube.
  const saved = getVideoProgress(video.id);
  state.current = saved && saved.seg < state.segments.length - 1 ? saved.seg : 0;
  // A deep link / saved-segment tap overrides the resume position.
  if (pendingSegment != null) {
    state.current = Math.max(0, Math.min(pendingSegment, state.segments.length - 1));
    pendingSegment = null;
  }
  state.bookmarks = new Set(getVideoBookmarks(video.id).map((b) => b.seg));
  state.line = -1;
  state.loops = 0;
  state.peek = false;
  els.peekBtn.classList.remove("is-on");
  els.emptyPlayer.classList.add("is-hidden");

  els.topbarTitle.textContent = video.tag || video.title || "영상";
  els.videoTitle.textContent = video.title || video.tag || "";
  const subParts = [video.category, video.tag, `${state.segments.length}구간`].filter(Boolean);
  els.videoSub.textContent = subParts.join(" · ");

  _prevTime = null;

  if (playerReady && player) {
    player.loadVideoById({ videoId: video.id, startSeconds: state.segments[state.current]?.start || 0 });
    player.setPlaybackRate(state.speed);
  }

  render();
}

function handlePlayerState(event) {
  if (event.data === YT.PlayerState.PLAYING) {
    els.playPause.classList.add("is-playing");
    els.playPause.setAttribute("aria-label", "일시정지");
  }

  if (event.data === YT.PlayerState.PAUSED || event.data === YT.PlayerState.ENDED) {
    els.playPause.classList.remove("is-playing");
    els.playPause.setAttribute("aria-label", "재생");
  }
}

// Returns the index of the segment that contains `time`, or the nearest one.
function findSegmentAt(time) {
  const segs = state.segments;
  for (let i = 0; i < segs.length; i++) {
    if (time >= segs[i].start && time < segs[i].end) return i;
  }
  let best = 0, bestDist = Infinity;
  for (let i = 0; i < segs.length; i++) {
    const dist = Math.min(Math.abs(time - segs[i].start), Math.abs(time - segs[i].end));
    if (dist < bestDist) { bestDist = dist; best = i; }
  }
  return best;
}

function playCurrentSegment() {
  const segment = state.segments[state.current];
  if (!playerReady || !segment) return;
  _seekCooldown = performance.now() + 600;
  player.seekTo(segment.start, true);
  player.playVideo();
  player.setPlaybackRate(state.speed);
}

function selectSegment(index, autoplay = true) {
  if (!state.segments.length) return;
  state.current = Math.max(0, Math.min(index, state.segments.length - 1));
  state.line = -1;
  state.loops = 0;
  state.peek = false;
  els.peekBtn.classList.remove("is-on");
  recordProgress(state.videoId, state.current, state.segments.length);
  render();
  if (autoplay) playCurrentSegment();
}

// Save / unsave the current segment to the personal notes (one tap, no typing).
function toggleSaveCurrent() {
  const segment = state.segments[state.current];
  if (!state.videoId || !segment) return;
  const saved = toggleBookmark(state.videoId, state.current, segment);
  if (saved) state.bookmarks.add(state.current);
  else state.bookmarks.delete(state.current);
  render();
  if (state.sheet === "notes") renderNotes();
  showToast(saved ? "메모에 저장했어요" : "메모에서 뺐어요");
}

// Seek straight to a caption sentence within the current segment.
function seekToLine(lineIndex) {
  const line = state.segments[state.current]?.lines[lineIndex];
  if (!playerReady || !line) return;
  player.seekTo(line.start, true);
  player.playVideo();
  player.setPlaybackRate(state.speed);
}

// Repeats needed before a segment is fully revealed, scaled by caption length
// within the current pace's range: a short line reveals fast, a long one slow.
function segmentTarget(segment) {
  const chars = segment.lines.map((l) => l.text).join(" ").length;
  const { min, max, base, slope } = PACE[state.pace];
  return Math.max(min, Math.min(max, Math.round(base + (chars - 20) * slope)));
}

// Recompute the reveal length for the current segment (e.g. after a pace change)
// and refresh the dots + reveal without disturbing playback.
function recomputeTarget() {
  const segment = state.segments[state.current];
  if (!segment) return;
  state.target = segmentTarget(segment);
  renderLoopDots();
  applyReveal();
}

function render() {
  const segment = state.segments[state.current];
  els.segmentCount.textContent = `${state.segments.length}개 구간`;
  els.segPos.textContent = state.segments.length ? `${state.current + 1} / ${state.segments.length}` : "0 / 0";
  els.timeRange.textContent = segment
    ? `${formatTime(segment.start)} / ${formatTime(segment.end)}`
    : "--:-- / --:--";

  els.speedButtons.forEach((button) => {
    button.classList.toggle("is-active", Number(button.dataset.speed) === state.speed);
  });
  els.paceButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.pace === state.pace);
  });

  if (els.saveSegBtn) els.saveSegBtn.classList.toggle("is-saved", state.bookmarks.has(state.current));

  renderCaption(segment);
  renderLoopDots();

  els.segmentList.innerHTML = state.segments
    .map((item, index) => `
        <button type="button" class="segment-item ${index === state.current ? "is-active" : ""} ${state.bookmarks.has(index) ? "is-saved" : ""}" data-index="${index}">
          <span class="segment-index">${String(index + 1).padStart(2, "0")}</span>
          <span class="segment-text">${escapeHtml(item.lines.map((l) => l.text).join(" "))}</span>
          ${state.bookmarks.has(index) ? '<span class="segment-mark" aria-label="저장됨">★</span>' : ""}
          <span class="segment-dur">${Math.round(item.end - item.start)}초</span>
        </button>
      `)
    .join("");

  updateRing(0);
}

function renderCaption(segment) {
  if (!segment) {
    els.caption.innerHTML = `<p class="caption-empty">자막을 불러오는 중…</p>`;
    lineEls = [];
    wordEls = [];
    state.cloze = [];
    state.target = PACE[state.pace].min;
    renderGlossary(null);
    return;
  }

  state.target = segmentTarget(segment);

  let wordIndex = 0;
  const maskable = [];
  const html = segment.lines
    .map((line, lineIndex) => {
      const words = line.text.split(/\s+/).map((word) => {
        const idx = wordIndex++;
        // Longer, lexical words are the ones that get blanked out.
        if (word.replace(/[^A-Za-z]/g, "").length >= 3) maskable.push(idx);
        return `<span class="cap-word" data-w="${idx}">${escapeHtml(word)}</span>`;
      });
      return `<button type="button" class="cap-line" data-line="${lineIndex}">${words.join(" ")}</button>`;
    })
    .join("");

  els.caption.innerHTML = html;
  lineEls = [...els.caption.querySelectorAll(".cap-line")];
  wordEls = [...els.caption.querySelectorAll(".cap-word")];

  state.cloze = maskable; // already in reading order
  state.line = -1;
  renderGlossary(segment);
  applyReveal();
}

// Build the strip of Korean hints for a segment's hard words/idioms. When a
// segment has none, the strip leaves the layout entirely. When it has some, it
// stays in the flow (reserving space) but is faded out until applyReveal() shows
// it on the later loops.
function renderGlossary(segment) {
  const items = (segment && segment.glossary) || [];
  if (!items.length) {
    els.glossary.hidden = true;
    els.glossList.innerHTML = "";
    els.glossary.classList.remove("is-shown");
    return;
  }
  // Each chip stays compact (term + easy 뜻) but is now tappable: a tap opens
  // the #wordSheet with whatever rich fields the gloss carries (all optional),
  // plus a "단어장에 저장" action. The data-gi index maps back to the live
  // segment glossary so the handler reads the full object on demand.
  els.glossList.innerHTML = items
    .map((g, i) => `
        <button type="button" class="gloss-item${glossHasDetail(g) ? " has-detail" : ""}" data-gi="${i}">
          <span class="gloss-term">${escapeHtml(g.term)}</span>
          <span class="gloss-ko">${escapeHtml(g.ko)}</span>
          <span class="gloss-more" aria-hidden="true">›</span>
        </button>`)
    .join("");
  els.glossary.hidden = false;
}

// Does a gloss carry any of the optional rich fields (beyond term/ko/type)?
const RICH_FIELDS = ["easy", "nuance", "when", "ex", "exKo", "vs", "tip"];
function glossHasDetail(g) {
  return RICH_FIELDS.some((f) => g && g[f]);
}

// --- Word detail sheet (#wordSheet) ----------------------------------------
// Build a vocab-shaped record from a gloss + its source context, then open the
// detail sheet. Used when tapping a chip in the player's glossary strip.
function openGlossDetail(g) {
  const video = videos.find((v) => v.id === state.videoId);
  showWordDetail({
    id: vocabId(state.videoId, state.current, g.term),
    term: g.term,
    ko: g.ko,
    type: g.type || "word",
    easy: g.easy,
    nuance: g.nuance,
    when: g.when,
    ex: g.ex,
    exKo: g.exKo,
    vs: g.vs,
    tip: g.tip,
    video: state.videoId,
    videoTitle: video ? video.title || video.tag || "" : "",
    seg: state.current,
  });
}

// Render `record` into the word sheet and open it. `record` is vocab-shaped
// (from a gloss chip or a saved word); the save button reflects/toggles whether
// it's already in the 단어장.
function showWordDetail(record) {
  state.wordRecord = record;
  renderWordSheet();
  openSheet("word");
}

// One labelled field row; returns "" when the field is empty (all optional).
function wordFieldRow(label, value, cls = "") {
  if (!value) return "";
  return `
    <div class="wfield">
      <span class="wf-label">${label}</span>
      <span class="wf-val ${cls}">${escapeHtml(value)}</span>
    </div>`;
}

function renderWordSheet() {
  const r = state.wordRecord;
  if (!r) return;
  els.wordTerm.textContent = r.term;
  els.wordKo.textContent = r.ko || "";
  els.wordType.textContent = TYPE_LABEL[r.type] || "단어";

  const example = r.ex
    ? `
      <div class="wfield">
        <span class="wf-label">예문</span>
        <span class="wf-val wf-en">${escapeHtml(r.ex)}</span>
        ${r.exKo ? `<span class="wf-val wf-ko">${escapeHtml(r.exKo)}</span>` : ""}
      </div>`
    : "";

  const rows = [
    wordFieldRow("쉬운 뜻", r.easy),
    wordFieldRow("뉘앙스", r.nuance),
    wordFieldRow("상황", r.when),
    example,
    wordFieldRow("유사어", r.vs),
    wordFieldRow("포인트", r.tip),
  ].join("");

  els.wordBody.innerHTML = rows
    ? rows
    : `<p class="word-noinfo">아직 자세한 해설이 없어요. 단어장에 저장해 두면 복습·퀴즈로 익힐 수 있어요.</p>`;

  const src = [r.videoTitle, typeof r.seg === "number" ? `구간 ${r.seg + 1}` : ""].filter(Boolean).join(" · ");
  els.wordBody.innerHTML += src ? `<p class="word-src">${escapeHtml(src)}</p>` : "";

  const saved = isInVocab(r.id);
  els.wordSaveBtn.classList.toggle("is-saved", saved);
  els.wordSaveBtn.textContent = saved ? "단어장에서 빼기" : "단어장에 저장";
}

// Push the current reveal progress into the DOM. The whole caption fades in as
// the segment repeats, while blanked words uncover left-to-right. Called when
// the segment or the loop count changes — never per frame.
function applyReveal() {
  // Peek (holding the eye button) shows the whole caption regardless of progress.
  if (state.peek) {
    els.caption.style.setProperty("--reveal", "1");
    wordEls.forEach((node) => node.classList.remove("is-hidden"));
    els.glossary.classList.add("is-shown");
    return;
  }

  const t = state.target;
  const p = t > 1 ? Math.max(0, Math.min(1, state.loops / (t - 1))) : 1;
  els.caption.style.setProperty("--reveal", String(p));

  const revealed = Math.round(state.cloze.length * p);
  const stillHidden = new Set(state.cloze.slice(revealed));
  wordEls.forEach((node, idx) => node.classList.toggle("is-hidden", stillHidden.has(idx)));

  // Hard-word hints arrive once the segment is partway revealed — not on the
  // first blind listens — so they scaffold rather than spoil.
  els.glossary.classList.toggle("is-shown", p >= 0.45);
}

function setPeek(on) {
  state.peek = on;
  els.peekBtn.classList.toggle("is-on", on);
  applyReveal();
}

function renderLoopDots() {
  const t = state.target;
  const filled = Math.min(state.loops + 1, t); // current repeat number, 1-based
  els.loopDots.innerHTML = Array.from({ length: t }, (_, i) =>
    `<span class="dot ${i < filled ? "is-on" : ""}"></span>`).join("");
}

// Highlight the sentence being spoken; only touches the DOM when it changes.
function setCurrentLine(index) {
  if (index === state.line) return;
  lineEls[state.line]?.classList.remove("is-current");
  state.line = index;
  lineEls[index]?.classList.add("is-current");
}

function currentLineIndex(segment, now) {
  let found = -1;
  for (let i = 0; i < segment.lines.length; i += 1) {
    if (now >= segment.lines[i].start - 0.05) found = i;
    else break;
  }
  return found;
}

function updateRing(fraction) {
  if (!els.ringProgress) return;
  const clamped = Math.max(0, Math.min(1, fraction));
  els.ringProgress.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - clamped));
}

function tick() {
  if (state.view === "detail" && playerReady && state.segments.length && typeof player.getCurrentTime === "function") {
    const segment = state.segments[state.current];
    const now = player.getCurrentTime();
    const status = player.getPlayerState?.();

    // Detect user seeks: a large time jump that lands outside the current segment
    // while no app-initiated seek is in progress (cooldown).
    if (_prevTime !== null && performance.now() > _seekCooldown) {
      const outsideCurrent = now < segment.start || now >= segment.end;
      if (outsideCurrent && Math.abs(now - _prevTime) > 1.0) {
        const idx = findSegmentAt(now);
        _prevTime = now;
        selectSegment(idx, true);
        requestAnimationFrame(tick);
        return;
      }
    }
    _prevTime = now;

    const span = segment.end - segment.start;
    if (span > 0) updateRing((now - segment.start) / span);

    if (now >= segment.start - 0.2 && now < segment.end) {
      setCurrentLine(currentLineIndex(segment, now));
    }

    if (status === YT.PlayerState.PLAYING && now >= segment.end - 0.15) {
      if (state.loops + 1 >= state.target) {
        // Fully revealed — one segment finished. Count it toward today's study
        // record (the PLAYING guard + loops reset on advance keep it to once per
        // completion), then move on (or stop at the last segment).
        recordStudy();
        if (state.current === state.segments.length - 1) player.pauseVideo();
        else selectSegment(state.current + 1, true);
      } else {
        state.loops += 1;
        _seekCooldown = performance.now() + 600;
        player.seekTo(segment.start, true);
        setCurrentLine(-1);
        renderLoopDots();
        applyReveal();
      }
    }
  }

  requestAnimationFrame(tick);
}

requestAnimationFrame(tick);

// Two bottom sheets, one open at a time: "seg" (segment list) and "notes"
// (this video's saved segments). Passing the open sheet's name again closes it.
function openSheet(which) {
  state.sheet = state.sheet === which ? null : which;
  if (state.sheet === "notes") renderNotes();
  const sheets = { seg: els.segSheet, notes: els.notesSheet, word: els.wordSheet };
  Object.entries(sheets).forEach(([name, el]) => {
    const on = state.sheet === name;
    el.classList.toggle("is-open", on);
    el.setAttribute("aria-hidden", String(!on));
  });
  els.sheetBackdrop.hidden = state.sheet === null;
  els.segBtn.setAttribute("aria-expanded", String(state.sheet === "seg"));
  els.notesBtn.setAttribute("aria-expanded", String(state.sheet === "notes"));
}

// The notes sheet lists the current video's saved segments; each row jumps to
// its segment, and the × removes it.
function renderNotes() {
  const list = getVideoBookmarks(state.videoId);
  els.notesCount.textContent = `${list.length}개`;
  if (!list.length) {
    els.notesList.innerHTML = "";
    els.notesEmpty.hidden = false;
    return;
  }
  els.notesEmpty.hidden = true;
  els.notesList.innerHTML = list
    .map((b) => `
        <div class="note-item">
          <button type="button" class="segment-item note-go" data-index="${b.seg}">
            <span class="segment-index">${String(b.seg + 1).padStart(2, "0")}</span>
            <span class="segment-text">${escapeHtml(b.text)}</span>
            <span class="segment-dur">${formatTime(b.start)}</span>
          </button>
          <button type="button" class="note-del" data-del="${b.seg}" aria-label="메모에서 삭제">×</button>
        </div>
      `)
    .join("");
}

function closeSheet() {
  if (state.sheet) openSheet(state.sheet);
}

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

// --- AI study prompt --------------------------------------------------------
// Joins a segment's caption lines into a single plain-text sentence string.
function segmentText(segment) {
  return segment ? segment.lines.map((l) => l.text).join(" ").trim() : "";
}

// Build a Korean study prompt for the current segment: the sentence the learner
// is on, plus the preceding segments as context, asking an AI to explain it
// thoroughly (meaning, grammar, nuance, usage) rather than just translate.
function buildStudyPrompt() {
  const current = segmentText(state.segments[state.current]);
  // A couple of earlier segments give the AI enough conversational context.
  const previous = state.segments
    .slice(Math.max(0, state.current - 2), state.current)
    .map(segmentText)
    .filter(Boolean)
    .join(" ")
    .trim();
  const context = previous || "(이전 맥락 없음)";

  return [
    "다음 영어 문장을 학습자가 완전히 이해할 수 있도록 한국어로 설명해 주세요.",
    "",
    "현재 문장:",
    `"${current}"`,
    "",
    "이전 맥락:",
    `"${context}"`,
    "",
    "이 문장이 이전 맥락과 어떻게 이어지는지 설명해 주세요.",
    "사용자가 헷갈릴 만한 단어, 표현, 문법, 뉘앙스를 짚어 주세요.",
    "표현의 실제 쓰임새, 비슷한 예문, 다른 상황에서의 활용 예시도 함께 알려 주세요.",
    "단순 번역이 아니라, 이 문장을 완전히 이해하고 실제로 말할 수 있게 만드는 설명을 해 주세요.",
  ].join("\n");
}

// Copy text to the clipboard, with a fallback for browsers/contexts where the
// async Clipboard API is unavailable (e.g. non-secure origins).
async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

let _toastTimer = null;
function showToast(message) {
  if (!els.toast) return;
  els.toast.textContent = message;
  els.toast.hidden = false;
  // Force a reflow so the transition runs even on rapid repeat taps.
  void els.toast.offsetWidth;
  els.toast.classList.add("is-shown");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    els.toast.classList.remove("is-shown");
    setTimeout(() => { els.toast.hidden = true; }, 250);
  }, 2200);
}

async function copyStudyPrompt() {
  if (!state.segments[state.current]) return;
  const ok = await copyToClipboard(buildStudyPrompt());
  if (ok) {
    els.aiPromptBtn.classList.add("is-copied");
    setTimeout(() => els.aiPromptBtn.classList.remove("is-copied"), 900);
    showToast("AI 학습 프롬프트가 복사되었습니다");
  } else {
    showToast("복사에 실패했습니다. 다시 시도해 주세요");
  }
}

// --- Events ---------------------------------------------------------------
window.addEventListener("hashchange", route);

els.aiPromptBtn.addEventListener("click", copyStudyPrompt);

// Shared by the home and library feeds: a saved-expression row deep-links to its
// segment; a thumbnail card opens its video.
function onFeedClick(event) {
  const row = event.target.closest(".note-row");
  if (row) {
    pendingSegment = Number(row.dataset.seg); // jump to the saved segment on load
    openVideo(videos[Number(row.dataset.video)]);
    return;
  }
  const card = event.target.closest(".card");
  if (!card) return;
  openVideo(videos[Number(card.dataset.video)]);
}
els.homeFeed.addEventListener("click", onFeedClick);
els.libraryFeed.addEventListener("click", onFeedClick);

els.homeFilters.addEventListener("click", (event) => {
  const chip = event.target.closest(".chip");
  if (!chip || chip.dataset.cat === homeFilter) return;
  homeFilter = chip.dataset.cat;
  renderHome();
  els.homeFeed.scrollIntoView({ block: "start" }); // jump back to the top of the narrowed feed
});

els.backBtn.addEventListener("click", goHome);
els.segBtn.addEventListener("click", () => openSheet("seg"));
els.notesBtn.addEventListener("click", () => openSheet("notes"));
els.saveSegBtn.addEventListener("click", toggleSaveCurrent);
els.sheetBackdrop.addEventListener("click", closeSheet);

els.notesList.addEventListener("click", (event) => {
  const del = event.target.closest(".note-del");
  if (del) {
    const seg = Number(del.dataset.del);
    removeBookmark(state.videoId, seg);
    state.bookmarks.delete(seg);
    renderNotes();
    render();
    return;
  }
  const go = event.target.closest(".note-go");
  if (!go) return;
  selectSegment(Number(go.dataset.index), true);
  closeSheet();
});

els.caption.addEventListener("click", (event) => {
  const line = event.target.closest(".cap-line");
  if (!line) return;
  seekToLine(Number(line.dataset.line));
});

els.segmentList.addEventListener("click", (event) => {
  const item = event.target.closest(".segment-item");
  if (!item) return;
  selectSegment(Number(item.dataset.index), true);
  closeSheet();
});

// Tapping a gloss chip opens its word-detail sheet (rich fields + save action).
els.glossList.addEventListener("click", (event) => {
  const chip = event.target.closest(".gloss-item");
  if (!chip) return;
  const g = state.segments[state.current]?.glossary?.[Number(chip.dataset.gi)];
  if (g) openGlossDetail(g);
});

// Save / unsave the word currently shown in the detail sheet.
els.wordSaveBtn.addEventListener("click", () => {
  if (!state.wordRecord) return;
  const saved = toggleVocab(state.wordRecord);
  renderWordSheet();
  showToast(saved ? "단어장에 저장했어요" : "단어장에서 뺐어요");
  if (state.view === "words") renderWords();
});

// 단어장 mode switch (목록 / 복습 / 퀴즈).
els.wordsModes.addEventListener("click", (event) => {
  const btn = event.target.closest(".wmode");
  if (!btn || btn.dataset.mode === state.wordsMode) return;
  state.wordsMode = btn.dataset.mode;
  if (state.wordsMode === "quiz") state.quiz = null; // start the quiz fresh each entry
  renderWords();
});

// One delegated handler for everything inside the 단어장 body across all modes.
els.wordsBody.addEventListener("click", (event) => {
  // 난이도/type filter chips (목록 + 복습 share these).
  const filter = event.target.closest("[data-wfilter]");
  if (filter) {
    state.wordsFilter = filter.dataset.wfilter;
    if (filter.dataset.quizWrong) state.wordsMode = "list"; // "자주 틀린 단어 보기" jumps to the list
    renderWords();
    return;
  }

  // 목록: delete a word, or open its detail sheet.
  const del = event.target.closest(".word-del");
  if (del) {
    removeVocab(del.dataset.del);
    renderWords();
    return;
  }
  const row = event.target.closest(".word-row");
  if (row) {
    const word = loadVocab().words.find((w) => w.id === row.dataset.id);
    if (word) showWordDetail(word);
    return;
  }

  // 복습: flip the flashcard, step the deck, or reshuffle.
  if (event.target.closest("[data-flip]")) {
    state.review.flipped = !state.review.flipped;
    renderWords();
    return;
  }
  const nav = event.target.closest("[data-review-nav]");
  if (nav) {
    state.review.pos += nav.dataset.reviewNav === "next" ? 1 : -1;
    state.review.flipped = false;
    renderWords();
    return;
  }
  if (event.target.closest("[data-review-shuffle]")) {
    state.reviewToken += 1;
    renderWords();
    return;
  }

  // 퀴즈: start/restart, answer an option, or advance to the next question.
  if (event.target.closest("[data-quiz-start]")) {
    buildQuiz(loadVocab().words);
    renderWords();
    return;
  }
  const opt = event.target.closest("[data-opt]");
  if (opt && state.quiz && state.quiz.picked === null) {
    const i = Number(opt.dataset.opt);
    const cur = state.quiz.questions[state.quiz.index];
    state.quiz.picked = i;
    const correct = cur.options[i].correct;
    if (correct) state.quiz.score += 1;
    recordQuizResult(cur.id, correct);
    renderWords();
    return;
  }
  if (event.target.closest("[data-quiz-next]")) {
    state.quiz.index += 1;
    state.quiz.picked = null;
    if (state.quiz.index >= state.quiz.questions.length) state.quiz.done = true;
    renderWords();
    return;
  }
});

// Peek: hold to reveal the whole caption, release to return to the reveal level.
els.peekBtn.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  setPeek(true);
});
["pointerup", "pointerleave", "pointercancel"].forEach((type) =>
  els.peekBtn.addEventListener(type, () => setPeek(false)));
els.peekBtn.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    event.stopPropagation();
    setPeek(!state.peek);
  }
});
els.peekBtn.addEventListener("blur", () => setPeek(false));

els.paceGroup.addEventListener("click", (event) => {
  const button = event.target.closest("[data-pace]");
  if (!button || button.dataset.pace === state.pace) return;
  state.pace = button.dataset.pace;
  els.paceButtons.forEach((b) => b.classList.toggle("is-active", b.dataset.pace === state.pace));
  recomputeTarget();
});

els.prevSegment.addEventListener("click", () => selectSegment(state.current - 1, true));
els.nextSegment.addEventListener("click", () => selectSegment(state.current + 1, true));

els.playPause.addEventListener("click", () => {
  if (!playerReady || !state.segments.length) return;
  const status = player.getPlayerState();
  if (status === YT.PlayerState.PLAYING) {
    player.pauseVideo();
  } else {
    player.playVideo();
    player.setPlaybackRate(state.speed);
  }
});

els.speedButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.speed = Number(button.dataset.speed);
    if (playerReady && player) player.setPlaybackRate(state.speed);
    render();
  });
});

document.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement) return;
  const key = event.key.toLowerCase();
  if (key === "escape") {
    if (state.sheet) closeSheet();
    else if (state.view !== "home") goHome();
    return;
  }
  // The rest only apply on the detail page.
  if (state.view !== "detail") return;
  if (key === " ") {
    event.preventDefault();
    els.playPause.click();
  }
  if (key === "arrowleft") selectSegment(state.current - 1, true);
  if (key === "arrowright") selectSegment(state.current + 1, true);
  if (key === "b") {
    event.preventDefault();
    toggleSaveCurrent();
  }
});

init();
