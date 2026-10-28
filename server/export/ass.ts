import path from "node:path";
import { splitPromoCaption } from "../../shared/looks";

/**
 * Burned-in captions follow the Cut Sheet player. Coordinates are 1080×1920.
 *
 * Block, stamp, lower, and kick use Archivo Black. Promo uses Anton, a heavy
 * condensed display face, on a tilted orange badge. Captions are uppercased.
 *
 * Safe area: keep glyphs out of the top 250px and bottom 420px platform UI
 * and inside 90px side margins. Bottom-aligned styles use MarginV >= 420 so
 * the text sits on the safe edge and grows upward. Top-aligned styles use
 * MarginV >= 250. The end card is centered, which is inside that rect.
 *
 * Font files live in server/export/fonts. ffmpeg passes that directory as
 * the ass filter fontsdir. Licenses: server/export/ArchivoBlack-OFL.txt and
 * server/export/Anton-OFL.txt (both SIL OFL). Only font files belong in the
 * fonts directory — libass tries to load every file there.
 */

export const EXPORT_WIDTH = 1080;
export const EXPORT_HEIGHT = 1920;
export const SAFE_MARGIN_X = 90;
export const SAFE_MARGIN_TOP = 250;
export const SAFE_MARGIN_BOTTOM = 420;
export const CAPTION_FONT = "Archivo Black";

export interface AssCaption {
  start: number;
  end: number;
  caption: string;
  captionStyle: string;
}

export interface AssEndCard {
  url: string;
  start: number;
  end: number;
}

interface AssStyle {
  name: string;
  id: string;
  fontSize: number;
  primary: string;
  back: string;
  outlineColour: string;
  borderStyle: number;
  outline: number;
  alignment: number;
  marginL: number;
  marginR: number;
  marginV: number;
  /** Family name libass matches. Defaults to Archivo Black. */
  fontName?: string;
  /** Degrees. Defaults to 0 so the other styles stay upright. */
  angle?: number;
}

/** ASS colours are &HAABBGGRR. Acid #d1fe17 → &H0017FED1. Sale orange #ff4500 → &H000045FF. */
const ACID = "&H0017FED1";
const BLACK = "&H00000000";
const WHITE = "&H00FFFFFF";
const PROMO_ORANGE = "&H000045FF";

export const ASS_STYLES: AssStyle[] = [
  {
    name: "Block",
    id: "block",
    fontSize: 64,
    primary: BLACK,
    back: WHITE,
    // BorderStyle 3 paints the opaque box with OutlineColour, not BackColour.
    outlineColour: WHITE,
    borderStyle: 3,
    outline: 18,
    alignment: 2,
    marginL: SAFE_MARGIN_X,
    marginR: SAFE_MARGIN_X,
    marginV: SAFE_MARGIN_BOTTOM,
  },
  {
    name: "Stamp",
    id: "stamp",
    fontSize: 48,
    primary: BLACK,
    back: ACID,
    // BorderStyle 3 paints the opaque box with OutlineColour, not BackColour.
    outlineColour: ACID,
    borderStyle: 3,
    outline: 14,
    alignment: 7,
    marginL: SAFE_MARGIN_X,
    marginR: SAFE_MARGIN_X,
    marginV: SAFE_MARGIN_TOP,
  },
  {
    name: "Lower",
    id: "lower",
    fontSize: 52,
    primary: BLACK,
    back: WHITE,
    // BorderStyle 3 paints the opaque box with OutlineColour, not BackColour.
    outlineColour: WHITE,
    borderStyle: 3,
    outline: 14,
    alignment: 1,
    marginL: SAFE_MARGIN_X,
    marginR: 240,
    marginV: SAFE_MARGIN_BOTTOM,
  },
  {
    name: "Kick",
    id: "kick",
    fontSize: 108,
    primary: WHITE,
    back: ACID,
    outlineColour: BLACK,
    borderStyle: 1,
    outline: 8,
    alignment: 2,
    marginL: SAFE_MARGIN_X,
    marginR: SAFE_MARGIN_X,
    marginV: 460,
  },
  {
    name: "Promo",
    id: "promo",
    fontName: "Anton",
    fontSize: 168,
    primary: WHITE,
    back: PROMO_ORANGE,
    // BorderStyle 3 paints the opaque box with OutlineColour, not BackColour.
    outlineColour: PROMO_ORANGE,
    borderStyle: 3,
    outline: 18,
    alignment: 2,
    marginL: SAFE_MARGIN_X,
    marginR: SAFE_MARGIN_X,
    marginV: 760,
    angle: -6,
  },
  {
    name: "EndCard",
    id: "endcard",
    fontSize: 54,
    primary: ACID,
    back: BLACK,
    outlineColour: "&H000A0A0A",
    borderStyle: 1,
    outline: 6,
    alignment: 5,
    marginL: SAFE_MARGIN_X,
    marginR: SAFE_MARGIN_X,
    marginV: SAFE_MARGIN_TOP,
  },
];

