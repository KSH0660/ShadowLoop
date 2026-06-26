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
  view: "home",   // "home" (browse grid) | "library" | "words" (단어장) | "detail" (player)
  videoId: null,
  title: "영상을 불러오는 중…",
  segments: [],
  current: 0,
  line: -1,
  speed: 1,
  loops: 0,       // completed repeats of the current segment
  target: 3,      // repeats until fully revealed, scaled by caption length + pace
  cloze: [],      // maskable word indices, in reading order
  pace: "fast",   // fast (2–4 reps, default) | slow (3–10 reps)
  peek: false,    // holding the peek button → show the full caption
  sheet: null,    // null | "seg" | "notes" | "word"
  wordItem: null, // glossary entry currently shown in the word-detail sheet
  wordCtx: null,  // { video, seg, label } source of state.wordItem (for 단어장 저장)
  bookmarks: new Set(), // current video's saved segment indices (fast lookup for UI)
};

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
  homeFeed: document.querySelector("#homeFeed"),
  libraryFeed: document.querySelector("#libraryFeed"),
  wordsFeed: document.querySelector("#wordsFeed"),
  wordsCount: document.querySelector("#wordsCount"),
  wordsFilters: document.querySelector("#wordsFilters"),
  reviewView: document.querySelector("#reviewView"),
  reviewProgress: document.querySelector("#reviewProgress"),
  reviewShuffle: document.querySelector("#reviewShuffle"),
  reviewClose: document.querySelector("#reviewClose"),
  reviewPrev: document.querySelector("#reviewPrev"),
  reviewNext: document.querySelector("#reviewNext"),
  reviewHint: document.querySelector("#reviewHint"),
  flashcard: document.querySelector("#flashcard"),
  flashInner: document.querySelector("#flashInner"),
  flashFront: document.querySelector("#flashFront"),
  flashBack: document.querySelector("#flashBack"),
  quizView: document.querySelector("#quizView"),
  quizProgress: document.querySelector("#quizProgress"),
  quizScore: document.querySelector("#quizScore"),
  quizClose: document.querySelector("#quizClose"),
  quizBody: document.querySelector("#quizBody"),
  quizTerm: document.querySelector("#quizTerm"),
  quizOptions: document.querySelector("#quizOptions"),
  quizResult: document.querySelector("#quizResult"),
  quizResultScore: document.querySelector("#quizResultScore"),
  quizResultMsg: document.querySelector("#quizResultMsg"),
  quizNext: document.querySelector("#quizNext"),
  quizRestart: document.querySelector("#quizRestart"),
  homeFilters: document.querySelector("#homeFilters"),
  homeCount: document.querySelector("#homeCount"),
  tabHome: document.querySelector("#tabHome"),
  tabLibrary: document.querySelector("#tabLibrary"),
  tabWords: document.querySelector("#tabWords"),
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
  finishView: document.querySelector("#finishView"),
  finishEyebrow: document.querySelector("#finishEyebrow"),
  finishChips: document.querySelector("#finishChips"),
  finishCopyBtn: document.querySelector("#finishCopyBtn"),
  finishCopyLabel: document.querySelector("#finishCopyLabel"),
  finishHelp: document.querySelector("#finishHelp"),
  finishRestart: document.querySelector("#finishRestart"),
  finishClose: document.querySelector("#finishClose"),
  toast: document.querySelector("#toast"),
  saveSegBtn: document.querySelector("#saveSegBtn"),
  notesBtn: document.querySelector("#notesBtn"),
  notesSheet: document.querySelector("#notesSheet"),
  notesList: document.querySelector("#notesList"),
  notesCount: document.querySelector("#notesCount"),
  notesEmpty: document.querySelector("#notesEmpty"),
  wordSheet: document.querySelector("#wordSheet"),
  wordDetail: document.querySelector("#wordDetail"),
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

// --- Vocabulary (단어장) ----------------------------------------------------
// The learner's personal word list, built by tapping "단어장에 저장" in the word-
// detail sheet. Stored in localStorage (per device — no backend). Each saved word
// keeps a full snapshot of its gloss (term/ko/type + any rich fields) plus where
// it came from (video id, label, segment index), so the 단어장 tab and its review
// modes are self-describing even if a transcript rebuild shifts segment indices.
const VOCAB_KEY = "shadowloop:v1:vocab";

