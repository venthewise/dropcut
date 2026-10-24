import { describe, expect, it } from "vitest";
import { ASS_STYLES, SAFE_MARGIN_BOTTOM, SAFE_MARGIN_TOP, SAFE_MARGIN_X, buildAss, escapeAssText, formatAssTime } from "./ass";

function styleFields(ass: string, name: string): string[] {
  const line = ass.split(/\n/).find((item) => item.startsWith(`Style: ${name},`));
  expect(line, name).toBeTruthy();
  return line!.slice("Style: ".length).split(",");
}

describe("ASS captions", () => {
  it("places each style inside the 9:16 safe area", () => {
    const ass = buildAss({ clipStart: 0, captions: [] });
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("PlayResY: 1920");
    expect(ass).toContain("Archivo Black");
    for (const style of ASS_STYLES) {
      const fields = styleFields(ass, style.name);
      const alignment = Number(fields[18]);
      const marginL = Number(fields[19]);
      const marginR = Number(fields[20]);
      const marginV = Number(fields[21]);
      expect(marginL).toBeGreaterThanOrEqual(SAFE_MARGIN_X);
      expect(marginR).toBeGreaterThanOrEqual(SAFE_MARGIN_X);
      if (alignment === 1 || alignment === 2 || alignment === 3) {
        expect(marginV).toBeGreaterThanOrEqual(SAFE_MARGIN_BOTTOM);
      }
      if (alignment === 7 || alignment === 8 || alignment === 9) {
        expect(marginV).toBeGreaterThanOrEqual(SAFE_MARGIN_TOP);
      }
    }
    const block = styleFields(ass, "Block");
    expect(block[18]).toBe("2");
    expect(block[6]).toBe("&H00FFFFFF");
    const stamp = styleFields(ass, "Stamp");
    expect(stamp[18]).toBe("7");
    expect(stamp[6]).toBe("&H0017FED1");
    const lower = styleFields(ass, "Lower");
    expect(lower[18]).toBe("1");
    const kick = styleFields(ass, "Kick");
    expect(Number(kick[2])).toBeGreaterThan(Number(block[2]));
  });

  it("times cues from the clip in-point and escapes override characters", () => {
    expect(formatAssTime(1.5)).toBe("0:00:01.50");
    expect(escapeAssText("A{B}\\C\nD")).toBe("A\\{B\\}\\\\C\\ND");
    const ass = buildAss({
      clipStart: 1,
      captions: [
        { start: 1.5, end: 3, caption: "drop {go}\\x", captionStyle: "block" },
        { start: 3, end: 4, caption: "line\n2", captionStyle: "stamp" },
      ],
      endCard: { url: "https://example.com/dropcut", start: 3, end: 5 },
    });
    expect(ass).toContain("Dialogue: 0,0:00:00.50,0:00:02.00,Block,,0,0,0,,DROP \\{GO\\}\\\\X");
    expect(ass).toContain("Dialogue: 0,0:00:02.00,0:00:03.00,Stamp,,0,0,0,,LINE\\N2");
    expect(ass).toContain("https://example.com/dropcut");
    expect(ass).not.toContain("HTTPS://EXAMPLE.COM");
  });

  it("paints BorderStyle=3 boxes with the box colour (libass uses OutlineColour, not BackColour)", () => {
    const ass = buildAss({ clipStart: 0, captions: [] });
    const boxed = ASS_STYLES.filter((style) => style.borderStyle === 3);
    expect(boxed.map((style) => style.id).sort()).toEqual(["block", "lower", "stamp"]);
    for (const style of boxed) {
      const fields = styleFields(ass, style.name);
      const primary = fields[3];
      const outline = fields[5];
      const back = fields[6];
      expect(outline, style.name).toBe(back);
      expect(outline, style.name).not.toBe(primary);
    }
    expect(styleFields(ass, "Block")[5]).toBe("&H00FFFFFF");
    expect(styleFields(ass, "Stamp")[5]).toBe("&H0017FED1");
  });
});
