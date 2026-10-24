import { describe, expect, it } from "vitest";
import { renderPlaceholderSvg } from "../generation/placeholder";
import { encodeRgbPng, rasterizeSvg } from "./raster";

describe("plate raster", () => {
  it("writes a PNG and turns a mock SVG into one", () => {
    const png = encodeRgbPng(2, 2, new Uint8Array([
      255, 0, 0, 0, 255, 0,
      0, 0, 255, 255, 255, 255,
    ]));
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBe(2);
    expect(png.readUInt32BE(20)).toBe(2);

    const plate = rasterizeSvg(renderPlaceholderSvg({ look: "neon", seed: 3, segmentId: "s00", start: 0 }), 32, 48);
    expect(plate.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(plate.readUInt32BE(16)).toBe(32);
    expect(plate.readUInt32BE(20)).toBe(48);
    expect(plate.length).toBeGreaterThan(32);
  });
});
