import { fnv1a } from "./hash";
import {
  CAPTION_STYLES,
  DEFAULT_CLIP_SEC,
  defaultCaption,
  FPS,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  lookById,
  MAX_CLIP_SEC,
  MAX_FRAMES,
  MAX_SEGMENT_SEC,
  MIN_SEGMENT_SEC,
  renderPrompt,
  TRANSITIONS,
  type Transition,
} from "./looks";

export interface CutlistInput {
  clipStart: number;
  clipEnd: number;
  /** Absolute times in seconds. */
  drops: number[];
  /** Absolute beat times in seconds. */
  beats: number[];
  photoCount: number;
  lookIds: string[];
  transition: Transition;
  captionStyle: string;
  /** Base seed. Segment seeds are derived from this. */
  seed: number;
  bpm: number;
}

export interface CutSegment {
  id: string;
  index: number;
  start: number;
  end: number;
  duration: number;
  frames: number;
  photoIndex: number;
  look: string;
  transition: Transition;
  captionStyle: string;
  captionCue: "DROP" | "HOLD";
  caption: string;
  seed: number;
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  fps: number;
}

export interface Cutlist {
  version: 1;
  fps: number;
  maxFrames: number;
  width: number;
  height: number;
  bpm: number;
  clipStart: number;
  clipEnd: number;
  seed: number;
  captionStyle: string;
  transition: Transition;
  photoCount: number;
  lookIds: string[];
  segments: CutSegment[];
}

export function segmentSeed(base: number, index: number, look: string, photoIndex: number): number {
  return fnv1a(`${base}|${index}|${look}|${photoIndex}`);
}

function finite(n: number, label: string): number {
  if (!Number.isFinite(n)) throw new Error(`${label} must be a finite number.`);
  return n;
}

/**
 * Cut points: clip edges, drops, and bar lines (every 4 beats).
 * Points closer than MIN_SEGMENT_SEC collapse. Spans longer than the frame cap split evenly.
 * No randomness — the same input object always yields the same points.
 */
export function buildCutPoints(input: Pick<CutlistInput, "clipStart" | "clipEnd" | "drops" | "beats">): number[] {
  const clipStart = finite(input.clipStart, "clipStart");
  const clipEnd = finite(input.clipEnd, "clipEnd");
  if (clipEnd - clipStart <= 0.05) {
    throw new Error("Clip window is too short.");
  }

  const edge = 0.05;
  const primary: number[] = [clipStart, clipEnd];
  for (const drop of input.drops) {
    if (!Number.isFinite(drop)) continue;
    if (drop > clipStart + edge && drop < clipEnd - edge) primary.push(drop);
  }

  const beats = input.beats.filter((b) => Number.isFinite(b)).sort((a, b) => a - b);
  const secondary: number[] = [];
  for (let i = 0; i < beats.length; i += 4) {
    const t = beats[i]!;
    if (t > clipStart + edge && t < clipEnd - edge) secondary.push(t);
  }

  const merged = mergeTimes(primary, secondary, 0.12);
  const spaced = enforceMinGap(merged, MIN_SEGMENT_SEC);
  return splitLong(spaced, MAX_SEGMENT_SEC);
}

function mergeTimes(primary: number[], secondary: number[], eps: number): number[] {
  const kept = uniqueSorted(primary, eps);
  for (const t of secondary) {
    if (kept.every((p) => Math.abs(p - t) > eps)) kept.push(t);
  }
  kept.sort((a, b) => a - b);
  return kept;
}

function uniqueSorted(times: number[], eps: number): number[] {
  const sorted = [...times].sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of sorted) {
    if (out.length === 0 || t - out[out.length - 1]! > eps) out.push(t);
  }
  return out;
}

function enforceMinGap(points: number[], min: number): number[] {
  if (points.length <= 2) return points;
  const start = points[0]!;
  const end = points[points.length - 1]!;
  const kept: number[] = [start];
  for (let i = 1; i < points.length - 1; i++) {
    const t = points[i]!;
    if (t - kept[kept.length - 1]! >= min && end - t >= min) kept.push(t);
  }
  kept.push(end);
  return kept;
}

function splitLong(points: number[], maxDur: number): number[] {
  if (points.length < 2) return points;
  const out: number[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    out.push(a);
    const dur = b - a;
    if (dur > maxDur) {
      const n = Math.ceil(dur / maxDur - 1e-12);
      for (let k = 1; k < n; k++) out.push(a + (dur * k) / n);
    }
  }
  out.push(points[points.length - 1]!);
  return out;
}

