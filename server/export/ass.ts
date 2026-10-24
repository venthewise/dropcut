import path from "node:path";

/**
 * Burned-in captions follow the Cut Sheet player (Archivo Black, uppercase,
 * block / stamp / lower / kick). Coordinates are 1080×1920 pixels.
 *
 * Safe area: keep glyphs out of the top 250px and bottom 420px platform UI
 * and inside 90px side margins. Bottom-aligned styles use MarginV >= 420 so
 * the text sits on the safe edge and grows upward. Top-aligned styles use
 * MarginV >= 250. The end card is centered, which is inside that rect.
 *
 * The font file is Archivo Black (SIL OFL). The license is
 * server/export/ArchivoBlack-OFL.txt. Only font files live in the fonts
 * directory — libass tries to load every file there.
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
}

/** ASS colours are &HAABBGGRR. Acid #d1fe17 → &H0017FED1. */
const ACID = "&H0017FED1";
const BLACK = "&H00000000";
const WHITE = "&H00FFFFFF";

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

function styleLine(style: AssStyle): string {
  const fields = [
    style.name,
    CAPTION_FONT,
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
    0,
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
    events.push(
      `Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},${style},,0,0,0,,${escapeAssText(text.toUpperCase())}`,
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
