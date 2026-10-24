import path from "node:path";
import { describe, expect, it } from "vitest";
import { ffmpegCandidates, ffprobeCandidates, pickBinary, siblingFfprobe } from "./binaries";

describe("ffmpeg detection order", () => {
  it("tries FFMPEG_PATH, then PATH, then ffmpeg-static, and stops at the first binary that answers", async () => {
    const candidates = ffmpegCandidates(
      { FFMPEG_PATH: "D:\\tools\\ffmpeg.exe" },
      "C:\\static\\ffmpeg.exe",
    );
    expect(candidates.map((item) => item.source)).toEqual(["FFMPEG_PATH", "PATH", "ffmpeg-static"]);

    const probed: string[] = [];
    const found = await pickBinary(candidates, async (bin) => {
      probed.push(bin);
      return bin === "ffmpeg";
    });
    expect(found).toEqual({ path: "ffmpeg", source: "PATH" });
    expect(probed).toEqual(["D:\\tools\\ffmpeg.exe", "ffmpeg"]);
  });

  it("skips a blank FFMPEG_PATH and can fall through to ffmpeg-static", async () => {
    const candidates = ffmpegCandidates({ FFMPEG_PATH: "   " }, "C:\\static\\ffmpeg.exe");
    expect(candidates.map((item) => item.source)).toEqual(["PATH", "ffmpeg-static"]);
    const probed: string[] = [];
    const found = await pickBinary(candidates, async (bin) => {
      probed.push(bin);
      return bin.includes("static");
    });
    expect(found?.source).toBe("ffmpeg-static");
    expect(probed).toEqual(["ffmpeg", "C:\\static\\ffmpeg.exe"]);
  });

  it("prefers FFPROBE_PATH, then PATH, then a sibling of ffmpeg, then ffprobe-static", () => {
    const ffmpeg = path.join("C:\\tools", "ffmpeg.exe");
    expect(path.basename(siblingFfprobe(ffmpeg)).toLowerCase()).toBe("ffprobe.exe");
    const sources = ffprobeCandidates(
      { FFPROBE_PATH: "D:\\ffprobe.exe" },
      ffmpeg,
      path.join("C:\\pkg", "ffprobe.exe"),
    ).map((item) => item.source);
    expect(sources).toEqual(["FFPROBE_PATH", "PATH", "sibling", "ffprobe-static"]);
    expect(ffprobeCandidates({}, "ffmpeg", null).map((item) => item.source)).toEqual(["PATH"]);
  });
});