const STYLE_BY_ID = new Map(ASS_STYLES.map((style) => [style.id, style.name]));

export function captionFontsDir(cwd = process.cwd()): string {
  return path.resolve(cwd, "server/export/fonts");
}

/** Escape dialogue text. Newlines become ASS `\N`. Override braces cannot leak in. */
export function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\r\n|\r|\n/g, "\\N");
}

/** Centiseconds. libass reads H:MM:SS.cc. */
export function formatAssTime(seconds: number): string {
  const csTotal = Math.max(0, Math.round(seconds * 100));
  const cs = csTotal % 100;
  const total = Math.floor(csTotal / 100);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

export function wrapUrl(url: string, columns = 28): string {
  const clean = url.trim();
  if (clean.length <= columns) return clean;
  const parts: string[] = [];
  for (let i = 0; i < clean.length; i += columns) parts.push(clean.slice(i, i + columns));
  return parts.join("\n");
}

/**
 * Anton hmtx advances in font units (unitsPerEm 2048). The bundled ffmpeg
 * libass scales this face by the OS/2 win cell, usWinAscent + usWinDescent
 * (2876 + 674), not by the em square. Widths use that divisor so a long word
 * shrinks before it crosses the safe area.
 */
const ANTON_WIN_CELL = 2876 + 674;
const ANTON_ADVANCE: Record<string, number> = {
  " ": 480,
  A: 994, B: 980, C: 971, D: 1010, E: 843, F: 817, G: 993, H: 1022, I: 464,
  J: 955, K: 967, L: 814, M: 1528, N: 1020, O: 996, P: 967, Q: 1011, R: 976,
  S: 945, T: 810, U: 970, V: 961, W: 1458, X: 991, Y: 914, Z: 840,
  "0": 1012, "1": 677, "2": 1012, "3": 1012, "4": 1012, "5": 1012, "6": 1012,
  "7": 1012, "8": 1012, "9": 1012,
  $: 946, "+": 728, ".": 468, ",": 484, "!": 469, "?": 1008, ":": 495, ";": 502,
  "'": 438, "\"": 878, "/": 830, "&": 1065, "(": 596, ")": 596, "-": 637,
  "@": 1770, "#": 1119, "%": 2164, "*": 926, _: 748, "=": 637,
};
/** Missing glyphs use the widest measured advance so the line shrinks instead of clipping. */
const ANTON_FALLBACK = 2164;
const PROMO_HEAD_MAX = 168;
const PROMO_SIZE_FLOOR = 8;
const PROMO_SUB_RATIO = 0.5;
const PROMO_LINES = 2;
/**
 * Inner text width that still fits the 90px side margins after box padding
 * and a 6 degree tilt, including a two-line badge. Settled scale is 100%.
 */
const PROMO_MAX_TEXT = 740;
/** Scale 52% → 118% → 100%. Times are milliseconds from the cue, so the pop is fixed. */
const PROMO_POP = "\\fscx52\\fscy52\\t(0,110,\\fscx118\\fscy118)\\t(110,200,\\fscx100\\fscy100)";

function antonWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const ch of text) units += ANTON_ADVANCE[ch] ?? ANTON_FALLBACK;
  return (units * fontSize) / ANTON_WIN_CELL;
}

