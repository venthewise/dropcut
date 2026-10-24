import { describe, expect, it } from "vitest";
import { parseFfmpegProgress } from "./progress";

describe("ffmpeg progress", () => {
  it("reads out_time_us against the output duration and ignores the misnamed out_time_ms", () => {
    expect(parseFfmpegProgress("out_time_us=500000", 2)).toBeCloseTo(0.25);
    expect(parseFfmpegProgress("out_time_us=N/A", 2)).toBeNull();
    expect(parseFfmpegProgress("out_time_ms=1000000", 2)).toBeNull();
    expect(parseFfmpegProgress("out_time=00:00:01.000000", 2)).toBeCloseTo(0.5);
    expect(parseFfmpegProgress("out_time=00:00:03.000000", 2)).toBe(1);
    expect(parseFfmpegProgress("progress=end", 2)).toBe(1);
    expect(parseFfmpegProgress("frame=10", 2)).toBeNull();
  });
});
