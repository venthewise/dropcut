import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * ffmpeg lookup order: FFMPEG_PATH, then `ffmpeg` on PATH, then the
 * ffmpeg-static package. A candidate that does not answer `-version` is
 * skipped so a bad path does not hide a working later one.
 * ffprobe follows FFPROBE_PATH, `ffprobe` on PATH, a sibling of the chosen
 * ffmpeg, then the ffprobe-static package.
 */

export type FfmpegSource = "FFMPEG_PATH" | "PATH" | "ffmpeg-static";
export type FfprobeSource = "FFPROBE_PATH" | "PATH" | "sibling" | "ffprobe-static";

export interface ResolvedBinary<Source extends string = string> {
  path: string;
  source: Source;
}

export interface BinaryCandidate<Source extends string> {
  path: string;
  source: Source;
}

export interface Binaries {
  ffmpeg: ResolvedBinary<FfmpegSource> | null;
  ffprobe: ResolvedBinary<FfprobeSource> | null;
}

const cache = new Map<string, Promise<Binaries>>();

export function ffmpegCandidates(env: NodeJS.ProcessEnv, staticPath: string | null): BinaryCandidate<FfmpegSource>[] {
  const list: BinaryCandidate<FfmpegSource>[] = [];
  const fromEnv = (env.FFMPEG_PATH ?? "").trim();
  if (fromEnv) list.push({ path: fromEnv, source: "FFMPEG_PATH" });
  list.push({ path: "ffmpeg", source: "PATH" });
  if (staticPath) list.push({ path: staticPath, source: "ffmpeg-static" });
  return list;
}

export function siblingFfprobe(ffmpegPath: string): string {
  const dir = path.dirname(ffmpegPath);
  const base = path.basename(ffmpegPath);
  const name = /ffmpeg/i.test(base)
    ? base.replace(/ffmpeg/i, "ffprobe")
    : `ffprobe${process.platform === "win32" ? ".exe" : ""}`;
  return path.join(dir, name);
}

export function ffprobeCandidates(
  env: NodeJS.ProcessEnv,
  ffmpegPath: string | null,
  staticPath: string | null,
): BinaryCandidate<FfprobeSource>[] {
  const list: BinaryCandidate<FfprobeSource>[] = [];
  const fromEnv = (env.FFPROBE_PATH ?? "").trim();
  if (fromEnv) list.push({ path: fromEnv, source: "FFPROBE_PATH" });
  list.push({ path: "ffprobe", source: "PATH" });
  if (ffmpegPath && (path.isAbsolute(ffmpegPath) || ffmpegPath.includes("/") || ffmpegPath.includes("\\"))) {
    list.push({ path: siblingFfprobe(ffmpegPath), source: "sibling" });
  }
  if (staticPath) list.push({ path: staticPath, source: "ffprobe-static" });
  return list;
}

/** First candidate whose probe returns true. Later candidates are not asked. */
export async function pickBinary<Source extends string>(
  candidates: BinaryCandidate<Source>[],
  probe: (bin: string) => Promise<boolean>,
): Promise<ResolvedBinary<Source> | null> {
  for (const candidate of candidates) {
    if (!candidate.path.trim()) continue;
    if (await probe(candidate.path)) return { path: candidate.path, source: candidate.source };
  }
  return null;
}

export function probeBinary(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(bin, ["-version"], { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        resolve(false);
        return;
      }
      resolve(/ffmpeg|ffprobe/i.test(`${stdout}\n${stderr}`));
    });
  });
}

export function bundledBinary(packageName: string, relativeParts: string[]): string | null {
  try {
    const req = createRequire(path.join(process.cwd(), "package.json"));
    const pkgJson = req.resolve(`${packageName}/package.json`);
    const candidate = path.join(path.dirname(pkgJson), ...relativeParts);
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

export function bundledFfmpeg(): string | null {
  const name = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  return bundledBinary("ffmpeg-static", [name]);
}

export function bundledFfprobe(): string | null {
  const name = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
  return bundledBinary("ffprobe-static", ["bin", process.platform, process.arch, name]);
}

export function resolveBinaries(env: NodeJS.ProcessEnv = process.env): Promise<Binaries> {
  const key = `${env.FFMPEG_PATH ?? ""}|${env.FFPROBE_PATH ?? ""}|${process.cwd()}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = resolveBinariesUncached(env);
  cache.set(key, pending);
  return pending;
}

async function resolveBinariesUncached(env: NodeJS.ProcessEnv): Promise<Binaries> {
  const ffmpeg = await pickBinary(ffmpegCandidates(env, bundledFfmpeg()), probeBinary);
  const ffprobe = await pickBinary(ffprobeCandidates(env, ffmpeg?.path ?? null, bundledFfprobe()), probeBinary);
  return { ffmpeg, ffprobe };
}
