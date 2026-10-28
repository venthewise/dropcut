import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ASS_STYLES, SAFE_MARGIN_BOTTOM, SAFE_MARGIN_TOP, SAFE_MARGIN_X, buildAss, captionFontsDir, escapeAssText, formatAssTime } from "./ass";

function styleFields(ass: string, name: string): string[] {
  const line = ass.split(/\n/).find((item) => item.startsWith(`Style: ${name},`));
  expect(line, name).toBeTruthy();
  return line!.slice("Style: ".length).split(",");
}

function eventText(ass: string, style: string): string[] {
  const marker = `,${style},,0,0,0,,`;
  return ass
    .split(/\n/)
    .filter((line) => line.includes(marker))
    .map((line) => line.slice(line.indexOf(marker) + marker.length));
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
    expect(boxed.map((style) => style.id).sort()).toEqual(["block", "lower", "promo", "stamp"]);
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
    const promo = styleFields(ass, "Promo");
    expect(promo[1]).toBe("Anton");
    expect(promo[3]).toBe("&H00FFFFFF");
    expect(promo[5]).toBe("&H000045FF");
    expect(promo[6]).toBe("&H000045FF");
    expect(promo[14]).toBe("-6");
    expect(promo[15]).toBe("3");
  });

  it("keeps the other style lines unchanged", () => {
    const ass = buildAss({ clipStart: 0, captions: [] });
    expect(ass).toContain("Style: Block,Archivo Black,64,&H00000000,&H00000000,&H00FFFFFF,&H00FFFFFF,0,0,0,0,100,100,0,0,3,18,0,2,90,90,420,1");
    expect(ass).toContain("Style: Stamp,Archivo Black,48,&H00000000,&H00000000,&H0017FED1,&H0017FED1,0,0,0,0,100,100,0,0,3,14,0,7,90,90,250,1");
    expect(ass).toContain("Style: Lower,Archivo Black,52,&H00000000,&H00000000,&H00FFFFFF,&H00FFFFFF,0,0,0,0,100,100,0,0,3,14,0,1,90,240,420,1");
    expect(ass).toContain("Style: Kick,Archivo Black,108,&H00FFFFFF,&H00000000,&H00000000,&H0017FED1,0,0,0,0,100,100,0,0,1,8,0,2,90,90,460,1");
    expect(ass).toContain("Style: EndCard,Archivo Black,54,&H0017FED1,&H00000000,&H000A0A0A,&H00000000,0,0,0,0,100,100,0,0,1,6,0,5,90,90,250,1");
  });

  it("draws Promo as a tilted pop-in badge, including a smaller second line", () => {
    const once = buildAss({
      clipStart: 0,
      captions: [
        { start: 0, end: 1, caption: "Latte + croissant | $4.50", captionStyle: "promo" },
        { start: 1, end: 2, caption: "hello\nworld", captionStyle: "promo" },
        { start: 2, end: 3, caption: "drop", captionStyle: "promo" },
        { start: 3, end: 4, caption: "a{b}\\c", captionStyle: "promo" },
        { start: 4, end: 5, caption: "M".repeat(20), captionStyle: "promo" },
        { start: 5, end: 6, caption: " | $4.50", captionStyle: "promo" },
        { start: 6, end: 7, caption: "top | mid\nbottom", captionStyle: "promo" },
      ],
    });
    expect(once).toBe(buildAss({
      clipStart: 0,
      captions: [
        { start: 0, end: 1, caption: "Latte + croissant | $4.50", captionStyle: "promo" },
        { start: 1, end: 2, caption: "hello\nworld", captionStyle: "promo" },
        { start: 2, end: 3, caption: "drop", captionStyle: "promo" },
        { start: 3, end: 4, caption: "a{b}\\c", captionStyle: "promo" },
        { start: 4, end: 5, caption: "M".repeat(20), captionStyle: "promo" },
        { start: 5, end: 6, caption: " | $4.50", captionStyle: "promo" },
        { start: 6, end: 7, caption: "top | mid\nbottom", captionStyle: "promo" },
      ],
    }));
    const [price, stacked, single, escaped, wide, orphan, pipeFirst] = eventText(once, "Promo");
    const pop = "\\fscx52\\fscy52\\t(0,110,\\fscx118\\fscy118)\\t(110,200,\\fscx100\\fscy100)";
    expect(price).toBe(`{\\q2\\fs168${pop}}LATTE + CROISSANT\\N{\\fs84}$4.50`);
    expect(stacked).toBe(`{\\q2\\fs168${pop}}HELLO\\N{\\fs84}WORLD`);
    expect(single).toBe(`{\\q2\\fs168${pop}}DROP`);
    expect(single).not.toContain("\\N");
    expect(escaped).toContain("A\\{B\\}\\\\C");
    expect(escaped).not.toContain("A{B}");
    expect(wide).toBe(`{\\q2\\fs84${pop}}${"M".repeat(20)}`);
    expect(Number(wide.match(/\\fs(\d+)/)?.[1])).toBeLessThan(168);
    expect(orphan).toBe(`{\\q2\\fs168${pop}}$4.50`);
    expect(pipeFirst).toBe(`{\\q2\\fs168${pop}}TOP\\N{\\fs84}MID BOTTOM`);
  });

  it("ships Anton next to the other caption fonts, with its SIL OFL license outside fontsdir", () => {
    const fontsDir = captionFontsDir();
    const names = readdirSync(fontsDir);
    expect(names).toContain("Anton-Regular.ttf");
    expect(names).toContain("ArchivoBlack-Regular.ttf");
    expect(names.every((name) => /\.(ttf|otf|ttc)$/i.test(name))).toBe(true);
    const font = readFileSync(path.join(fontsDir, "Anton-Regular.ttf"));
    expect(font.readUInt32BE(0)).toBe(0x00010000);
    const anton = Buffer.alloc(10);
    for (let i = 0; i < 5; i++) anton.writeUInt16BE("Anton".charCodeAt(i), i * 2);
    expect(font.includes(anton)).toBe(true);
    const license = readFileSync(path.resolve("server/export/Anton-OFL.txt"), "utf8");
    expect(license).toContain("SIL Open Font License");
    expect(license).toContain("Version 1.1");
    expect(license).toContain("Anton");
    expect(names).not.toContain("Anton-OFL.txt");
  });
});
