export interface BeatAnalysis {
  duration: number;
  sampleRate: number;
  bpm: number;
  beats: number[];
  drops: number[];
  /** Normalized 0–1 peaks for drawing. */
  envelope: number[];
}

export async function analyzeFile(file: File): Promise<BeatAnalysis> {
  const ctx = new AudioContext();
  try {
    const copy = (await file.arrayBuffer()).slice(0);
    const audio = await ctx.decodeAudioData(copy);
    return analyzeBuffer(audio);
  } catch {
    throw new Error("This browser could not decode that audio file. Use mp3, wav, or m4a.");
  } finally {
    await ctx.close();
  }
}

export function analyzeBuffer(audio: AudioBuffer): BeatAnalysis {
  const channel = audio.getChannelData(0);
  const sampleRate = audio.sampleRate;
  const win = 2048;
  const hop = 1024;
  const hopSec = hop / sampleRate;
  const energies: number[] = [];

  if (channel.length < win) {
    let sum = 0;
    for (let i = 0; i < channel.length; i++) sum += (channel[i] ?? 0) ** 2;
    const rms = Math.sqrt(sum / Math.max(1, channel.length));
    return { duration: audio.duration, sampleRate, bpm: 120, beats: [], drops: [], envelope: normalize([rms]) };
  }

  for (let i = 0; i + win <= channel.length; i += hop) {
    let sum = 0;
    const step = 4;
    for (let j = 0; j < win; j += step) sum += (channel[i + j] ?? 0) ** 2;
    energies.push(Math.sqrt(sum / (win / step)));
  }

  const onset = energies.map((energy, index) => Math.max(0, energy - (energies[index - 1] ?? energy)));
  const bpm = estimateBpm(onset, hopSec);
  const beats = trackBeats(onset, hopSec, bpm);
  const drops = markDrops(energies, hopSec);
  return {
    duration: audio.duration,
    sampleRate,
    bpm,
    beats,
    drops,
    envelope: normalize(downsample(energies, 900)),
  };
}

function estimateBpm(onset: number[], hopSec: number): number {
  if (onset.length < 8) return 120;
  const minBpm = 70;
  const maxBpm = 180;
  const minLag = Math.max(1, Math.round(60 / maxBpm / hopSec));
  const maxLag = Math.min(onset.length - 2, Math.round(60 / minBpm / hopSec));
  let bestLag = minLag;
  let best = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let score = 0;
    for (let i = 0; i + lag < onset.length; i++) score += (onset[i] ?? 0) * (onset[i + lag] ?? 0);
    score /= onset.length - lag;
    if (score > best) {
      best = score;
      bestLag = lag;
    }
  }
  const bpm = 60 / (bestLag * hopSec);
  if (!Number.isFinite(bpm)) return 120;
  return Math.round(bpm * 10) / 10;
}

function trackBeats(onset: number[], hopSec: number, bpm: number): number[] {
  if (bpm < 40 || onset.length < 4) return [];
  const periodFrames = Math.max(1, Math.round(60 / bpm / hopSec));
  const window = Math.max(1, Math.round(periodFrames * 0.18));
  let start = 0;
  let best = -1;
  const scan = Math.min(onset.length - 1, periodFrames * 2);
  for (let i = 1; i < scan; i++) {
    const value = onset[i] ?? 0;
    if (value > best) {
      best = value;
      start = i;
    }
  }
  const beats: number[] = [];
  for (let frame = start; frame < onset.length; frame += periodFrames) {
    let peak = frame;
    let peakVal = -1;
    const from = Math.max(0, frame - window);
    const to = Math.min(onset.length - 1, frame + window);
    for (let i = from; i <= to; i++) {
      const value = onset[i] ?? 0;
      if (value > peakVal) {
        peakVal = value;
        peak = i;
      }
    }
    const time = peak * hopSec;
    const prev = beats[beats.length - 1];
    if (prev == null || time - prev > 0.05) beats.push(time);
  }
  return beats;
}

function markDrops(energies: number[], hopSec: number): number[] {
  const prevWin = Math.max(1, Math.round(1 / hopSec));
  const scored: { t: number; score: number }[] = [];
  for (let i = prevWin; i < energies.length; i++) {
    let base = 0;
    for (let j = i - prevWin; j < i; j++) base += energies[j] ?? 0;
    base /= prevWin;
    const energy = energies[i] ?? 0;
    const ratio = energy / (base + 1e-6);
    if (ratio > 1.65 && energy > base + 0.02) scored.push({ t: i * hopSec, score: ratio * energy });
  }
  scored.sort((a, b) => b.score - a.score);
  const drops: number[] = [];
  for (const hit of scored) {
    if (drops.every((time) => Math.abs(time - hit.t) > 1.6)) drops.push(hit.t);
  }
  drops.sort((a, b) => a - b);
  return drops;
}

function downsample(values: number[], count: number): number[] {
  if (values.length <= count) return values.slice();
  const out: number[] = [];
  const step = values.length / count;
  for (let i = 0; i < count; i++) {
    const from = Math.floor(i * step);
    const to = Math.max(from + 1, Math.floor((i + 1) * step));
    let peak = 0;
    for (let j = from; j < to && j < values.length; j++) peak = Math.max(peak, values[j] ?? 0);
    out.push(peak);
  }
  return out;
}

function normalize(values: number[]): number[] {
  const max = Math.max(1e-6, ...values);
  return values.map((value) => value / max);
}