function loadVocab() {
  try {
    const raw = JSON.parse(localStorage.getItem(VOCAB_KEY));
    return raw && Array.isArray(raw.words) ? raw : { words: [] };
  } catch {
    return { words: [] };
  }
}

function saveVocab(data) {
  try {
    localStorage.setItem(VOCAB_KEY, JSON.stringify(data));
  } catch {
    // localStorage unavailable (e.g. private mode) — the word list just won't persist.
  }
}

// Stable identity for a saved word: which gloss, in which video + segment. Lets a
// word be saved once and toggled off, and the same term in two clips coexist.
function vocabId(term, videoId, seg) {
  return `${videoId}::${seg}::${term}`;
}

function isVocabSaved(term, videoId, seg) {
  const id = vocabId(term, videoId, seg);
  return loadVocab().words.some((w) => w.id === id);
}

// Save / unsave one glossary entry to the 단어장. Returns true if now saved.
function toggleVocab(item, videoId, seg, videoLabel) {
  if (!item || !videoId) return false;
  const data = loadVocab();
  const id = vocabId(item.term, videoId, seg);
  const at = data.words.findIndex((w) => w.id === id);
  let saved;
  if (at >= 0) {
    data.words.splice(at, 1);
    saved = false;
  } else {
    // Snapshot the whole gloss (incl. optional rich fields) + its source.
    data.words.push({ ...item, id, video: videoId, videoLabel, seg, addedAt: Date.now() });
    saved = true;
  }
  saveVocab(data);
  return saved;
}

function removeVocab(id) {
  const data = loadVocab();
  data.words = data.words.filter((w) => w.id !== id);
  saveVocab(data);
}