export function framesFor(duration: number): number {
  const frames = Math.round(duration * FPS);
  return Math.max(1, Math.min(MAX_FRAMES, frames));
}

function isTransition(value: string): value is Transition {
  return TRANSITIONS.some((item) => item.id === value);
}

export function buildCutlist(input: CutlistInput): Cutlist {
  const clipStart = finite(input.clipStart, "clipStart");
  const clipEnd = finite(input.clipEnd, "clipEnd");
  const span = clipEnd - clipStart;
  if (span > MAX_CLIP_SEC + 0.001) {
    throw new Error(`Clip window must be ${MAX_CLIP_SEC} seconds or less.`);
  }
  if (!Number.isInteger(input.photoCount) || input.photoCount < 1 || input.photoCount > 3) {
    throw new Error("Photo count must be 1, 2, or 3.");
  }
  if (!Array.isArray(input.lookIds) || input.lookIds.length === 0) {
    throw new Error("Pick at least one look.");
  }
  for (const id of input.lookIds) {
    if (!lookById(id)) throw new Error(`Unknown look: ${id}`);
  }
  if (!isTransition(input.transition)) throw new Error("Unknown transition.");
  if (!CAPTION_STYLES.some((style) => style.id === input.captionStyle)) {
    throw new Error("Unknown caption style.");
  }
  const seed = finite(input.seed, "seed");
  if (!Number.isFinite(input.bpm) || input.bpm < 0) throw new Error("BPM must be a number.");

  const points = buildCutPoints(input);
  const dropTimes = input.drops.filter((d) => Number.isFinite(d));
  const segments: CutSegment[] = [];

  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i]!;
    const end = points[i + 1]!;
    const duration = end - start;
    const look = input.lookIds[i % input.lookIds.length]!;
    const photoIndex = i % input.photoCount;
    const segSeed = segmentSeed(Math.round(seed), i, look, photoIndex);
    const nearDrop = dropTimes.some((d) => Math.abs(d - start) <= 0.12);
    const captionCue: "DROP" | "HOLD" = nearDrop ? "DROP" : "HOLD";
    const prompt = renderPrompt(look);
    segments.push({
      id: `s${String(i).padStart(2, "0")}`,
      index: i,
      start,
      end,
      duration,
      frames: framesFor(duration),
      photoIndex,
      look,
      transition: input.transition,
      captionStyle: input.captionStyle,
      captionCue,
      caption: defaultCaption(captionCue, segSeed),
      seed: segSeed,
      prompt: prompt.positive,
      negativePrompt: prompt.negative,
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
      fps: FPS,
    });
  }

  return {
    version: 1,
    fps: FPS,
    maxFrames: MAX_FRAMES,
    width: FRAME_WIDTH,
    height: FRAME_HEIGHT,
    bpm: input.bpm,
    clipStart,
    clipEnd,
    seed,
    captionStyle: input.captionStyle,
    transition: input.transition,
    photoCount: input.photoCount,
    lookIds: [...input.lookIds],
    segments,
  };
}

