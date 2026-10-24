import { crc32, deflateSync } from "node:zlib";
import { lookById } from "../../shared/looks";

/**
 * Minimal RGB PNG writer and a renderer for the mock placeholder SVG.
 * The bundled ffmpeg has no SVG decoder. Placeholder text is not drawn here;
 * export burns the cut-list caption on top of these color blocks.
 */

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const EXPORT_W = 1080;
const EXPORT_H = 1920;

export function parseHex(color: string): [number, number, number] {
  const raw = color.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(raw)) {
    return [
      Number.parseInt(raw[0]! + raw[0]!, 16),
      Number.parseInt(raw[1]! + raw[1]!, 16),
      Number.parseInt(raw[2]! + raw[2]!, 16),
    ];
  }
  if (/^[0-9a-fA-F]{6}$/.test(raw)) {
    return [
      Number.parseInt(raw.slice(0, 2), 16),
      Number.parseInt(raw.slice(2, 4), 16),
      Number.parseInt(raw.slice(4, 6), 16),
    ];
  }
  return [10, 10, 10];
}

export function createRgb(width: number, height: number, fill: string): Uint8Array {
  const rgb = new Uint8Array(width * height * 3);
  const [r, g, b] = parseHex(fill);
  for (let i = 0; i < rgb.length; i += 3) {
    rgb[i] = r;
    rgb[i + 1] = g;
    rgb[i + 2] = b;
  }
  return rgb;
}

export function fillRect(
  rgb: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
): void {
  const [r, g, b] = parseHex(color);
  const x0 = clampInt(Math.floor(x), 0, width);
  const y0 = clampInt(Math.floor(y), 0, height);
  const x1 = clampInt(Math.ceil(x + w), 0, width);
  const y1 = clampInt(Math.ceil(y + h), 0, height);
  for (let yy = y0; yy < y1; yy++) {
    let i = (yy * width + x0) * 3;
    for (let xx = x0; xx < x1; xx++) {
      rgb[i] = r;
      rgb[i + 1] = g;
      rgb[i + 2] = b;
      i += 3;
    }
  }
}

export function fillCircle(
  rgb: Uint8Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius: number,
  color: string,
): void {
  const [r, g, b] = parseHex(color);
  const x0 = clampInt(Math.floor(cx - radius), 0, width);
  const y0 = clampInt(Math.floor(cy - radius), 0, height);
  const x1 = clampInt(Math.ceil(cx + radius), 0, width);
  const y1 = clampInt(Math.ceil(cy + radius), 0, height);
  const r2 = radius * radius;
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) {
      const dx = xx + 0.5 - cx;
      const dy = yy + 0.5 - cy;
      if (dx * dx + dy * dy > r2) continue;
      const i = (yy * width + xx) * 3;
      rgb[i] = r;
      rgb[i + 1] = g;
      rgb[i + 2] = b;
    }
  }
}

export function encodeRgbPng(width: number, height: number, rgb: Uint8Array, level = 6): Buffer {
  if (rgb.length !== width * height * 3) {
    throw new Error(`Expected ${width * height * 3} RGB bytes, got ${rgb.length}.`);
  }
  const stride = width * 3;
  const raw = Buffer.allocUnsafe((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const dest = y * (stride + 1);
    raw[dest] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride).copy(raw, dest + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    PNG_SIG,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Draw the placeholder SVG's filled and stroked rects into a PNG ffmpeg can read. */
export function rasterizeSvg(svg: string, outWidth = EXPORT_W, outHeight = EXPORT_H): Buffer {
  const box = viewBox(svg);
  const sx = outWidth / box.w;
  const sy = outHeight / box.h;
  const look = /data-look="([^"]*)"/.exec(svg)?.[1] ?? "";
  const fallback = lookById(look)?.bg ?? "#0a0a0a";
  const rgb = createRgb(outWidth, outHeight, fallback);
  const rectRe = /<rect\b([^>]*)\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = rectRe.exec(svg))) {
    const tag = attrs(match[1] ?? "");
    const x = num(tag.x) - box.x;
    const y = num(tag.y) - box.y;
    const w = tag.width != null ? num(tag.width) : box.w;
    const h = tag.height != null ? num(tag.height) : box.h;
    const fill = tag.fill;
    if (fill && fill !== "none") fillRect(rgb, outWidth, outHeight, x * sx, y * sy, w * sx, h * sy, fill);
    const stroke = tag.stroke;
    if (stroke && stroke !== "none") {
      const sw = Math.max(1, num(tag["stroke-width"] || "1"));
      strokeRect(rgb, outWidth, outHeight, x * sx, y * sy, w * sx, h * sy, sw * ((sx + sy) / 2), stroke);
    }
  }
  return encodeRgbPng(outWidth, outHeight, rgb, 6);
}

function strokeRect(
  rgb: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  w: number,
  h: number,
  stroke: number,
  color: string,
): void {
  fillRect(rgb, width, height, x, y, w, stroke, color);
  fillRect(rgb, width, height, x, y + h - stroke, w, stroke, color);
  fillRect(rgb, width, height, x, y, stroke, h, color);
  fillRect(rgb, width, height, x + w - stroke, y, stroke, h, color);
}

function viewBox(svg: string): { x: number; y: number; w: number; h: number } {
  const found = /viewBox="([^"]+)"/.exec(svg);
  if (!found) return { x: 0, y: 0, w: 360, h: 640 };
  const parts = found[1]!.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part) || parts[2]! <= 0 || parts[3]! <= 0)) {
    return { x: 0, y: 0, w: 360, h: 640 };
  }
  return { x: parts[0]!, y: parts[1]!, w: parts[2]!, h: parts[3]! };
}

function attrs(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_:][\w:.-]*)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) out[match[1]!] = match[2]!;
  return out;
}

function num(value: string | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function clampInt(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}
