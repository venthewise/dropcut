import { describe, expect, it } from "vitest";
import { exportCacheKey, type ExportKeyInput } from "./key";

function input(patch: Partial<ExportKeyInput> = {}): ExportKeyInput {
  return {
    segmentCacheKeys: ["aaa", "bbb"],
    rows: [
      { id: "s00", start: 0, end: 1, caption: "DROP", captionStyle: "block", transition: "hard" },
      { id: "s01", start: 1, end: 2, caption: "HOLD", captionStyle: "block", transition: "hard" },
    ],
    songSha256: "song",
    fps: 30,
    width: 1080,
    height: 1920,
    endCardUrl: "",
    endCardSeconds: 0,
    fadeSeconds: 0.05,
    ...patch,
  };
}

describe("export cache key", () => {
  it("is stable and changes when a caption, a segment, the song, or a setting changes", () => {
    expect(exportCacheKey(input())).toBe(exportCacheKey(input()));
    expect(exportCacheKey(input())).not.toBe(exportCacheKey(input({
      rows: [
        { id: "s00", start: 0, end: 1, caption: "NOW", captionStyle: "block", transition: "hard" },
        { id: "s01", start: 1, end: 2, caption: "HOLD", captionStyle: "block", transition: "hard" },
      ],
    })));
    expect(exportCacheKey(input())).not.toBe(exportCacheKey(input({ segmentCacheKeys: ["aaa", "ccc"] })));
    expect(exportCacheKey(input())).not.toBe(exportCacheKey(input({ songSha256: "other" })));
    expect(exportCacheKey(input())).not.toBe(exportCacheKey(input({ fps: 24 })));
    expect(exportCacheKey(input())).not.toBe(exportCacheKey(input({ endCardUrl: "https://example.com", endCardSeconds: 2 })));
  });
});
