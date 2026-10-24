/**
 * Write the bundled CC0 sample song and plates.
 * Self-generated. No recordings, no people, no trademarks.
 * Run: npx tsx scripts/make-samples.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRgb, encodeRgbPng, fillCircle, fillRect } from "../server/export/raster";

const ROOT = path.resolve(process.cwd(), "samples");
const W = 1080;
const H = 1920;

function songWav(): Buffer {
  const sampleRate = 22050;
  const seconds = 16;
  const bpm = 120;
  const beat = 60 / bpm;
  const count = sampleRate * seconds;
  const data = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) {
    const t = i / sampleRate;
    const beatIndex = Math.floor(t / beat + 1e-9);
    const beatPos = t - beatIndex * beat;
    const drop = beatIndex % 4 === 0;
    let sample = Math.sin(2 * Math.PI * 55 * t) * 0.05;
    if (beatPos < 0.05) {
      const env = Math.exp(-beatPos * 60);
      const amp = drop ? 0.95 : 0.4;
      sample += Math.sin(2 * Math.PI * (drop ? 92 : 68) * beatPos) * env * amp;
      const noise = Math.sin(i * 12.9898) * 43758.5453;
      const unit = noise - Math.floor(noise);
      sample += (unit * 2 - 1) * env * (drop ? 0.35 : 0.12);
    }
    const clipped = Math.max(-1, Math.min(1, sample));
    data.writeInt16LE(Math.round(clipped * 30000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function photoA(): Buffer {
  const rgb = createRgb(W, H, "#0a0a0a");
  fillRect(rgb, W, H, 70, 70, W - 140, H - 140, "#0a0a0a");
  fillRect(rgb, W, H, 70, 70, 18, H - 140, "#d1fe17");
  fillRect(rgb, W, H, 160, 220, 760, 980, "#d1fe17");
  fillRect(rgb, W, H, 220, 300, 280, 820, "#0a0a0a");
  fillRect(rgb, W, H, 120, 1500, 840, 48, "#f4f1ea");
  return encodeRgbPng(W, H, rgb, 9);
}

function photoB(): Buffer {
  const rgb = createRgb(W, H, "#f4f1ea");
  fillRect(rgb, W, H, 0, 0, 48, H, "#1a120c");
  fillCircle(rgb, W, H, 620, 780, 340, "#1a120c");
  fillCircle(rgb, W, H, 700, 860, 160, "#c4a574");
  fillRect(rgb, W, H, 120, 1320, 840, 90, "#0a0a0a");
  fillRect(rgb, W, H, 120, 1460, 520, 90, "#d1fe17");
  return encodeRgbPng(W, H, rgb, 9);
}

function photoC(): Buffer {
  const rgb = createRgb(W, H, "#120814");
  for (let i = 0; i < 6; i++) {
    fillRect(rgb, W, H, 140, 180 + i * 250, 800 - i * 40, 36, i % 2 === 0 ? "#ff3b8d" : "#d1fe17");
  }
  fillRect(rgb, W, H, 180, 480, 280, 640, "#ff3b8d");
  fillRect(rgb, W, H, 520, 620, 360, 420, "#f4f1ea");
  fillCircle(rgb, W, H, 360, 1500, 180, "#d1fe17");
  return encodeRgbPng(W, H, rgb, 9);
}

async function main(): Promise<void> {
  await mkdir(ROOT, { recursive: true });
  await writeFile(path.join(ROOT, "song.wav"), songWav());
  await writeFile(path.join(ROOT, "photo-a.png"), photoA());
  await writeFile(path.join(ROOT, "photo-b.png"), photoB());
  await writeFile(path.join(ROOT, "photo-c.png"), photoC());
  console.log(`[samples] wrote ${ROOT}`);
}

void main();