export function defaultWindow(duration: number): { start: number; end: number } {
  const safe = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  const end = Math.min(safe, DEFAULT_CLIP_SEC);
  return { start: 0, end: end > 0.05 ? end : safe };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCutlist(value: unknown): Cutlist {
  if (!isRecord(value)) throw new Error("Cut list must be an object.");
  if (value.version !== 1) throw new Error("Unsupported cut list version.");
  const segmentsRaw = value.segments;
  if (!Array.isArray(segmentsRaw) || segmentsRaw.length === 0 || segmentsRaw.length > 64) {
    throw new Error("Cut list needs between 1 and 64 segments.");
  }
  const photoCount = value.photoCount;
  if (photoCount !== 1 && photoCount !== 2 && photoCount !== 3) {
    throw new Error("Photo count must be 1, 2, or 3.");
  }
  const clipStart = value.clipStart;
  const clipEnd = value.clipEnd;
  if (typeof clipStart !== "number" || typeof clipEnd !== "number" || !(clipEnd > clipStart)) {
    throw new Error("Clip window is invalid.");
  }
  if (clipEnd - clipStart > MAX_CLIP_SEC + 0.05) {
    throw new Error(`Clip window must be ${MAX_CLIP_SEC} seconds or less.`);
  }
  if (typeof value.seed !== "number" || !Number.isFinite(value.seed)) throw new Error("Seed is invalid.");
  if (typeof value.bpm !== "number" || !Number.isFinite(value.bpm)) throw new Error("BPM is invalid.");
  if (typeof value.captionStyle !== "string") throw new Error("Caption style is invalid.");
  if (typeof value.transition !== "string" || !isTransition(value.transition)) {
    throw new Error("Transition is invalid.");
  }
  if (!Array.isArray(value.lookIds) || value.lookIds.some((id) => typeof id !== "string")) {
    throw new Error("Looks are invalid.");
  }

  const segments: CutSegment[] = segmentsRaw.map((raw, index) => parseSegment(raw, index, photoCount));
  if (Math.abs(segments[0]!.start - clipStart) > 1e-3) {
    throw new Error("First segment must start at the clip in-point.");
  }
  const last = segments[segments.length - 1]!;
  if (Math.abs(last.end - clipEnd) > 1e-3) {
    throw new Error("Last segment must end at the clip out-point.");
  }
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (i > 0 && Math.abs(seg.start - segments[i - 1]!.end) > 1e-6) {
      throw new Error("Segments must meet with no gaps or overlaps.");
    }
    if (!(seg.duration > 0) || seg.duration > MAX_SEGMENT_SEC + 1e-6) {
      throw new Error("A segment is longer than the frame cap.");
    }
    if (seg.frames > MAX_FRAMES || seg.frames < 1) {
      throw new Error("Frame count is outside the cap.");
    }
  }

  return {
    version: 1,
    fps: FPS,
    maxFrames: MAX_FRAMES,
    width: FRAME_WIDTH,
    height: FRAME_HEIGHT,
    bpm: value.bpm,
    clipStart,
    clipEnd,
    seed: value.seed,
    captionStyle: value.captionStyle,
    transition: value.transition,
    photoCount,
    lookIds: value.lookIds as string[],
    segments,
  };
}

function parseSegment(raw: unknown, index: number, photoCount: number): CutSegment {
  if (!isRecord(raw)) throw new Error(`Segment ${index} is invalid.`);
  const num = (key: string): number => {
    const value = raw[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`Segment ${index} field ${key} is invalid.`);
    }
    return value;
  };
  const start = num("start");
  const end = num("end");
  const duration = num("duration");
  if (Math.abs(duration - (end - start)) > 1e-4) {
    throw new Error(`Segment ${index} duration does not match its span.`);
  }
  const frames = num("frames");
  if (!Number.isInteger(frames)) throw new Error(`Segment ${index} frames must be an integer.`);
  const photoIndex = num("photoIndex");
  if (!Number.isInteger(photoIndex) || photoIndex < 0 || photoIndex >= photoCount) {
    throw new Error(`Segment ${index} photo is out of range.`);
  }
  const look = raw.look;
  if (typeof look !== "string" || !lookById(look)) throw new Error(`Segment ${index} look is unknown.`);
  const transition = raw.transition;
  if (typeof transition !== "string" || !isTransition(transition)) {
    throw new Error(`Segment ${index} transition is unknown.`);
  }
  const captionStyle = raw.captionStyle;
  if (typeof captionStyle !== "string" || captionStyle.length > 32) {
    throw new Error(`Segment ${index} caption style is invalid.`);
  }
  const captionCue = raw.captionCue;
  if (captionCue !== "DROP" && captionCue !== "HOLD") {
    throw new Error(`Segment ${index} cue is invalid.`);
  }
  const caption = raw.caption;
  if (typeof caption !== "string" || caption.length > 80) {
    throw new Error(`Segment ${index} caption is invalid.`);
  }
  const prompt = raw.prompt;
  const negativePrompt = raw.negativePrompt;
  if (typeof prompt !== "string" || prompt.length < 1 || prompt.length > 2000) {
    throw new Error(`Segment ${index} prompt is invalid.`);
  }
  if (typeof negativePrompt !== "string" || negativePrompt.length > 2000) {
    throw new Error(`Segment ${index} negative prompt is invalid.`);
  }
  const id = raw.id;
  if (typeof id !== "string" || !/^s\d{2,4}$/.test(id)) {
    throw new Error(`Segment ${index} id is invalid.`);
  }
  const seed = num("seed");
  return {
    id,
    index,
    start,
    end,
    duration,
    frames,
    photoIndex,
    look,
    transition,
    captionStyle,
    captionCue,
    caption,
    seed,
    prompt,
    negativePrompt,
    width: FRAME_WIDTH,
    height: FRAME_HEIGHT,
    fps: FPS,
  };
}