function wrapPromo(text: string, fontSize: number, maxLines: number): string[] | null {
  const words = text.split(" ").filter((word) => word.length > 0);
  if (words.length === 0) return [];
  for (const word of words) {
    if (antonWidth(word, fontSize) > PROMO_MAX_TEXT) return null;
  }
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (antonWidth(next, fontSize) <= PROMO_MAX_TEXT) {
      current = next;
      continue;
    }
    lines.push(current);
    current = word;
    if (lines.length >= maxLines) return null;
  }
  if (current) lines.push(current);
  return lines.length <= maxLines ? lines : null;
}

function breakPromo(text: string, fontSize: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const ch of text) {
    const next = current + ch;
    if (current && antonWidth(next, fontSize) > PROMO_MAX_TEXT) {
      lines.push(current);
      current = ch;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [text];
}

function fitPromo(text: string, startSize: number): { size: number; lines: string[] } {
  for (let size = startSize; size >= PROMO_SIZE_FLOOR; size -= 2) {
    const lines = wrapPromo(text, size, PROMO_LINES);
    if (lines) return { size, lines };
  }
  return { size: PROMO_SIZE_FLOOR, lines: breakPromo(text, PROMO_SIZE_FLOOR) };
}

/** One badge. Headline is large. A second line, when present, is about half. */
function promoText(caption: string): string {
  const { head, sub } = splitPromoCaption(caption.toUpperCase());
  if (!head) return "";
  const headline = fitPromo(head, PROMO_HEAD_MAX);
  const anim = `{\\q2\\fs${headline.size}${PROMO_POP}}`;
  let body = `${anim}${headline.lines.map(escapeAssText).join("\\N")}`;
  if (sub) {
    const price = fitPromo(sub, Math.max(PROMO_SIZE_FLOOR, Math.round(headline.size * PROMO_SUB_RATIO)));
    body += `\\N{\\fs${price.size}}${price.lines.map(escapeAssText).join("\\N")}`;
  }
  return body;
}

function styleLine(style: AssStyle): string {
  const fields = [
    style.name,
    style.fontName ?? CAPTION_FONT,
    style.fontSize,
    style.primary,
    BLACK,
    style.outlineColour,
    style.back,
    0,
    0,
    0,
    0,
    100,
    100,
    0,
    style.angle ?? 0,
    style.borderStyle,
    style.outline,
    0,
    style.alignment,
    style.marginL,
    style.marginR,
    style.marginV,
    1,
  ];
  return `Style: ${fields.join(",")}`;
}

/**
 * Build a UTF-8 ASS script. Times are relative to the assembly, whose t=0 is
 * the cut list's clipStart. Captions are uppercased to match the player CSS.
 * The end card URL is not uppercased.
 */
export function buildAss(opts: {
  captions: AssCaption[];
  clipStart: number;
  endCard?: AssEndCard;
}): string {
  const events: string[] = [];
  for (const cue of opts.captions) {
    const text = cue.caption.trim();
    if (!text) continue;
    const start = cue.start - opts.clipStart;
    const end = cue.end - opts.clipStart;
    if (!(end > start)) continue;
    const style = STYLE_BY_ID.get(cue.captionStyle) ?? "Block";
    // Promo splits on " | " before trimming, so a leading break is still a break.
    const body = style === "Promo" ? promoText(cue.caption) : escapeAssText(text.toUpperCase());
    if (!body) continue;
    events.push(
      `Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},${style},,0,0,0,,${body}`,
    );
  }
  if (opts.endCard && opts.endCard.end > opts.endCard.start && opts.endCard.url.trim()) {
    const body = `DROPCUT\\N${escapeAssText(wrapUrl(opts.endCard.url))}`;
    events.push(
      `Dialogue: 0,${formatAssTime(opts.endCard.start)},${formatAssTime(opts.endCard.end)},EndCard,,0,0,0,,${body}`,
    );
  }
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${EXPORT_WIDTH}`,
    `PlayResY: ${EXPORT_HEIGHT}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...ASS_STYLES.map(styleLine),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ];
  return `\uFEFF${header.join("\n")}`;
}
