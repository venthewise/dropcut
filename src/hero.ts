import { prefersReduced } from "./motion";

const BPM = 120;
const BEAT = 60000 / BPM;
const DROP_EVERY = 4;
const STYLES = ["HIGH KEY", "INK", "ACID", "HALFTONE", "CROP", "STRIKE"];
const PRESETS = ["key", "ink", "acid", "halftone", "crop", "strike"];

export function startHero(): void {
  const reduced = prefersReduced();
  const root = document.documentElement;
  const reels = [...document.querySelectorAll<HTMLCanvasElement>(".js-reel")];
  const captions = [...document.querySelectorAll<HTMLElement>(".js-caption")];
  const tags = [...document.querySelectorAll<HTMLElement>(".js-style")];
  const waves = [...document.querySelectorAll<HTMLCanvasElement>(".js-wave")];
  const clocks = [...document.querySelectorAll<HTMLElement>(".js-time")];
  const start = performance.now();
  let lastBeat = -1;
  let frame = 0;

  function size(canvas: HTMLCanvasElement): { w: number; h: number } {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor((rect.width || canvas.width) * dpr));
    const h = Math.max(1, Math.floor((rect.height || canvas.height) * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return { w, h };
  }

  function tc(frames: number): string {
    const f = Math.floor(frames) % 24;
    const totalSec = Math.floor(frames / 24);
    const s = totalSec % 60;
    const m = Math.floor(totalSec / 60) % 60;
    const h = Math.floor(totalSec / 3600);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(h)}:${p(m)}:${p(s)}:${p(f)}`;
  }

  function drawPreset(ctx: CanvasRenderingContext2D, w: number, h: number, preset: string, isDrop: boolean): void {
    ctx.clearRect(0, 0, w, h);
    if (preset === "key") {
      ctx.fillStyle = isDrop ? "#d1fe17" : "#f4f1ea";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#0a0a0a";
      ctx.fillRect(w * 0.15, h * 0.2, w * 0.7, h * 0.55);
      ctx.strokeStyle = "#0a0a0a";
      ctx.lineWidth = 6;
      ctx.strokeRect(8, 8, w - 16, h - 16);
    } else if (preset === "ink") {
      ctx.fillStyle = "#0a0a0a";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#f4f1ea";
      ctx.beginPath();
      ctx.moveTo(0, h * 0.3);
      ctx.lineTo(w, h * 0.15);
      ctx.lineTo(w, h * 0.45);
      ctx.lineTo(0, h * 0.6);
      ctx.closePath();
      ctx.fill();
    } else if (preset === "acid") {
      ctx.fillStyle = "#0a0a0a";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#d1fe17";
      ctx.fillRect(0, h * 0.38, w, h * 0.24);
      ctx.fillStyle = isDrop ? "#f4f1ea" : "#0a0a0a";
      ctx.font = `800 ${Math.floor(w * 0.22)}px "Archivo Black", sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText("DROP", w / 2, h * 0.55);
    } else if (preset === "halftone") {
      ctx.fillStyle = "#f4f1ea";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#0a0a0a";
      const step = Math.max(8, w / 18);
      for (let y = 0; y < h; y += step) {
        for (let x = 0; x < w; x += step) {
          const dx = x / w - 0.5;
          const dy = y / h - 0.45;
          const r = Math.max(1, (1 - Math.sqrt(dx * dx + dy * dy) * 1.6) * step * 0.45);
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    } else if (preset === "crop") {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = "#0a0a0a";
      ctx.lineWidth = 2;
      ctx.strokeRect(w * 0.12, h * 0.12, w * 0.76, h * 0.76);
      ctx.beginPath();
      ctx.moveTo(0, 12);
      ctx.lineTo(24, 12);
      ctx.moveTo(12, 0);
      ctx.lineTo(12, 24);
      ctx.moveTo(w, 12);
      ctx.lineTo(w - 24, 12);
      ctx.moveTo(w - 12, 0);
      ctx.lineTo(w - 12, 24);
      ctx.stroke();
      ctx.fillStyle = "#0a0a0a";
      ctx.fillRect(w * 0.2, h * 0.3, w * 0.6, h * 0.35);
    } else {
      ctx.fillStyle = "#f4f1ea";
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = "#0a0a0a";
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.moveTo(w * 0.1, h * 0.2);
      ctx.lineTo(w * 0.9, h * 0.8);
      ctx.moveTo(w * 0.9, h * 0.2);
      ctx.lineTo(w * 0.1, h * 0.8);
      ctx.stroke();
      if (isDrop) {
        ctx.fillStyle = "#d1fe17";
        ctx.fillRect(0, h * 0.46, w, h * 0.08);
      }
    }
  }

  function drawWave(canvas: HTMLCanvasElement, beatF: number, dropI: number): void {
    const { w, h } = size(canvas);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#0a0a0a";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const t = x / w;
      const amp = Math.sin(t * 42) * 0.3 + Math.sin(t * 9 + beatF * 0.2) * 0.2;
      const y = h / 2 + amp * h * 0.7;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    [0.2, 0.45, 0.7, 0.9].forEach((p, i) => {
      const x = p * w;
      ctx.strokeStyle = dropI % 4 === i ? "#d1fe17" : "#0a0a0a";
      ctx.lineWidth = dropI % 4 === i ? 4 : 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillStyle = "#0a0a0a";
      ctx.font = "11px IBM Plex Mono, monospace";
      ctx.fillText("X", x + 4, 12);
    });
  }

  function paint(now: number, animate: boolean): void {
    const beatF = (now - start) / BEAT;
    const beatI = Math.floor(beatF);
    const dropI = Math.floor(beatI / DROP_EVERY);
    const phase = beatF - beatI;
    const onBeat = phase < 0.18;
    const isDrop = beatI % DROP_EVERY === 0 && onBeat;
    const frames = (now - start) / (1000 / 24);
    if (animate) root.classList.toggle("on-drop", isDrop);
    for (const el of clocks) el.textContent = animate ? tc(frames) : "00:00:00:00";
    if (animate && beatI !== lastBeat) {
      lastBeat = beatI;
      for (const el of captions) {
        const local = beatI + (Number(el.dataset.offset) || 0);
        el.textContent = local % DROP_EVERY === 0 ? "DROP" : "HOLD";
      }
      tags.forEach((el, i) => {
        el.textContent = STYLES[(dropI + i) % STYLES.length] ?? STYLES[0]!;
      });
    }
    reels.forEach((canvas, i) => {
      const { w, h } = size(canvas);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const preset = canvas.dataset.preset || PRESETS[(dropI + (canvas.dataset.hero ? 0 : i)) % PRESETS.length] || "key";
      const hit = Boolean(canvas.dataset.hero) ? isDrop : (dropI + i) % 4 === 0 && onBeat;
      drawPreset(ctx, w, h, preset, animate && hit);
    });
    for (const canvas of waves) drawWave(canvas, animate ? beatF : 0, animate ? dropI : 0);
    if (animate) frame = window.requestAnimationFrame((t) => paint(t, true));
  }

  if (reduced) {
    root.classList.add("reduced");
    paint(start, false);
    return;
  }
  frame = window.requestAnimationFrame((t) => paint(t, true));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) window.cancelAnimationFrame(frame);
    else frame = window.requestAnimationFrame((t) => paint(t, true));
  });
}
