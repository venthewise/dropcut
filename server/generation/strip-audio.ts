import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Drop the audio stream from a generated segment. DropCut always plays and
 * muxes the user's song, so a workflow's own generated audio is discarded.
 * Best effort: uses the resolved ffmpeg binary (FFMPEG_PATH, PATH, then
 * ffmpeg-static). Returns the original bytes if stripping fails.
 */
export async function stripAudio(bytes: Buffer, ext = ".mp4", ffmpegPath = "ffmpeg"): Promise<{ bytes: Buffer; stripped: boolean }> {
  const dir = await mkdtemp(path.join(tmpdir(), "dropcut-"));
  const input = path.join(dir, `in${ext}`);
  const output = path.join(dir, `out${ext}`);
  try {
    await writeFile(input, bytes);
    await new Promise<void>((resolve, reject) => {
      execFile(
        ffmpegPath,
        ["-y", "-loglevel", "error", "-i", input, "-map", "0:v", "-c", "copy", "-an", output],
        { timeout: 60_000, windowsHide: true },
        (err) => (err ? reject(err) : resolve()),
      );
    });
    return { bytes: await readFile(output), stripped: true };
  } catch {
    return { bytes, stripped: false };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function isVideo(contentType: string, bytes: Buffer): boolean {
  if (contentType.startsWith("video/")) return true;
  // ISO BMFF (mp4/mov): "ftyp" at offset 4. WebM/Matroska: EBML magic.
  if (bytes.length > 12 && bytes.subarray(4, 8).toString("latin1") === "ftyp") return true;
  return bytes.length > 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
}
