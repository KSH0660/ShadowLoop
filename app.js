// Shadow Loop client. All video + transcript data is pre-built into
// data/transcripts.json by scripts/build-transcripts.mjs; this file only loads
// that JSON and drives the YouTube player, the segment loop, and the synced
// caption. There is no runtime caption fetching.
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

let state = {
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
  sheet: null,    // null | "seg" | "video"
};

// Repeats until full reveal, by pace. "slow" drills deeper, "fast" skims.
const PACE = {
  slow: { min: 3, max: 10, base: 3, slope: 0.07 },
  fast: { min: 2, max: 4, base: 2, slope: 0.02 },
};
const RING_CIRCUMFERENCE = 2 * Math.PI * 54;

const els = {
  segBtn: document.querySelector("#segBtn"),
  videoBtn: document.querySelector("#videoBtn"),
  nowTag: document.querySelector("#nowTag"),
  videoList: document.querySelector("#videoList"),
  videoCount: document.querySelector("#videoCount"),
  emptyPlayer: document.querySelector("#emptyPlayer"),
  caption: document.querySelector("#caption"),
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
  videoSheet: document.querySelector("#videoSheet"),
  sheetBackdrop: document.querySelector("#sheetBackdrop"),
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
        if (state.videoId) {
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
    const response = await fetch("data/transcripts.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    videos = data.videos || [];
  } catch (error) {
    state.title = "자막 데이터를 불러오지 못했습니다";
    render();
    return;
  }

  renderVideoList();
  if (videos.length) loadVideo(videos[0]);
}

function renderVideoList() {
  els.videoCount.textContent = `${videos.length}개`;

  // Group videos by `category` into labelled sections (강연 vs 예능 등). Groups
  // appear in first-seen order; videos keep their order within a group. Each row
  // carries its real index into `videos` via data-video, so grouping doesn't
  // affect selection/highlight (which look the index up, not the DOM position).
  const order = [];
  const byCat = new Map();
  videos.forEach((video, index) => {
    const cat = video.category || "기타";
    if (!byCat.has(cat)) { byCat.set(cat, []); order.push(cat); }
    byCat.get(cat).push({ video, index });
  });

  els.videoList.innerHTML = order
    .map((cat) => {
      const rows = byCat.get(cat).map(({ video, index }) => `
        <button type="button" class="video-row" data-video="${index}">
          <span class="video-row-tag">${escapeHtml(video.tag || video.title)}</span>
          <span class="video-row-meta">${(video.segments || []).length}구간</span>
        </button>`).join("");
      return `<p class="video-group">${escapeHtml(cat)}</p>${rows}`;
    })
    .join("");
}

function loadVideo(video) {
  state.videoId = video.id;
  state.title = video.title;
  state.segments = video.segments || [];
  state.current = 0;
  state.line = -1;
  state.loops = 0;
  state.peek = false;
  els.peekBtn.classList.remove("is-on");
  els.emptyPlayer.classList.add("is-hidden");
  els.nowTag.textContent = video.tag || video.title || "";

  if (playerReady && player) {
    player.loadVideoById({ videoId: video.id, startSeconds: state.segments[0]?.start || 0 });
    player.setPlaybackRate(state.speed);
  }

  highlightActiveVideo(video.id);
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

function playCurrentSegment() {
  const segment = state.segments[state.current];
  if (!playerReady || !segment) return;
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
  render();
  if (autoplay) playCurrentSegment();
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

  renderCaption(segment);
  renderLoopDots();

  els.segmentList.innerHTML = state.segments
    .map((item, index) => `
        <button type="button" class="segment-item ${index === state.current ? "is-active" : ""}" data-index="${index}">
          <span class="segment-index">${String(index + 1).padStart(2, "0")}</span>
          <span class="segment-text">${escapeHtml(item.lines.map((l) => l.text).join(" "))}</span>
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
  applyReveal();
}

// Push the current reveal progress into the DOM. The whole caption fades in as
// the segment repeats, while blanked words uncover left-to-right. Called when
// the segment or the loop count changes — never per frame.
function applyReveal() {
  // Peek (holding the eye button) shows the whole caption regardless of progress.
  if (state.peek) {
    els.caption.style.setProperty("--reveal", "1");
    wordEls.forEach((node) => node.classList.remove("is-hidden"));
    return;
  }

  const t = state.target;
  const p = t > 1 ? Math.max(0, Math.min(1, state.loops / (t - 1))) : 1;
  els.caption.style.setProperty("--reveal", String(p));

  const revealed = Math.round(state.cloze.length * p);
  const stillHidden = new Set(state.cloze.slice(revealed));
  wordEls.forEach((node, idx) => node.classList.toggle("is-hidden", stillHidden.has(idx)));
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
  if (playerReady && state.segments.length && typeof player.getCurrentTime === "function") {
    const segment = state.segments[state.current];
    const now = player.getCurrentTime();
    const status = player.getPlayerState?.();

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

// Only one sheet is open at a time: "seg" (segments of the current video) or
// "video" (switch to another video). Passing the open one again closes it.
function openSheet(which) {
  state.sheet = state.sheet === which ? null : which;
  els.segSheet.classList.toggle("is-open", state.sheet === "seg");
  els.videoSheet.classList.toggle("is-open", state.sheet === "video");
  els.segSheet.setAttribute("aria-hidden", String(state.sheet !== "seg"));
  els.videoSheet.setAttribute("aria-hidden", String(state.sheet !== "video"));
  els.sheetBackdrop.hidden = state.sheet === null;
  els.segBtn.setAttribute("aria-expanded", String(state.sheet === "seg"));
  els.videoBtn.setAttribute("aria-expanded", String(state.sheet === "video"));
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

function highlightActiveVideo(id) {
  [...els.videoList.querySelectorAll(".video-row")].forEach((button) => {
    const video = videos[Number(button.dataset.video)];
    button.classList.toggle("is-active", !!video && video.id === id);
  });
}

els.segBtn.addEventListener("click", () => openSheet("seg"));
els.videoBtn.addEventListener("click", () => openSheet("video"));
els.sheetBackdrop.addEventListener("click", closeSheet);

els.videoList.addEventListener("click", (event) => {
  const row = event.target.closest(".video-row");
  if (!row) return;
  loadVideo(videos[Number(row.dataset.video)]);
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
  if (key === " ") {
    event.preventDefault();
    els.playPause.click();
  }
  if (key === "arrowleft") selectSegment(state.current - 1, true);
  if (key === "arrowright") selectSegment(state.current + 1, true);
  if (key === "escape" && state.sheet) closeSheet();
});

init();
