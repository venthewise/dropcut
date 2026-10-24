import { describe, expect, it } from "vitest";
import { buildCutlist, parseCutlist } from "./cutlist";
import { FPS, MAX_FRAMES, MAX_SEGMENT_SEC } from "./looks";

function base(overrides: Partial<Parameters<typeof buildCutlist>[0]> = {}) {
  return buildCutlist({
    clipStart: 0,
    clipEnd: 15,
    drops: [4, 9],
    beats: Array.from({ length: 30 }, (_, i) => i * 0.5),
    photoCount: 3,
    lookIds: ["neon", "film", "ink"],
    transition: "hard",
    captionStyle: "block",
    seed: 11,
    bpm: 120,
    ...overrides,
  });
}

describe("buildCutlist", () => {
  it("covers the clip with no gaps or overlaps", () => {
    const cut = base();
    expect(cut.segments.length).toBeGreaterThan(0);
    expect(cut.segments[0]!.start).toBe(0);
    expect(cut.segments[cut.segments.length - 1]!.end).toBe(15);
    for (let i = 0; i < cut.segments.length; i++) {
      const seg = cut.segments[i]!;
      expect(seg.end).toBeGreaterThan(seg.start);
      expect(seg.duration).toBe(seg.end - seg.start);
      if (i > 0) expect(seg.start).toBe(cut.segments[i - 1]!.end);
    }
  });

  it("keeps every segment inside the 97-frame cap at 24 fps", () => {
    const cut = base({ clipStart: 0, clipEnd: 30, drops: [], beats: [] });
    expect(cut.segments.length).toBeGreaterThan(1);
    for (const seg of cut.segments) {
      expect(seg.duration).toBeLessThanOrEqual(MAX_SEGMENT_SEC + 1e-9);
      expect(seg.frames).toBeLessThanOrEqual(MAX_FRAMES);
      expect(seg.frames).toBe(Math.max(1, Math.min(MAX_FRAMES, Math.round(seg.duration * FPS))));
    }
  });

  it("is deterministic for the same inputs", () => {
    const input = {
      clipStart: 1,
      clipEnd: 12.5,
      drops: [3.25, 8],
      beats: [1, 1.5, 2, 2.5, 3, 3.5, 4],
      photoCount: 2 as const,
      lookIds: ["glitch", "xerox", "chrome"],
      transition: "flash" as const,
      captionStyle: "kick",
      seed: 99,
      bpm: 96,
    };
    expect(buildCutlist(input)).toEqual(buildCutlist(input));
    expect(JSON.stringify(buildCutlist(input))).toBe(JSON.stringify(buildCutlist({ ...input, drops: [...input.drops] })));
  });

  it("round-robins photos and looks", () => {
    const cut = base({ clipEnd: 8, drops: [2, 4, 6], beats: [], photoCount: 3, lookIds: ["neon", "ink"] });
    expect(cut.segments.length).toBeGreaterThanOrEqual(4);
    cut.segments.forEach((seg, i) => {
      expect(seg.photoIndex).toBe(i % 3);
      expect(seg.look).toBe(i % 2 === 0 ? "neon" : "ink");
    });
  });

  it("changes when the seed changes and stays put when only captions would", () => {
    const a = base({ seed: 1 });
    const b = base({ seed: 2 });
    expect(a.segments.map((s) => s.seed)).not.toEqual(b.segments.map((s) => s.seed));
    expect(a.segments.map((s) => [s.start, s.end])).toEqual(b.segments.map((s) => [s.start, s.end]));
  });

  it("marks a segment that starts on a drop", () => {
    const cut = base({ clipStart: 0, clipEnd: 8, drops: [4], beats: [], lookIds: ["neon"] });
    const hit = cut.segments.find((seg) => Math.abs(seg.start - 4) < 1e-6);
    expect(hit?.captionCue).toBe("DROP");
    expect(hit?.caption).toBe("DROP");
    expect(cut.segments[0]!.captionCue).toBe("HOLD");
  });

  it("rejects a window over 30 seconds and an empty look set", () => {
    expect(() => base({ clipEnd: 31 })).toThrow(/30/);
    expect(() => base({ lookIds: [] })).toThrow(/look/i);
  });

  it("round-trips through parseCutlist", () => {
    const cut = base();
    cut.segments[0]!.caption = "MARK";
    expect(parseCutlist(JSON.parse(JSON.stringify(cut)))).toEqual(cut);
  });

  it("rejects a gap", () => {
    const cut = base({ clipEnd: 8, drops: [], beats: [] });
    const broken = structuredClone(cut);
    const seg = broken.segments[1]!;
    seg.start += 0.2;
    seg.duration = seg.end - seg.start;
    expect(() => parseCutlist(broken)).toThrow(/gaps|overlaps/i);
  });
});
