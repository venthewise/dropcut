/**
 * ffmpeg writes `-progress pipe:1` as `key=value` lines.
 * `out_time_us` is microseconds. `out_time_ms` is also microseconds in ffmpeg 6
 * (a long-standing bug), so it is ignored. `out_time` is a clock value.
 */

export function parseFfmpegProgress(line: string, totalSeconds: number): number | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (trimmed === "progress=end") return 1;
  if (!(totalSeconds > 0)) return null;
  const us = /^out_time_us=(\d+)$/.exec(trimmed);
  if (us) return clamp01(Number(us[1]) / 1_000_000 / totalSeconds);
  const clock = /^out_time=(\d+):(\d+):(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!clock) return null;
  const frac = clock[4] ? Number(clock[4]) / 10 ** clock[4].length : 0;
  const seconds = Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]) + frac;
  return clamp01(seconds / totalSeconds);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
