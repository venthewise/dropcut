import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildAss, captionFontsDir, type AssCaption } from "./ass";
import { buildFfmpegArgs, buildFilterGraph, type FfmpegInput } from "./graph";
import { parseFfmpegProgress } from "./progress";
import { rasterizeSvg } from "./raster";

export interface AssembleSegment {
  id: string;
  filePath: string;
  contentType: string;
  filename: string;
  duration: number;
  transition: string;
}

export interface AssembleRequest {
  ffmpegPath: string;
  segments: AssembleSegment[];
  audioPath: string;
  clipStart: number;
  songDuration: number;
  captions: AssCaption[];
  outputPath: string;
  workDir: string;
  fps: 24 | 30;
  endCardUrl: string;
  endCardSeconds: number;
  fontsDir?: string;
  onProgress?: (progress: number) => void;
}

/**
 * Run ffmpeg for one export. Writes a partial file, then renames it into
 * place so a failed render does not replace a previous good MP4.
 */
export async function assemble(req: AssembleRequest): Promise<void> {
  await rm(req.workDir, { recursive: true, force: true });
  await mkdir(req.workDir, { recursive: true });
  await mkdir(path.dirname(req.outputPath), { recursive: true });
  // The muxer is chosen from the extension. A suffix like ".mp4.partial" is
  // not a format, so the temp file stays a real .mp4 inside the work dir.
  const partial = path.join(req.workDir, "reel.mp4");
  try {
    const inputs: FfmpegInput[] = [];
    for (const segment of req.segments) {
      const kind = mediaKind(segment.contentType, segment.filename);
      if (kind === "svg") {
        const png = rasterizeSvg((await readFile(segment.filePath)).toString("utf8"));
        const pngPath = path.join(req.workDir, `${segment.id}.png`);
        await writeFile(pngPath, png);
        inputs.push({ path: pngPath, still: true, duration: segment.duration });
      } else {
        inputs.push({ path: segment.filePath, still: kind === "still", duration: segment.duration });
      }
    }
    const fontsDir = req.fontsDir ?? captionFontsDir();
    const assPath = path.join(req.workDir, "captions.ass");
    const endCard = req.endCardUrl && req.endCardSeconds > 0
      ? { url: req.endCardUrl, start: req.songDuration, end: req.songDuration + req.endCardSeconds }
      : undefined;
    await writeFile(assPath, buildAss({ captions: req.captions, clipStart: req.clipStart, endCard }), "utf8");
    const planned = buildFilterGraph({
      segments: req.segments.map((segment) => ({ duration: segment.duration, transition: segment.transition })),
      fps: req.fps,
      clipStart: req.clipStart,
      songDuration: req.songDuration,
      endCardSeconds: endCard ? req.endCardSeconds : 0,
      assPath,
      fontsDir,
    });
    const args = buildFfmpegArgs({
      outputPath: partial,
      filter: planned.graph,
      segments: inputs,
      audioPath: req.audioPath,
      fps: req.fps,
    });
    await runFfmpeg(req.ffmpegPath, args, planned.outputSeconds, req.onProgress);
    await rm(req.outputPath, { force: true });
    await rename(partial, req.outputPath);
  } catch (err) {
    await rm(partial, { force: true }).catch(() => undefined);
    throw err;
  } finally {
    await rm(req.workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function mediaKind(contentType: string, filename: string): "svg" | "still" | "video" {
  const type = contentType.toLowerCase();
  const name = filename.toLowerCase();
  if (type.includes("svg") || name.endsWith(".svg")) return "svg";
  if (type.startsWith("video/") || /\.(mp4|webm|mov|gif)$/.test(name)) return "video";
  return "still";
}

function runFfmpeg(
  ffmpegPath: string,
  args: string[],
  totalSeconds: number,
  onProgress?: (progress: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let settled = false;
    let stdout = "";
    let stderr = "";
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error("ffmpeg timed out after 3 minutes."));
    }, 180_000);
    const takeProgress = (chunk: string) => {
      stdout += chunk;
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        const progress = parseFfmpegProgress(line, totalSeconds);
        if (progress != null) onProgress?.(progress);
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", takeProgress);
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on("error", (err) => fail(err));
    child.on("close", (code) => {
      if (settled) return;
      clearTimeout(timer);
      if (stdout.trim()) {
        const progress = parseFfmpegProgress(stdout, totalSeconds);
        if (progress != null) onProgress?.(progress);
      }
      if (code === 0) {
        settled = true;
        onProgress?.(1);
        resolve();
        return;
      }
      const detail = stderr.trim() || `ffmpeg exited ${code ?? "unknown"}.`;
      fail(new Error(detail));
    });
  });
}
