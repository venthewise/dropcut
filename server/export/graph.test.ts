import { describe, expect, it } from "vitest";
import { buildFfmpegArgs, buildFilterGraph, escapeFilterPath } from "./graph";

describe("export filter graph", () => {
  it("covers, clones, and trims each segment to the beat length and uses only the song for audio", () => {
    const planned = buildFilterGraph({
      segments: [
        { duration: 1, transition: "hard" },
        { duration: 1.5, transition: "hard" },
      ],
      fps: 30,
      clipStart: 0.5,
      songDuration: 2.5,
      endCardSeconds: 0,
      assPath: "C:\\cuts\\captions.ass",
      fontsDir: "C:\\fonts",
    });
    expect(planned.outputSeconds).toBe(2.5);
    expect(planned.songSeconds).toBe(2.5);
    expect(planned.graph).toContain("scale=1080:1920:force_original_aspect_ratio=increase");
    expect(planned.graph).toContain("crop=1080:1920");
    expect(planned.graph).toContain("tpad=stop_mode=clone:stop_duration=1.000000");
    expect(planned.graph).toContain("trim=duration=1.500000");
    expect(planned.graph).toContain("format=yuv420p");
    expect(planned.graph).toContain("[2:a]atrim=start=0.500000:end=3.000000");
    expect(planned.graph).toContain("afade=t=in:st=0:d=0.050000");
    expect(planned.graph).not.toContain("[0:a]");
    expect(planned.graph).not.toContain("amix");
    expect(planned.graph).toContain(`ass='${escapeFilterPath("C:\\cuts\\captions.ass")}'`);
    expect(escapeFilterPath("C:\\cuts\\captions.ass")).toBe("C\\:/cuts/captions.ass");
  });

  it("keeps flash and whip inside the segment so the cut time does not move", () => {
    const flash = buildFilterGraph({
      segments: [
        { duration: 1, transition: "flash" },
        { duration: 1, transition: "flash" },
      ],
      fps: 30,
      clipStart: 0,
      songDuration: 2,
      endCardSeconds: 0,
      assPath: "a.ass",
      fontsDir: "fonts",
    });
    const [beforeFlash, afterFlash] = flash.graph.split("[1:v]");
    expect(beforeFlash).not.toContain("fade=");
    expect(afterFlash).toContain("fade=t=in:st=0:d=0.0333:color=0xD1FE17");
    expect(flash.outputSeconds).toBe(2);

    const whip = buildFilterGraph({
      segments: [
        { duration: 1, transition: "whip" },
        { duration: 1, transition: "whip" },
      ],
      fps: 30,
      clipStart: 0,
      songDuration: 2,
      endCardSeconds: 0,
      assPath: "a.ass",
      fontsDir: "fonts",
    });
    const [beforeWhip, afterWhip] = whip.graph.split("[1:v]");
    expect(beforeWhip).not.toContain("0.12");
    expect(afterWhip).toContain("scale=1296:1920");
    expect(afterWhip).toContain("1-t/0.12");
    expect(whip.outputSeconds).toBe(2);
  });

  it("appends a silent end card after the song range", () => {
    const planned = buildFilterGraph({
      segments: [{ duration: 1, transition: "hard" }],
      fps: 24,
      clipStart: 0,
      songDuration: 1,
      endCardSeconds: 2,
      assPath: "a.ass",
      fontsDir: "fonts",
    });
    expect(planned.outputSeconds).toBe(3);
    expect(planned.endCardSeconds).toBe(2);
    expect(planned.graph).toContain("color=c=0x0A0A0A:s=1080x1920:r=24:d=2.000000");
    expect(planned.graph).toContain("atrim=start=0.000000:end=1.000000");
    expect(planned.graph).toContain("apad=whole_dur=3.000000");
  });

  it("loops stills and does not loop video inputs", () => {
    const args = buildFfmpegArgs({
      outputPath: "out.mp4",
      filter: "[vout]",
      segments: [
        { path: "a.png", still: true, duration: 1 },
        { path: "b.mp4", still: false, duration: 1 },
      ],
      audioPath: "song.wav",
      fps: 30,
    });
    const loopAt = args.indexOf("-loop");
    const stillAt = args.indexOf("a.png");
    const videoAt = args.indexOf("b.mp4");
    expect(loopAt).toBeGreaterThanOrEqual(0);
    expect(loopAt).toBeLessThan(stillAt);
    expect(args.indexOf("-loop", loopAt + 1)).toBe(-1);
    expect(videoAt).toBeGreaterThan(stillAt);
    expect(args).toContain("libx264");
    expect(args).toContain("yuv420p");
    expect(args).toContain("aac");
    expect(args).toContain("+faststart");
    expect(args[args.indexOf("-map") + 1]).toBe("[vout]");
    expect(args[args.indexOf("-map", args.indexOf("-map") + 1) + 1]).toBe("[aout]");
  });
});
