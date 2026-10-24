import { lookById } from "../../shared/looks";
import { formatTimecode } from "../../shared/timecode";

function esc(value: string): string {
  return value.replace(/[&<>"]/g, (ch) => {
    if (ch === "&") return "&amp;";
    if (ch === "<") return "&lt;";
    if (ch === ">") return "&gt;";
    return "&quot;";
  });
}

export function renderPlaceholderSvg(opts: {
  look: string;
  seed: number;
  segmentId: string;
  start: number;
}): string {
  const look = lookById(opts.look);
  const bg = look?.bg ?? "#0a0a0a";
  const fg = look?.fg ?? "#f4f1ea";
  const accent = look?.accent ?? "#d1fe17";
  const plate = look?.plate ?? opts.look.toUpperCase();
  const shift = (Math.abs(opts.seed) % 70) + 20;
  const tc = formatTimecode(opts.start);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 640" width="360" height="640" role="img" data-look="${esc(opts.look)}">
  <style>
    @media (prefers-reduced-motion: no-preference) {
      .pulse { animation: dropcut-pulse 1.2s ease-in-out infinite; }
      @keyframes dropcut-pulse { 50% { opacity: 0.55; } }
    }
  </style>
  <rect width="360" height="640" fill="${bg}"/>
  <rect class="pulse" x="18" y="18" width="324" height="604" fill="none" stroke="${fg}" stroke-width="4"/>
  <rect x="${shift}" y="160" width="180" height="260" fill="${accent}"/>
  <rect x="40" y="80" width="280" height="16" fill="${fg}"/>
  <text x="180" y="470" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-size="48" fill="${fg}">${esc(plate)}</text>
  <text x="24" y="600" font-family="ui-monospace, Consolas, monospace" font-size="14" fill="${fg}">${esc(opts.segmentId)}  ${esc(tc)}</text>
</svg>`;
}
