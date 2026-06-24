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
  view: "home",   // "home" (browse grid) | "detail" (player)
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
  sheet: null,    // null | "seg" | "notes"
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
  detailView: document.querySelector("#detailView"),
  homeFeed: document.querySelector("#homeFeed"),
  homeFilters: document.querySelector("#homeFilters"),
  homeCount: document.querySelector("#homeCount"),
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

// HOME — a browse grid of thumbnail cards, grouped into labelled sections by
// `category` (강연 vs 예능 등). Groups appear in first-seen order; videos keep
// their order within a group. Each card carries its index into `videos`.
//
// As the library grows the home gets two affordances on top of the grid:
//   • a sticky category filter-chip row (`homeFilter` narrows to one category);
//   • a top "이어보기" row of in-progress videos (most-recent-first), shown only
//     in the unfiltered "전체" view.
// Finished videos (pct 100) get a check badge wherever they appear.
const HOME_ALL = "전체";
let homeFilter = HOME_ALL;

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

  // 저장한 표현 — saved segments across every video, most-recently-saved first.
  // Only in the unfiltered view; tapping a row deep-links to that segment.
  if (homeFilter === HOME_ALL) {
    const bm = loadBookmarks();
    const saved = [];
    videos.forEach((video, index) => {
      (bm[video.id] || []).forEach((b) => saved.push({ video, index, b }));
    });
    saved.sort((a, b) => (b.b.at || 0) - (a.b.at || 0));
    if (saved.length) {
      const rows = saved
        .map(({ video, index, b }) => `
          <button type="button" class="note-row" data-video="${index}" data-seg="${b.seg}">
            <span class="note-row-text">${escapeHtml(b.text)}</span>
            <span class="note-row-meta">${escapeHtml(video.tag || video.title || "")} · ${formatTime(b.start)}</span>
          </button>`)
        .join("");
      sections.push(`
        <section class="feed-group">
          <h2 class="feed-group-title">저장한 표현</h2>
          <div class="note-rows">${rows}</div>
        </section>`);
    }
  }

  // 이어보기 — in-progress videos (0 < pct < 100), most-recent-first. Only in
  // the unfiltered view; selecting a category narrows to that grid alone.
  if (homeFilter === HOME_ALL) {
    const resume = videos
      .map((video, index) => ({ video, index, pct: videoPercent(progressMap, video.id), at: progressMap[video.id]?.at || 0 }))
      .filter((x) => x.pct > 0 && x.pct < 100)
      .sort((a, b) => b.at - a.at);
    if (resume.length) {
      const cards = resume.map((x) => cardHtml(x.video, x.index, x.video.category || "기타", x.pct)).join("");
      sections.push(`
        <section class="feed-group">
          <h2 class="feed-group-title">이어보기</h2>
          <div class="card-grid">${cards}</div>
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

// --- Routing ---------------------------------------------------------------
// #/            → home
// #/v/<videoId> → that video's detail page
function route() {
  const hash = location.hash || "#/";
  const match = hash.match(/^#\/v\/(.+)$/);
  if (match) {
    const video = videos.find((v) => v.id === decodeURIComponent(match[1]));
    if (video) { showDetail(video); return; }
  }
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

function showHome() {
  state.view = "home";
  closeSheet();
  if (playerReady && player && typeof player.pauseVideo === "function") player.pauseVideo();
  renderHome(); // refresh thumbnail progress bars with the latest watched position
  els.homeView.hidden = false;
  els.detailView.hidden = true;
  document.body.classList.remove("is-detail");
  window.scrollTo(0, 0);
}

function showDetail(video) {
  state.view = "detail";
  els.homeView.hidden = true;
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
  els.glossList.innerHTML = items
    .map((g) => `
        <li class="gloss-item">
          <span class="gloss-term">${escapeHtml(g.term)}</span>
          <span class="gloss-ko">${escapeHtml(g.ko)}</span>
        </li>`)
    .join("");
  els.glossary.hidden = false;
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
        // Fully revealed — move on (or stop at the last segment).
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
  els.segSheet.classList.toggle("is-open", state.sheet === "seg");
  els.segSheet.setAttribute("aria-hidden", String(state.sheet !== "seg"));
  els.notesSheet.classList.toggle("is-open", state.sheet === "notes");
  els.notesSheet.setAttribute("aria-hidden", String(state.sheet !== "notes"));
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

els.homeFeed.addEventListener("click", (event) => {
  const row = event.target.closest(".note-row");
  if (row) {
    pendingSegment = Number(row.dataset.seg); // jump to the saved segment on load
    openVideo(videos[Number(row.dataset.video)]);
    return;
  }
  const card = event.target.closest(".card");
  if (!card) return;
  openVideo(videos[Number(card.dataset.video)]);
});

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
    else if (state.view === "detail") goHome();
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