// Tally a quiz answer onto the saved word: correct/wrong counts drive the
// "자주 틀린 단어" list. No-op if the word was meanwhile removed.
function recordQuizResult(id, ok) {
  const data = loadVocab();
  const w = data.words.find((x) => x.id === id);
  if (!w) return;
  if (ok) w.correct = (w.correct || 0) + 1;
  else w.wrong = (w.wrong || 0) + 1;
  saveVocab(data);
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

// The next video the learner hasn't started yet (no saved progress), for
// autoplay after finishing a video. Scans forward from the current video and
// wraps around, so it lands on the nearest fresh clip; returns null once every
// video has been touched (then the finish screen shows instead).
function nextUnstudiedVideo() {
  if (!videos.length) return null;
  const progressMap = loadProgress();
  const startIndex = videos.findIndex((v) => v.id === state.videoId);
  for (let i = 1; i <= videos.length; i++) {
    const video = videos[(startIndex + i) % videos.length];
    if (video.id !== state.videoId && videoPercent(progressMap, video.id) === 0) {
      return video;
    }
  }
  return null;
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

// WORDS (단어장) — the saved-vocabulary tab. Lists every saved gloss, most-recent
// first; each row shows the term, its 간결한 뜻, type, and source clip. Tapping a row
// reopens the same word-detail sheet; the × removes it.
function wordRowHtml(w, opts = {}) {
  const type = TYPE_LABEL[w.type];
  const src = w.videoLabel ? `${escapeHtml(w.videoLabel)} · 구간 ${w.seg + 1}` : "";
  const wrong = opts.showWrong && w.wrong ? `<span class="word-wrong">✕ ${w.wrong}</span>` : "";
  return `
    <div class="word-row">
      <button type="button" class="word-row-main" data-id="${escapeHtml(w.id)}">
        <span class="word-row-top">
          <span class="word-row-term">${escapeHtml(w.term)}</span>
          ${type ? `<span class="word-type">${type}</span>` : ""}
          ${wrong}
        </span>
        <span class="word-row-ko">${escapeHtml(w.ko)}</span>
        ${src ? `<span class="word-row-src">${src}</span>` : ""}
      </button>
      <button type="button" class="note-del word-del" data-del="${escapeHtml(w.id)}" aria-label="단어장에서 삭제">×</button>
    </div>`;
}

// 난이도(=type) filter for the 단어장 list + review set. "all" or a gloss type.
let wordsFilter = "all";
const WORDS_FILTERS = [["all", "전체"], ["idiom", "관용구"], ["phrase", "표현"], ["word", "단어"]];

// The saved words after the active type filter, most-recent-first (review order
// shuffles a copy of this).
function filteredVocab() {
  const words = loadVocab().words.slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  return wordsFilter === "all" ? words : words.filter((w) => w.type === wordsFilter);
}

function renderWords() {
  const all = loadVocab().words;
  els.wordsCount.textContent = all.length ? `${all.length}개 단어` : "";
  if (!all.length) {
    wordsFilter = "all";
    els.wordsFilters.innerHTML = "";
    els.wordsFeed.innerHTML = `<p class="home-empty">아직 저장한 단어가 없어요.<br>영상 자막 밑의 단어 칩을 눌러 ‘단어장에 저장’해 보세요.</p>`;
    return;
  }

  const counts = { all: all.length, word: 0, phrase: 0, idiom: 0 };
  all.forEach((w) => { if (counts[w.type] != null) counts[w.type] += 1; });
  // A filter whose type no longer has any words falls back to 전체.
  if (wordsFilter !== "all" && !counts[wordsFilter]) wordsFilter = "all";

  els.wordsFilters.innerHTML = WORDS_FILTERS
    .filter(([k]) => k === "all" || counts[k] > 0)
    .map(([k, label]) => `
      <button type="button" class="chip${k === wordsFilter ? " is-active" : ""}" data-wfilter="${k}">
        ${label}<span class="chip-count">${counts[k]}</span>
      </button>`)
    .join("");

  const list = filteredVocab();

  // 자주 틀린 단어 — words with quiz misses, most-missed first. Cross-cutting, so
  // only shown in the unfiltered 전체 view (it has its own ordering).
  const troubled = wordsFilter === "all"
    ? all.filter((w) => w.wrong > 0)
        .sort((a, b) => (b.wrong - a.wrong) || ((b.addedAt || 0) - (a.addedAt || 0)))
        .slice(0, 12)
    : [];

  let html = "";
  if (troubled.length) {
    html += `
      <section class="feed-group">
        <h2 class="feed-group-title">자주 틀린 단어</h2>
        <div class="word-rows">${troubled.map((w) => wordRowHtml(w, { showWrong: true })).join("")}</div>
      </section>`;
  }

  if (list.length) {
    // 복습(플래시카드) is available with any word; 퀴즈 needs ≥4 words for choices.
    html += `
      <div class="review-ctas">
        <button type="button" class="review-cta" id="reviewStart">🎴 플래시카드 · ${list.length}</button>
        ${all.length >= 4 ? `<button type="button" class="review-cta quiz-cta" id="quizStart">📝 퀴즈 · ${list.length}</button>` : ""}
      </div>
      <section class="feed-group">
        ${troubled.length ? `<h2 class="feed-group-title">전체 단어</h2>` : ""}
        <div class="word-rows">${list.map((w) => wordRowHtml(w)).join("")}</div>
      </section>`;
  }

  els.wordsFeed.innerHTML = html;
}

// --- Flashcard review (복습) ------------------------------------------------
// A full-screen sub-mode of the 단어장: flip through the (filtered) saved words as
// flashcards. Front = term; back = 뜻 + 쉬운 뜻 + 예문. Shuffled each start.
const review = { cards: [], idx: 0, flipped: false };

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function startReview(words) {
  if (!words.length) return;
  review.cards = shuffled(words);
  review.idx = 0;
  renderCard();
  els.reviewView.hidden = false;
  document.body.classList.add("is-review");
}

function renderCard() {
  const w = review.cards[review.idx];
  if (!w) return;
  els.reviewProgress.textContent = `${review.idx + 1} / ${review.cards.length}`;
  const type = TYPE_LABEL[w.type];
  els.flashFront.innerHTML = `
    <span class="flash-term">${escapeHtml(w.term)}</span>
    ${type ? `<span class="word-type">${type}</span>` : ""}`;
  const back = [`<p class="flash-ko">${escapeHtml(w.ko)}</p>`];
  if (w.easy) back.push(`<p class="flash-easy">${escapeHtml(w.easy)}</p>`);
  if (w.ex) {
    back.push(`<p class="flash-ex">${escapeHtml(w.ex)}${w.exKo ? `<br><span class="flash-exko">${escapeHtml(w.exKo)}</span>` : ""}</p>`);
  }
  els.flashBack.innerHTML = back.join("");
  setFlip(false);
}

function setFlip(on) {
  review.flipped = on;
  els.flashInner.classList.toggle("is-flipped", on);
  els.reviewHint.textContent = on ? "다시 탭하면 단어로" : "카드를 탭하면 뜻이 보여요";
}

function reviewStep(delta) {
  const n = review.cards.length;
  if (!n) return;
  review.idx = (review.idx + delta + n) % n;
  renderCard();
}

function closeReview() {
  els.reviewView.hidden = true;
  document.body.classList.remove("is-review");
}

// --- Quiz (퀴즈) ------------------------------------------------------------
// Multiple-choice "meaning of this expression?" over the (filtered) saved words.
// Each answer is tallied onto the word (correct/wrong) for the 자주 틀린 단어 list.
const quiz = { cards: [], idx: 0, answered: false, correct: 0, source: [] };

// Build the question deck: each card is a word + four Korean choices (its own
// gloss plus distractors drawn from the whole 단어장), with the right index.
function buildQuiz(words) {
  const pool = [...new Set(loadVocab().words.map((w) => w.ko))];
  return shuffled(words).map((w) => {
    const distractors = shuffled(pool.filter((k) => k !== w.ko)).slice(0, 3);
    const options = shuffled([w.ko, ...distractors]);
    return { word: w, options, answer: options.indexOf(w.ko) };
  });
}

function startQuiz(words) {
  if (words.length < 1 || loadVocab().words.length < 4) return;
  quiz.source = words;
  quiz.cards = buildQuiz(words);
  quiz.idx = 0;
  quiz.correct = 0;
  els.quizResult.hidden = true;
  els.quizBody.hidden = false;
  renderQuestion();
  els.quizView.hidden = false;
  document.body.classList.add("is-review");
}

function renderQuestion() {
  const c = quiz.cards[quiz.idx];
  if (!c) return;
  quiz.answered = false;
  els.quizProgress.textContent = `${quiz.idx + 1} / ${quiz.cards.length}`;
  els.quizScore.textContent = `⭐ ${quiz.correct}`;
  els.quizTerm.textContent = c.word.term;
  els.quizOptions.innerHTML = c.options
    .map((opt, i) => `<button type="button" class="quiz-opt" data-i="${i}">${escapeHtml(opt)}</button>`)
    .join("");
  els.quizNext.hidden = true;
  els.quizRestart.hidden = true;
}

function answerQuiz(picked) {
  if (quiz.answered) return;
  quiz.answered = true;
  const c = quiz.cards[quiz.idx];
  const ok = picked === c.answer;
  if (ok) quiz.correct += 1;
  recordQuizResult(c.word.id, ok);
  [...els.quizOptions.children].forEach((btn, i) => {
    btn.disabled = true;
    if (i === c.answer) btn.classList.add("is-correct");
    else if (i === picked) btn.classList.add("is-wrong");
  });
  els.quizScore.textContent = `⭐ ${quiz.correct}`;
  const last = quiz.idx === quiz.cards.length - 1;
  els.quizNext.textContent = last ? "결과 보기" : "다음";
  els.quizNext.hidden = false;
}

function quizNext() {
  if (quiz.idx >= quiz.cards.length - 1) { showQuizResult(); return; }
  quiz.idx += 1;
  renderQuestion();
}

function showQuizResult() {
  const total = quiz.cards.length;
  const score = quiz.correct;
  els.quizBody.hidden = true;
  els.quizResult.hidden = false;
  els.quizResultScore.textContent = `${score} / ${total}`;
  const pct = total ? score / total : 0;
  els.quizResultMsg.textContent =
    pct === 1 ? "완벽해요! 🎉" : pct >= 0.7 ? "잘했어요! 👏" : pct >= 0.4 ? "조금만 더! 💪" : "다시 복습해 볼까요? 📖";
  els.quizProgress.textContent = `${total} / ${total}`;
  els.quizNext.hidden = true;
  els.quizRestart.hidden = false;
}

function closeQuiz() {
  els.quizView.hidden = true;
  document.body.classList.remove("is-review");
}

// --- Routing ---------------------------------------------------------------
// #/            → home
// #/library     → 보관함 (saved expressions + in-progress)
// #/words       → 단어장 (saved vocabulary)
// #/v/<videoId> → that video's detail page
function route() {
  closeReview(); // leaving / re-entering a view always exits the flashcard overlay
  closeQuiz();
  closeFinish();
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
  [["home", els.tabHome], ["words", els.tabWords], ["library", els.tabLibrary]].forEach(([name, el]) => {
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
  renderWords();
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
  // Each chip stays intentionally terse (term + 간결한 뜻); tapping it opens the
  // word-detail sheet with whatever rich fields the gloss has (all optional).
  els.glossList.innerHTML = items
    .map((g, i) => `
        <li>
          <button type="button" class="gloss-item" data-gloss="${i}">
            <span class="gloss-term">${escapeHtml(g.term)}</span>
            <span class="gloss-ko">${escapeHtml(g.ko)}</span>
          </button>
        </li>`)
    .join("");
  els.glossary.hidden = false;
}

// Korean labels for the gloss `type` (the only "난이도" signal we have for now).
const TYPE_LABEL = { word: "단어", phrase: "표현", idiom: "관용구" };

// Render one glossary entry's rich detail into the word sheet. Every rich field
// (easy/nuance/when/ex/exKo/vs/tip) is optional — only the present ones show, so
// older { term, ko, type }-only glosses still render cleanly (just the header).
function renderWordDetail(item) {
  const field = (label, value) =>
    value ? `<div class="word-field"><span class="word-field-label">${label}</span><p class="word-field-val">${escapeHtml(value)}</p></div>` : "";

  const exHtml = item.ex
    ? `<div class="word-field"><span class="word-field-label">예문</span>
         <p class="word-field-val word-ex-en">${escapeHtml(item.ex)}</p>
         ${item.exKo ? `<p class="word-field-val word-ex-ko">${escapeHtml(item.exKo)}</p>` : ""}</div>`
    : "";

  const body = [
    field("쉬운 뜻", item.easy),
    field("뉘앙스", item.nuance),
    field("이런 상황에", item.when),
    exHtml,
    field("비슷한 말과 차이", item.vs),
    field("헷갈리면", item.tip),
  ].filter(Boolean).join("");

  const typeLabel = TYPE_LABEL[item.type];
  const ctx = state.wordCtx || {};
  const saved = isVocabSaved(item.term, ctx.video, ctx.seg);
  els.wordDetail.innerHTML = `
    <div class="word-head">
      <div class="word-head-top">
        <span class="word-term">${escapeHtml(item.term)}</span>
        ${typeLabel ? `<span class="word-type">${typeLabel}</span>` : ""}
      </div>
      <p class="word-ko">${escapeHtml(item.ko)}</p>
    </div>
    ${body ? `<div class="word-fields">${body}</div>` : `<p class="word-empty">자세한 해설은 아직 준비 중이에요.</p>`}
    <button type="button" class="word-save ${saved ? "is-saved" : ""}" id="wordSaveBtn">
      ${saved ? "★ 단어장에 저장됨" : "☆ 단어장에 저장"}
    </button>`;
}

// The label of the currently-open video (its short tag), used as the source
// label when saving a word to the 단어장 from the player.
function currentVideoLabel() {
  const v = videos.find((x) => x.id === state.videoId);
  return v ? (v.tag || v.title || "") : state.title;
}

// Open the word-detail sheet for a glossary entry. `ctx` ({ video, seg, label })
// records where the word came from so it can be saved to / removed from the 단어장;
// it defaults to the current player segment. Re-renders if already open (tapping a
// different chip), so switching words doesn't toggle the sheet shut.
function openWordSheet(item, ctx) {
  if (!item) return;
  state.wordItem = item;
  state.wordCtx = ctx || { video: state.videoId, seg: state.current, label: currentVideoLabel() };
  renderWordDetail(item);
  if (state.sheet !== "word") openSheet("word");
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
        if (state.current === state.segments.length - 1) {
          // The whole video is done. Auto-advance to the next video the learner
          // hasn't started yet (continuous learning), like a playlist. When none
          // is left, pause and surface the completion screen that turns the
          // finished session into "now make it your own English".
          const next = nextUnstudiedVideo();
          if (next) {
            openVideo(next); // loadVideoById autoplays from the new video's start
          } else {
            player.pauseVideo();
            showFinish();
          }
        } else {
          selectSegment(state.current + 1, true);
        }
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

// Bottom sheets, one open at a time: "seg" (segment list), "notes" (this video's
// saved segments), and "word" (one glossary entry's rich detail). Passing the
// open sheet's name again closes it.
function openSheet(which) {
  state.sheet = state.sheet === which ? null : which;
  if (state.sheet === "notes") renderNotes();
  els.segSheet.classList.toggle("is-open", state.sheet === "seg");
  els.segSheet.setAttribute("aria-hidden", String(state.sheet !== "seg"));
  els.notesSheet.classList.toggle("is-open", state.sheet === "notes");
  els.notesSheet.setAttribute("aria-hidden", String(state.sheet !== "notes"));
  els.wordSheet.classList.toggle("is-open", state.sheet === "word");
  els.wordSheet.setAttribute("aria-hidden", String(state.sheet !== "word"));
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

// --- Completion screen + AI tutor prompt ------------------------------------
// The signature end-of-video moment: once the whole video is shadowed, we don't
// just stop — we hand the learner a ready-to-paste prompt that turns the AI into
// a 1:1 English tutor for *producing* their own sentences from this video.

// Gather the expressions the app already emphasised for this video, in priority
// order so the AI starts where the learner's attention already was:
//   1. glossary terms we hinted under each segment,
//   2. words they saved to the 단어장 from this video,
//   3. sentences they bookmarked.
// Terms are deduped case-insensitively; sentences kept verbatim.
function collectEmphasis(video) {
  const terms = [];
  const seen = new Set();
  const pushTerm = (term, ko) => {
    const t = (term || "").trim();
    const key = t.toLowerCase();
    if (!t || seen.has(key)) return;
    seen.add(key);
    terms.push({ term: t, ko: (ko || "").trim() });
  };
  (video.segments || []).forEach((seg) =>
    (seg.glossary || []).forEach((g) => pushTerm(g.term, g.ko)));
  loadVocab().words
    .filter((w) => w.video === video.id)
    .forEach((w) => pushTerm(w.term, w.ko));
  const sentences = getVideoBookmarks(video.id).map((b) => b.text).filter(Boolean);
  return { terms, sentences };
}

// Build the whole-video tutor prompt: the full transcript (the flow + every
// sentence the learner repeated), the emphasised expressions to lead with, and
// a strict conversational lesson protocol so the AI teaches one expression at a
// time and pushes the learner to rephrase + write rather than dumping a wall of
// translation.
function buildTutorPrompt(video) {
  const title = video.title || video.tag || "영어 영상";
  const transcript = (video.segments || [])
    .map((seg, i) => `${i + 1}. ${segmentText(seg)}`)
    .filter((line) => line.trim().length > 3)
    .join("\n");
  const { terms, sentences } = collectEmphasis(video);

  const termList = terms.length
    ? terms.map((t) => (t.ko ? `- ${t.term} (${t.ko})` : `- ${t.term}`)).join("\n")
    : "- (따로 표시된 표현이 없어요 — 위 대본에서 직접 핵심 표현을 골라 주세요)";

  const lines = [
    "당신은 친절하고 인내심 있는 1:1 영어 회화 튜터입니다. 저는 아래 영어 영상을 문장 단위로 반복해 듣고 따라 말하는 '쉐도잉'을 막 끝낸 한국어 사용자예요.",
    "이제 해석을 듣는 단계를 넘어, 이 영상 속 표현을 '제 표현'으로 만들어 실제로 말하고 쓸 수 있게 도와주세요.",
    "",
    `[영상] ${title}`,
    "",
    "[영상 전체 대본 — 제가 반복 학습한 문장들이고, 이게 전체 흐름이에요]",
    transcript,
    "",
    "[제가 특히 집중한 핵심 표현 — 여기서부터 시작해 주세요]",
    termList,
  ];
  if (sentences.length) {
    lines.push(
      "",
      "[제가 따로 저장해 둔 문장들 — 우선적으로 다뤄 주세요]",
      sentences.map((s) => `- "${s}"`).join("\n"),
    );
  }
  lines.push(
    "",
    "[수업 진행 방식 — 꼭 지켜 주세요]",
    "1. 한 번에 다 설명하지 마세요. 핵심 표현을 하나씩, 대화하듯 천천히 다뤄 주세요.",
    "2. 각 표현마다 (1) 영상 속 상황과 화자의 감정, (2) 표현의 핵심 의미와 뉘앙스, (3) 직역과 실제로 쓰이는 자연스러운 의미의 차이, (4) 일상에서 바로 쓰는 짧은 실제 예문 2개를 알려 주세요.",
    "3. 설명한 뒤에는 곧바로 저에게 질문을 던져, 그 표현을 '제 상황'에 맞춰 직접 영어 문장으로 바꿔 말해 보게 해 주세요.",
    "4. 제가 만든 문장을 자연스럽게 다듬어 주고 더 나은 표현을 제안한 뒤, 짧은 영작 과제를 하나 내 주세요.",
    "5. 제가 답하기 전에는 절대 다음 표현으로 넘어가지 마세요. 매 단계 끝에 '준비되면 다음으로 넘어갈까요?'처럼 제 반응을 기다려 주세요.",
    "6. 설명은 한국어로, 예문과 제가 연습할 문장은 영어로 해 주세요.",
    "",
    "준비됐으면, 먼저 짧게 인사하고 위 핵심 표현 중 첫 번째 하나만 골라 설명한 다음, 저에게 첫 질문을 해 주세요.",
  );
  return lines.join("\n");
}

// Show up to six emphasised expressions as chips so the learner can see, at a
// glance, what the AI lesson will start from (and feel it's *their* material).
function renderFinishChips(emphasis) {
  const chips = emphasis.terms.slice(0, 6);
  if (!chips.length) {
    els.finishChips.hidden = true;
    els.finishChips.innerHTML = "";
    return;
  }
  els.finishChips.hidden = false;
  els.finishChips.innerHTML = chips
    .map((t) => `<span class="finish-chip">${escapeHtml(t.term)}</span>`)
    .join("");
}

function showFinish() {
  const video = videos.find((v) => v.id === state.videoId);
  if (!video) return;
  els.finishEyebrow.textContent = video.tag || video.title || "학습 완료";
  renderFinishChips(collectEmphasis(video));
  els.finishCopyBtn.classList.remove("is-copied");
  els.finishCopyLabel.textContent = "AI 튜터와 내 표현 만들기";
  els.finishHelp.textContent = "이 버튼을 누르면 영상 전체 흐름과 핵심 표현이 담긴 학습 프롬프트가 복사돼요.";
  els.finishView.hidden = false;
  document.body.classList.add("is-finish");
}

function closeFinish() {
  els.finishView.hidden = true;
  document.body.classList.remove("is-finish");
}

async function copyTutorPrompt() {
  const video = videos.find((v) => v.id === state.videoId);
  if (!video) return;
  const ok = await copyToClipboard(buildTutorPrompt(video));
  if (ok) {
    els.finishCopyBtn.classList.add("is-copied");
    els.finishCopyLabel.textContent = "프롬프트 복사됨 ✓";
    els.finishHelp.textContent =
      "복사했어요! ChatGPT·Claude 같은 AI에 붙여넣으면 이 영상 속 표현으로 1:1 회화·작문 수업이 시작돼요.";
    showToast("복사 완료! AI에 붙여넣으면 내 표현 수업이 시작돼요");
  } else {
    showToast("복사에 실패했습니다. 다시 시도해 주세요");
  }
}

// --- Events ---------------------------------------------------------------
window.addEventListener("hashchange", route);

els.aiPromptBtn.addEventListener("click", copyStudyPrompt);

els.finishCopyBtn.addEventListener("click", copyTutorPrompt);
els.finishRestart.addEventListener("click", () => { closeFinish(); selectSegment(0, true); });
els.finishClose.addEventListener("click", closeFinish);

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

// Tapping a glossary chip opens its rich detail in the word sheet.
els.glossList.addEventListener("click", (event) => {
  const chip = event.target.closest(".gloss-item");
  if (!chip) return;
  const items = state.segments[state.current]?.glossary || [];
  openWordSheet(items[Number(chip.dataset.gloss)]);
});

// Save / unsave the open word to the 단어장 (button lives inside the word sheet).
els.wordDetail.addEventListener("click", (event) => {
  if (!event.target.closest(".word-save")) return;
  const ctx = state.wordCtx || {};
  const saved = toggleVocab(state.wordItem, ctx.video, ctx.seg, ctx.label);
  renderWordDetail(state.wordItem); // refresh the button's saved state
  if (state.view === "words") renderWords(); // keep the list in sync if open behind
  showToast(saved ? "단어장에 저장했어요" : "단어장에서 뺐어요");
});

// 단어장 list: 복습 시작 / tap a row to reopen its detail / × removes it.
els.wordsFeed.addEventListener("click", (event) => {
  if (event.target.closest("#reviewStart")) {
    startReview(filteredVocab());
    return;
  }
  if (event.target.closest("#quizStart")) {
    startQuiz(filteredVocab());
    return;
  }
  const del = event.target.closest(".word-del");
  if (del) {
    removeVocab(del.dataset.del);
    renderWords();
    return;
  }
  const main = event.target.closest(".word-row-main");
  if (!main) return;
  const w = loadVocab().words.find((x) => x.id === main.dataset.id);
  if (w) openWordSheet(w, { video: w.video, seg: w.seg, label: w.videoLabel });
});

// 난이도(type) filter chips.
els.wordsFilters.addEventListener("click", (event) => {
  const chip = event.target.closest("[data-wfilter]");
  if (!chip || chip.dataset.wfilter === wordsFilter) return;
  wordsFilter = chip.dataset.wfilter;
  renderWords();
});

// Flashcard review controls.
els.flashcard.addEventListener("click", () => setFlip(!review.flipped));
els.reviewNext.addEventListener("click", () => reviewStep(1));
els.reviewPrev.addEventListener("click", () => reviewStep(-1));
els.reviewClose.addEventListener("click", closeReview);
els.reviewShuffle.addEventListener("click", () => {
  if (!review.cards.length) return;
  review.cards = shuffled(review.cards);
  review.idx = 0;
  renderCard();
});

// Quiz controls.
els.quizOptions.addEventListener("click", (event) => {
  const opt = event.target.closest(".quiz-opt");
  if (opt) answerQuiz(Number(opt.dataset.i));
});
els.quizNext.addEventListener("click", quizNext);
els.quizRestart.addEventListener("click", () => startQuiz(quiz.source));
els.quizClose.addEventListener("click", () => {
  closeQuiz();
  if (state.view === "words") renderWords(); // refresh 자주 틀린 단어 with new tallies
});

els.segmentList.addEventListener("click", (event) => {
  const item = event.target.closest(".segment-item");
  if (!item) return;
  selectSegment(Number(item.dataset.index), true);
  closeSheet();
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

  // Quiz overlay captures keys while open: 1–4 pick an option, Enter advances.
  if (!els.quizView.hidden) {
    if (key === "escape") { closeQuiz(); if (state.view === "words") renderWords(); }
    else if ("1234".includes(key) && !quiz.answered && !els.quizBody.hidden) {
      const i = Number(key) - 1;
      if (i < quiz.cards[quiz.idx]?.options.length) answerQuiz(i);
    } else if (key === "enter" || key === " ") {
      event.preventDefault();
      if (!els.quizNext.hidden) quizNext();
      else if (!els.quizRestart.hidden) startQuiz(quiz.source);
    }
    return;
  }

  // Completion overlay captures keys while open: Esc closes it.
  if (!els.finishView.hidden) {
    if (key === "escape") closeFinish();
    return;
  }

  // Flashcard review overlay captures keys while open.
  if (!els.reviewView.hidden) {
    if (key === "escape") closeReview();
    else if (key === "arrowright") reviewStep(1);
    else if (key === "arrowleft") reviewStep(-1);
    else if (key === " " || key === "enter") { event.preventDefault(); setFlip(!review.flipped); }
    return;
  }

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
