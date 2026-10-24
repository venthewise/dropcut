export interface WaveView {
  envelope: number[];
  duration: number;
  beats: number[];
  drops: number[];
  trimStart: number;
  trimEnd: number;
  playhead?: number;
}

export function drawWaveform(canvas: HTMLCanvasElement, view: WaveView): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.floor((rect.width || 720) * dpr));
  const h = Math.max(1, Math.floor((rect.height || 140) * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  const duration = view.duration > 0 ? view.duration : 1;
  const xAt = (time: number) => (time / duration) * w;

  ctx.fillStyle = "rgba(10,10,10,0.08)";
  ctx.fillRect(0, 0, xAt(view.trimStart), h);
  ctx.fillRect(xAt(view.trimEnd), 0, Math.max(0, w - xAt(view.trimEnd)), h);

  const env = view.envelope.length > 0 ? view.envelope : [0.2];
  ctx.beginPath();
  ctx.strokeStyle = "#0a0a0a";
  ctx.lineWidth = Math.max(1, dpr);
  const mid = h / 2;
  for (let i = 0; i < env.length; i++) {
    const x = (i / Math.max(1, env.length - 1)) * w;
    const amp = (env[i] ?? 0) * h * 0.42;
    const y = mid - amp;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  for (let i = env.length - 1; i >= 0; i--) {
    const x = (i / Math.max(1, env.length - 1)) * w;
    const amp = (env[i] ?? 0) * h * 0.42;
    ctx.lineTo(x, mid + amp);
  }
  ctx.closePath();
  ctx.stroke();

  for (const beat of view.beats) {
    ctx.strokeStyle = "rgba(10,10,10,0.28)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(xAt(beat), 0);
    ctx.lineTo(xAt(beat), h);
    ctx.stroke();
  }

  ctx.font = `${Math.round(11 * dpr)}px "IBM Plex Mono", ui-monospace, monospace`;
  ctx.textBaseline = "top";
  for (const drop of view.drops) {
    const x = xAt(drop);
    ctx.strokeStyle = "#d1fe17";
    ctx.lineWidth = Math.max(2, 3 * dpr * 0.5);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.fillStyle = "#0a0a0a";
    ctx.fillText("X", x + 4 * dpr, 4 * dpr);
  }

  if (view.playhead != null && Number.isFinite(view.playhead)) {
    ctx.strokeStyle = "#0a0a0a";
    ctx.lineWidth = Math.max(2, dpr);
    ctx.beginPath();
    ctx.moveTo(xAt(view.playhead), 0);
    ctx.lineTo(xAt(view.playhead), h);
    ctx.stroke();
  }
}
