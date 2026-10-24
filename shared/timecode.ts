export function formatTimecode(seconds: number, fps = 24): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const framesTotal = Math.round(safe * fps);
  const f = framesTotal % fps;
  const totalSec = Math.floor(framesTotal / fps);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(h)}:${p(m)}:${p(s)}:${p(f)}`;
}

export function formatSeconds(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  return safe.toFixed(2) + "s";
}
