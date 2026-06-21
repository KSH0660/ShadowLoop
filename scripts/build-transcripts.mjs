// Build step (run locally, NOT at runtime).
//
// Reads videos.json (the admin-managed list), downloads each video's English
// captions with yt-dlp, parses the VTT into timestamped lines, groups them into
// short (≤2-sentence) shadowing segments, and writes data/transcripts.json. That JSON is
// committed to git and is the only thing the static site loads at runtime — the
// deployed app never calls yt-dlp or YouTube's caption endpoints.
//
//   npm run build:transcripts
//
// Requires yt-dlp on PATH.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Segment tuning: each shadowing segment is at most SENTENCES_PER_SEG full
// sentences, so the caption stays fixed (and short) while the segment loops.
// MAX_SEG_SECONDS is a safety cap so one long rambling sentence can't turn a
// segment into a very long loop.
const SENTENCES_PER_SEG = 2;
const MAX_SEG_SECONDS = 20;

function log(...args) {
  console.log("[transcripts]", ...args);
}

function ytdlp(args) {
  return execFileSync("yt-dlp", ["--no-warnings", "--no-update", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function fetchTitle(url) {
  try {
    return ytdlp(["--skip-download", "--print", "%(title)s", url]).trim();
  } catch {
    return null;
  }
}

// Download English captions (prefer manual, fall back to auto) into a temp dir
// and return the .vtt path, or null if the video has no English captions.
function downloadVtt(id, url) {
  const dir = mkdtempSync(join(tmpdir(), `vtt-${id}-`));
  try {
    ytdlp([
      "--skip-download",
      "--write-subs",
      "--write-auto-subs",
      "--sub-langs", "en",
      "--sub-format", "vtt",
      "-o", join(dir, "%(id)s.%(ext)s"),
      url,
    ]);
  } catch (error) {
    log(`  ! yt-dlp failed for ${id}: ${error.message.split("\n")[0]}`);
  }
  const path = join(dir, `${id}.en.vtt`);
  return existsSync(path) ? { path, dir } : (rmSync(dir, { recursive: true, force: true }), null);
}

function timeToSeconds(stamp) {
  const [hms, ms = "0"] = stamp.split(".");
  const parts = hms.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [h, m, s] = parts;
  return h * 3600 + m * 60 + s + Number(`0.${ms}`);
}

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

function cleanText(raw) {
  return raw
    .replace(/<[^>]+>/g, "")                       // inline timing / styling tags
    .replace(/&#39;|&amp;|&lt;|&gt;|&quot;|&nbsp;/g, (m) => ENTITIES[m])
    .replace(/\s+/g, " ")
    .trim();
}

// Drop non-spoken lines: sound annotations like "(Laughter)" / "[Music]" and
// TED-style caption credits like "Transcriber: … Reviewer: …".
function isNonSpeech(text) {
  return /^[\(\[][^)\]]*[\)\]]$/.test(text) || /^(Transcriber|Reviewer|Translator)\s*:/i.test(text);
}

function endsSentence(text) {
  return /[.!?]["')\]]?$/.test(text);
}

const WORD_TAG = /<(\d{2}:\d{2}:\d{2}\.\d{3})><c>(.*?)<\/c>/g;

// Dispatch on caption format. YouTube auto-captions (ASR) carry per-word inline
// timestamps (`<00:00:01.000><c> word</c>`) and roll in a 2-line window, which
// the clean-cue parser can't dedupe; they need word-level reconstruction.
function parseVtt(vtt) {
  return /<\d{2}:\d{2}:\d{2}\.\d{3}><c>/.test(vtt) ? parseAutoVtt(vtt) : parseCleanVtt(vtt);
}

// Manual / clean captions: each cue is a finished line, no inline word timing.
function parseCleanVtt(vtt) {
  const blocks = vtt.replace(/\r/g, "").split("\n\n");
  const lines = [];

  for (const block of blocks) {
    const rows = block.split("\n");
    const timing = rows.find((row) => row.includes("-->"));
    if (!timing) continue;
    const match = timing.match(/(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})/);
    if (!match) continue;

    const start = timeToSeconds(match[1]);
    const end = timeToSeconds(match[2]);
    const text = cleanText(rows.slice(rows.indexOf(timing) + 1).join(" "));
    if (!text || isNonSpeech(text)) continue;

    const prev = lines[lines.length - 1];
    if (prev) {
      if (prev.text === text) { prev.end = end; continue; }       // exact repeat (auto-sub roll)
      if (text.startsWith(prev.text)) {                            // rolling partial → upgrade
        prev.text = text;
        prev.end = end;
        continue;
      }
    }
    lines.push({ text, start, end });
  }

  return lines;
}

// Auto-captions: pull the per-word timestamps out of the `<c>` tags. In each
// cue only the line carrying word tags is new content (the other is carried
// over from the previous cue), so concatenating those rebuilds a clean,
// duplicate-free word stream, which we then regroup into readable lines.
function parseAutoVtt(vtt) {
  const blocks = vtt.replace(/\r/g, "").split("\n\n");
  const words = [];

  for (const block of blocks) {
    const rows = block.split("\n");
    const timing = rows.find((row) => row.includes("-->"));
    if (!timing) continue;
    const tagged = rows.find((row) => row.includes("<c>"));
    if (!tagged) continue;

    const cueStart = timeToSeconds(timing.match(/(\d{2}:\d{2}:\d{2}\.\d{3})/)[1]);
    const lead = cleanText(tagged.split("<")[0]);     // first word(s) before the first tag
    if (lead) words.push({ text: lead, start: cueStart });

    for (const m of tagged.matchAll(WORD_TAG)) {
      const text = cleanText(m[2]);
      if (text) words.push({ text, start: timeToSeconds(m[1]) });
    }
  }

  return wordsToLines(words);
}

// Turn a timestamped word stream into lines, breaking at sentence ends (or a
// max length), and dropping speaker markers (`>>`) and brackets (`[laughter]`).
function wordsToLines(words) {
  const tokens = [];
  for (const { text, start } of words) {
    for (const piece of text.split(/\s+/)) {
      const word = piece.replace(/^>+/, "").trim();
      if (!word || /^\[[^\]]*\]$/.test(word)) continue;
      tokens.push({ word, start });
    }
  }

  const lines = [];
  let current = [];
  let lineStart = 0;

  for (const token of tokens) {
    if (!current.length) lineStart = token.start;
    current.push(token.word);
    if (endsSentence(token.word) || current.length >= 12) {
      lines.push({ text: current.join(" "), start: lineStart, end: token.start });
      current = [];
    }
  }
  if (current.length) {
    lines.push({ text: current.join(" "), start: lineStart, end: tokens[tokens.length - 1].start });
  }

  // A line's real end is where the next line begins.
  for (let i = 0; i < lines.length - 1; i += 1) lines[i].end = lines[i + 1].start;
  return lines;
}

// Caption cues don't line up with sentences (a sentence can span several cues,
// e.g. "I think the most important thing" + "is to keep going."). Merge cues
// until one ends a sentence so each unit is one whole sentence.
function mergeIntoSentences(lines) {
  const sentences = [];
  let buf = null;
  for (const line of lines) {
    if (!buf) buf = { text: line.text, start: line.start, end: line.end };
    else { buf.text += " " + line.text; buf.end = line.end; }
    // End at sentence punctuation, or force a break once a punctuation-less run
    // (common in auto-captions) has gone past the segment cap.
    if (endsSentence(line.text) || buf.end - buf.start > MAX_SEG_SECONDS) {
      sentences.push(buf);
      buf = null;
    }
  }
  if (buf) sentences.push(buf);
  return sentences;
}

// Group sentences into segments of at most SENTENCES_PER_SEG, breaking early if
// adding another sentence would push the segment past MAX_SEG_SECONDS.
function segmentLines(lines) {
  const sentences = mergeIntoSentences(lines);
  const segments = [];
  let current = [];

  const flush = () => {
    if (!current.length) return;
    segments.push({
      start: current[0].start,
      end: current[current.length - 1].end,
      lines: current,
    });
    current = [];
  };

  for (const sentence of sentences) {
    if (current.length && sentence.end - current[0].start > MAX_SEG_SECONDS) flush();
    current.push(sentence);
    if (current.length >= SENTENCES_PER_SEG) flush();
  }
  flush();

  return segments.map((seg) => ({
    start: round(seg.start),
    end: round(seg.end),
    lines: seg.lines.map((l) => ({ text: l.text, start: round(l.start), end: round(l.end) })),
  }));
}

function round(n) {
  return Math.round(n * 100) / 100;
}

// Optional, hand-authored (by the youtube-curator skill): Korean glosses for the
// hard words/idioms in each segment. Keyed by video id then segment index:
//   { "VIDEOID": { "3": [{ "term": "pull it off", "ko": "해내다", "type": "idiom" }] } }
// Lives in its own committed file so a rebuild doesn't wipe it; merged onto each
// segment as `segment.glossary` below.
function loadGlossary() {
  const path = join(root, "data", "glossary.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    log(`! could not parse data/glossary.json, ignoring: ${error.message}`);
    return {};
  }
}

// Attach (or refresh) the hand-authored Korean glosses on a built video's
// segments, keyed by segment index. Clears any stale glossary first so removing
// an entry from glossary.json removes it from the output too.
function attachGlossary(video, glossForVideo = {}) {
  video.segments.forEach((seg, i) => {
    const entries = glossForVideo[String(i)];
    if (Array.isArray(entries) && entries.length) seg.glossary = entries;
    else delete seg.glossary;
  });
}

// Cheap path for iterating on glossary.json: re-apply glosses to the already
// built data/transcripts.json without re-downloading any captions.
function mergeGlossaryOnly(glossary) {
  const dataPath = join(root, "data", "transcripts.json");
  if (!existsSync(dataPath)) {
    log("! no data/transcripts.json yet — run a full build first");
    return;
  }
  const out = JSON.parse(readFileSync(dataPath, "utf8"));
  for (const video of out.videos) attachGlossary(video, glossary[video.id] || {});
  writeFileSync(dataPath, JSON.stringify(out, null, 2) + "\n");
  log(`merged glossary into ${dataPath} (${out.videos.length} videos, no re-download)`);
}

function main() {
  const glossary = loadGlossary();
  if (process.argv.includes("--glossary-only")) return mergeGlossaryOnly(glossary);

  const config = JSON.parse(readFileSync(join(root, "videos.json"), "utf8"));
  const out = { generatedAt: new Date().toISOString(), videos: [] };

  for (const video of config.videos) {
    const id = video.id;
    const url = `https://www.youtube.com/watch?v=${id}`;
    log(`processing ${id}…`);

    const vtt = downloadVtt(id, url);
    if (!vtt) {
      log(`  ! no English captions for ${id}, skipping`);
      continue;
    }

    const lines = parseVtt(readFileSync(vtt.path, "utf8"));
    rmSync(vtt.dir, { recursive: true, force: true });
    const segments = segmentLines(lines);

    if (!segments.length) {
      log(`  ! parsed 0 segments for ${id}, skipping`);
      continue;
    }

    const built = {
      id,
      url,
      title: video.title || fetchTitle(url) || id,
      tag: video.tag || video.title || id,
      category: video.category || "기타",
      segments,
    };
    attachGlossary(built, glossary[id] || {}); // merge any hand-authored Korean glosses
    out.videos.push(built);
    log(`  ✓ ${segments.length} segments, ${lines.length} lines`);
  }

  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const dataPath = join(dataDir, "transcripts.json");
  writeFileSync(dataPath, JSON.stringify(out, null, 2) + "\n");
  log(`wrote ${dataPath} (${out.videos.length} videos)`);
}

main();
