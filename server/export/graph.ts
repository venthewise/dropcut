/**
 * Filter graph for the final reel.
 *
 * Each segment is scaled and center-cropped to 1080×1920 (cover), forced to
 * the export fps, then trimmed or padded with `tpad=stop_mode=clone` so its
 * length is exactly end-start. Cuts stay on the beat. The sum of those
 * lengths is the trimmed song range.
 *
 * Transitions do not change that length and do not shift the cut:
 * - hard: a concat cut.
 * - flash: one acid frame faded in at the start of every segment after the
 *   first (`fade` color #d1fe17). The fade lives inside the segment.
 * - whip: the incoming plate slides in over about 120ms from extra cover
 *   width, inside the segment. It is not an overlapping crossfade.
 *
 * Segment files are never mapped as audio. The only audio is the song,
 * trimmed to clipStart..clipEnd, with a short fade in and out. An end card,
 * when configured, is a silent tail: the song is not stretched, and `apad`
 * fills the card with silence after the fade.
 */

import { EXPORT_HEIGHT, EXPORT_WIDTH } from "./ass";

export const EXPORT_FADE_SECONDS = 0.05;

export interface GraphSegment {
  duration: number;
  transition: string;
}

export interface FilterGraph {
  graph: string;
  outputSeconds: number;
  songSeconds: number;
  endCardSeconds: number;
}

export function seconds(value: number): string {
  if (!Number.isFinite(value)) throw new Error("A filter duration is not finite.");
  return value.toFixed(6);
}

/** Escape a filesystem path for a filtergraph argument wrapped in single quotes. */
export function escapeFilterPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/([\\':[\],;])/g, "\\$1");
}

export function fadeLength(songDuration: number): number {
  if (!(songDuration > 0)) return 0;
  return Math.min(EXPORT_FADE_SECONDS, songDuration / 4);
}

export function buildFilterGraph(opts: {
  segments: GraphSegment[];
  fps: number;
  width?: number;
  height?: number;
  clipStart: number;
  songDuration: number;
  endCardSeconds: number;
  assPath: string;
  fontsDir: string;
}): FilterGraph {
  const width = opts.width ?? EXPORT_WIDTH;
  const height = opts.height ?? EXPORT_HEIGHT;
  if (opts.segments.length === 0) throw new Error("Export needs at least one segment.");
  const endCardSeconds = opts.endCardSeconds > 0 ? opts.endCardSeconds : 0;
  const outputSeconds = opts.songDuration + endCardSeconds;
  const chains = opts.segments.map((segment, index) => segmentChain(segment, index, opts.fps, width, height));
  const labels = opts.segments.map((_, index) => `[v${index}]`).join("");
  const videoLabel = endCardSeconds > 0 ? "vcat" : "vpre";
  let graph = `${chains.join(";")};${labels}concat=n=${opts.segments.length}:v=1:a=0[${videoLabel}]`;
  if (endCardSeconds > 0) {
    graph += `;color=c=0x0A0A0A:s=${width}x${height}:r=${opts.fps}:d=${seconds(endCardSeconds)},format=yuv420p,setsar=1[endv]`;
    graph += `;[vcat][endv]concat=n=2:v=1:a=0[vpre]`;
  }
  const ass = escapeFilterPath(opts.assPath);
  const fonts = escapeFilterPath(opts.fontsDir);
  graph += `;[vpre]ass='${ass}':fontsdir='${fonts}'[vout]`;
  graph += `;${audioChain(opts.segments.length, opts.clipStart, opts.songDuration, outputSeconds)}`;
  return { graph, outputSeconds, songSeconds: opts.songDuration, endCardSeconds };
}

function segmentChain(segment: GraphSegment, index: number, fps: number, width: number, height: number): string {
  const duration = seconds(segment.duration);
  const whip = segment.transition === "whip" && index > 0;
  const wide = Math.round(width * 1.2);
  const scale = whip
    ? `scale=${wide}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}:x='(in_w-out_w)*max(0\\,1-t/0.12)':y='(in_h-out_h)/2'`
    : `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}:(in_w-out_w)/2:(in_h-out_h)/2`;
  const flash = segment.transition === "flash" && index > 0
    ? `,fade=t=in:st=0:d=${(1 / fps).toFixed(4)}:color=0xD1FE17`
    : "";
  return `[${index}:v]fps=${fps},setpts=PTS-STARTPTS,${scale},setsar=1,format=yuv420p${flash},tpad=stop_mode=clone:stop_duration=${duration},trim=duration=${duration},setpts=PTS-STARTPTS[v${index}]`;
}

function audioChain(audioIndex: number, clipStart: number, songDuration: number, totalDuration: number): string {
  const fade = fadeLength(songDuration);
  const fadeOut = Math.max(0, songDuration - fade);
  return `[${audioIndex}:a]atrim=start=${seconds(clipStart)}:end=${seconds(clipStart + songDuration)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${seconds(fade)},afade=t=out:st=${seconds(fadeOut)}:d=${seconds(fade)},aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=${seconds(totalDuration)},atrim=duration=${seconds(totalDuration)}[aout]`;
}

export interface FfmpegInput {
  path: string;
  still: boolean;
  duration: number;
}

export function buildFfmpegArgs(opts: {
  outputPath: string;
  filter: string;
  segments: FfmpegInput[];
  audioPath: string;
  fps: number;
}): string[] {
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-nostdin", "-progress", "pipe:1"];
  for (const segment of opts.segments) {
    if (segment.still) {
      args.push("-loop", "1", "-framerate", String(opts.fps), "-t", seconds(segment.duration), "-i", segment.path);
    } else {
      args.push("-i", segment.path);
    }
  }
  args.push("-i", opts.audioPath);
  args.push(
    "-filter_complex",
    opts.filter,
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    "-r",
    String(opts.fps),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    opts.outputPath,
  );
  return args;
}
