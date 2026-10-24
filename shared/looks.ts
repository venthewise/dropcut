export const FPS = 24;
/** LTX-style clip cap. 97 frames at 24 fps is just over 4 seconds. */
export const MAX_FRAMES = 97;
export const MAX_SEGMENT_SEC = MAX_FRAMES / FPS;
/** Short gaps collapse so a dense drop grid cannot spawn sub-frame clips. */
export const MIN_SEGMENT_SEC = 0.35;
export const MAX_CLIP_SEC = 30;
export const DEFAULT_CLIP_SEC = 15;

export const FRAME_WIDTH = 768;
export const FRAME_HEIGHT = 1344;

export type Transition = "hard" | "flash" | "whip";

export const TRANSITIONS: { id: Transition; label: string; note: string }[] = [
  { id: "hard", label: "Hard cut", note: "Instant change on the drop." },
  { id: "flash", label: "Flash", note: "One acid frame. Capped at 3 per second." },
  { id: "whip", label: "Whip", note: "A fast slide into the next plate." },
];

export interface CaptionStyle {
  id: string;
  label: string;
  note: string;
}

export const CAPTION_STYLES: CaptionStyle[] = [
  { id: "block", label: "Block", note: "Full-width bar, bottom of frame." },
  { id: "stamp", label: "Stamp", note: "Tight label, upper left." },
  { id: "lower", label: "Lower third", note: "Left-aligned editorial line." },
  { id: "kick", label: "Kick lock", note: "Centered word that hits on the beat." },
];

export interface Look {
  id: string;
  label: string;
  plate: string;
  /** Positive prompt. `{shot}` is replaced with the still description. */
  positive: string;
  negative: string;
  bg: string;
  fg: string;
  accent: string;
}

const SHOT =
  "the subject of the reference still, same framing, vertical 9:16, no readable text, no logo, no watermark";

export const LOOKS: Look[] = [
  {
    id: "neon",
    label: "Neon",
    plate: "NEON",
    positive: `Acid neon rim light, hard graphic shadows, night exterior, ${SHOT}. High contrast, graphic, photographic.`,
    negative: "blurry, watermark, text, logo, extra limbs, deformed, low detail",
    bg: "#0a0a0a",
    fg: "#d1fe17",
    accent: "#f4f1ea",
  },
  {
    id: "film",
    label: "Film grain",
    plate: "FILM",
    positive: `16mm film grain, warm tungsten, soft halation, slight gate weave, ${SHOT}.`,
    negative: "digital smear, watermark, text, logo, plastic skin, oversharpened",
    bg: "#1a120c",
    fg: "#f4f1ea",
    accent: "#c4a574",
  },
  {
    id: "ink",
    label: "Anime ink",
    plate: "INK",
    positive: `Bold ink contours, flat cel color, paper white gaps, ${SHOT}. Graphic animation frame.`,
    negative: "photorealistic pores, watermark, text, logo, muddy color, 3d render",
    bg: "#0a0a0a",
    fg: "#f4f1ea",
    accent: "#f4f1ea",
  },
  {
    id: "glitch",
    label: "Glitch",
    plate: "GLITCH",
    positive: `Datamosh slices, RGB offset, scanline tear, one frozen glitch, ${SHOT}.`,
    negative: "clean commercial, watermark, text, logo, soft focus, pastel",
    bg: "#120814",
    fg: "#d1fe17",
    accent: "#ff3b8d",
  },
  {
    id: "xerox",
    label: "Mono xerox",
    plate: "XEROX",
    positive: `Black and white photocopier, crushed blacks, dust, threshold poster, ${SHOT}.`,
    negative: "color, watermark, text, logo, soft gradient, glossy",
    bg: "#f4f1ea",
    fg: "#0a0a0a",
    accent: "#0a0a0a",
  },
  {
    id: "chrome",
    label: "Chrome",
    plate: "CHROME",
    positive: `Liquid chrome and brushed metal highlights, hard studio light, ${SHOT}.`,
    negative: "rust, watermark, text, logo, muddy, matte plastic",
    bg: "#8d929a",
    fg: "#0a0a0a",
    accent: "#ffffff",
  },
];

export function lookById(id: string): Look | undefined {
  return LOOKS.find((look) => look.id === id);
}

export function renderPrompt(lookId: string): { positive: string; negative: string } {
  const look = lookById(lookId);
  if (!look) {
    throw new Error(`Unknown look: ${lookId}`);
  }
  return { positive: look.positive, negative: look.negative };
}

const CAPTION_WORDS = ["WAIT", "HOLD", "LOCK", "STAY", "HIT", "CUT", "MARK", "GO", "STILL", "NOW"];

export function defaultCaption(cue: "DROP" | "HOLD", seed: number): string {
  if (cue === "DROP") return "DROP";
  return CAPTION_WORDS[seed % CAPTION_WORDS.length] ?? "HOLD";
}
