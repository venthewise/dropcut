import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExportResponse } from "../../shared/api-types";
import type { Config } from "../config";
import { editSegment, sha256, type JobStore, type StoredJob } from "../jobs/store";
import { assemble } from "./assemble";
import type { ResolvedBinary } from "./binaries";
import { exportCacheKey, type ExportKeyRow } from "./key";
import { EXPORT_FADE_SECONDS } from "./graph";
import { EXPORT_HEIGHT, EXPORT_WIDTH } from "./ass";

export class ExportError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ExportError";
    this.status = status;
  }
}

interface ExportRecord {
  key: string;
  status: "running" | "done" | "failed";
  progress: number;
  error?: string;
  fps: number;
  duration: number;
  songDuration: number;
  filename: string;
  updatedAt: string;
}

export interface ExportManagerDeps {
  store: JobStore;
  cfg: Config;
  ffmpeg: () => Promise<ResolvedBinary | null>;
}

const FILENAME = "reel.mp4";

/**
 * One export at a time per job. The MP4 and its manifest live in
 * `outputs/<job>/export/`. A finished file is reused when the hash of
 * segment cache keys, cut-list timing and captions, the song bytes, and the
 * export settings still matches.
 */
export class ExportManager {
  private readonly live = new Map<string, ExportRecord>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly wroteAt = new Map<string, number>();

  constructor(private readonly deps: ExportManagerDeps) {}

  async status(jobId: string): Promise<ExportResponse> {
    if (!this.deps.store.get(jobId)) throw new ExportError(404, "Job not found.");
    const live = this.live.get(jobId);
    if (live) return this.publicView(jobId, live);
    const disk = await this.readRecord(jobId);
    if (!disk) return this.idle();
    if (disk.status === "running" && !this.running.has(jobId)) {
      disk.status = "failed";
      disk.error = "Export was interrupted.";
      this.live.set(jobId, disk);
      await this.writeRecord(jobId, disk);
    } else {
      this.live.set(jobId, disk);
    }
    return this.publicView(jobId, this.live.get(jobId)!);
  }

  async start(jobId: string, captions?: Record<string, string>): Promise<ExportResponse> {
    return this.enqueue(jobId, async () => {
      const job = this.deps.store.get(jobId);
      if (!job) throw new ExportError(404, "Job not found.");
      if (this.running.has(jobId)) return this.publicView(jobId, this.live.get(jobId)!);
      this.assertReady(job);
      this.applyCaptions(job, captions);
      const songPath = path.join(this.deps.store.root, job.id, job.audioFile!);
      const songHash = sha256(await readFile(songPath));
      const settings = this.settings();
      const songDuration = job.cutlist.clipEnd - job.cutlist.clipStart;
      const recordKey = exportCacheKey({
        segmentCacheKeys: job.segments.map((segment) => segment.cacheKey),
        rows: rowsOf(job),
        songSha256: songHash,
        fps: settings.fps,
        width: EXPORT_WIDTH,
        height: EXPORT_HEIGHT,
        endCardUrl: settings.endCardUrl,
        endCardSeconds: settings.endCardSeconds,
        fadeSeconds: EXPORT_FADE_SECONDS,
      });
      const existing = this.live.get(jobId) ?? (await this.readRecord(jobId));
      const outputPath = this.outputPath(jobId);
      if (existing && existing.key === recordKey && existing.status === "done" && (await exists(outputPath))) {
        existing.status = "done";
        existing.progress = 1;
        existing.filename = FILENAME;
        this.live.set(jobId, existing);
        return { ...this.publicView(jobId, existing), cached: true };
      }
      if (captions && Object.keys(captions).length > 0) await this.deps.store.save(job);
      const ffmpeg = await this.deps.ffmpeg();
      if (!ffmpeg) {
        throw new ExportError(
          500,
          "ffmpeg was not found. Set FFMPEG_PATH, install ffmpeg on PATH, or reinstall so ffmpeg-static is present.",
        );
      }
      const record: ExportRecord = {
        key: recordKey,
        status: "running",
        progress: 0,
        fps: settings.fps,
        duration: songDuration + settings.endCardSeconds,
        songDuration,
        filename: FILENAME,
        updatedAt: new Date().toISOString(),
      };
      this.live.set(jobId, record);
      await this.writeRecord(jobId, record);
      const task = this.execute(job, songPath, outputPath, record, ffmpeg.path);
      this.running.set(jobId, task);
      void task.finally(() => {
        if (this.running.get(jobId) === task) this.running.delete(jobId);
      });
      return this.publicView(jobId, record);
    });
  }

  async file(jobId: string): Promise<string | null> {
    const view = await this.status(jobId);
    if (view.status !== "done") return null;
    const output = this.outputPath(jobId);
    return (await exists(output)) ? output : null;
  }

  private async execute(job: StoredJob, songPath: string, outputPath: string, record: ExportRecord, ffmpegPath: string): Promise<void> {
    const settings = this.settings();
    const ordered = [...job.cutlist.segments].sort((a, b) => a.start - b.start);
    try {
      await assemble({
        ffmpegPath,
        audioPath: songPath,
        clipStart: job.cutlist.clipStart,
        songDuration: record.songDuration,
        outputPath,
        workDir: path.join(this.exportDir(job.id), "work"),
        fps: settings.fps,
        endCardUrl: settings.endCardUrl,
        endCardSeconds: settings.endCardSeconds,
        captions: ordered.map((segment) => ({
          start: segment.start,
          end: segment.end,
          caption: segment.caption,
          captionStyle: segment.captionStyle,
        })),
        segments: ordered.map((segment) => {
          const stored = job.segments.find((item) => item.id === segment.id);
          if (!stored?.filename) throw new Error(`Segment ${segment.id} has no file.`);
          return {
            id: segment.id,
            filePath: this.deps.store.segmentAbs(job.id, stored.filename),
            contentType: stored.contentType || "application/octet-stream",
            filename: stored.filename,
            duration: segment.end - segment.start,
            transition: segment.transition,
          };
        }),
        onProgress: (progress) => {
          record.progress = progress;
          record.updatedAt = new Date().toISOString();
          const now = Date.now();
          const last = this.wroteAt.get(job.id) ?? 0;
          if (progress >= 1 || now - last > 200) {
            this.wroteAt.set(job.id, now);
            void this.writeRecord(job.id, record).catch(() => undefined);
          }
        },
      });
      record.status = "done";
      record.progress = 1;
      record.error = undefined;
    } catch (err) {
      record.status = "failed";
      record.error = err instanceof Error ? err.message : "Export failed.";
    }
    record.updatedAt = new Date().toISOString();
    await this.writeRecord(job.id, record);
  }

  private assertReady(job: StoredJob): void {
    if (job.segments.some((segment) => segment.status !== "done" || !segment.filename)) {
      throw new ExportError(409, "Export needs every segment to be done.");
    }
    if (!job.audioFile || job.audioFile.includes("..") || path.isAbsolute(job.audioFile)) {
      throw new ExportError(400, "Export needs the song file on the job.");
    }
  }

  private applyCaptions(job: StoredJob, captions: Record<string, string> | undefined): void {
    if (!captions) return;
    for (const id of Object.keys(captions)) {
      if (!job.segments.some((segment) => segment.id === id)) {
        throw new ExportError(400, `Unknown segment ${id}.`);
      }
    }
    for (const [id, caption] of Object.entries(captions)) {
      try {
        editSegment(job, id, { caption });
      } catch (err) {
        throw new ExportError(400, err instanceof Error ? err.message : "A caption edit was rejected.");
      }
    }
  }

  private settings(): { fps: 24 | 30; endCardUrl: string; endCardSeconds: number } {
    const endCardUrl = this.deps.cfg.exportEndCardUrl;
    return {
      fps: this.deps.cfg.exportFps,
      endCardUrl,
      endCardSeconds: endCardUrl ? this.deps.cfg.exportEndCardSeconds : 0,
    };
  }

  private idle(): ExportResponse {
    return { status: "idle", progress: 0, fps: this.deps.cfg.exportFps };
  }

  private publicView(jobId: string, record: ExportRecord): ExportResponse {
    return {
      status: record.status,
      progress: record.progress,
      error: record.error,
      fps: record.fps,
      duration: record.duration,
      songDuration: record.songDuration,
      fileUrl: record.status === "done" ? `/api/jobs/${jobId}/export/file` : undefined,
    };
  }

  private exportDir(jobId: string): string {
    return path.join(this.deps.store.root, jobId, "export");
  }

  private outputPath(jobId: string): string {
    return path.join(this.exportDir(jobId), FILENAME);
  }

  private async readRecord(jobId: string): Promise<ExportRecord | null> {
    try {
      const raw = await readFile(path.join(this.exportDir(jobId), "export.json"), "utf8");
      const parsed = JSON.parse(raw) as ExportRecord;
      if (!parsed || typeof parsed.key !== "string" || typeof parsed.status !== "string") return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private async writeRecord(jobId: string, record: ExportRecord): Promise<void> {
    const dir = this.exportDir(jobId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "export.json"), JSON.stringify(record, null, 2));
  }

  private enqueue<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(jobId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.tails.set(jobId, run.then(() => undefined, () => undefined));
    return run;
  }
}

function rowsOf(job: StoredJob): ExportKeyRow[] {
  return job.cutlist.segments.map((segment) => ({
    id: segment.id,
    start: segment.start,
    end: segment.end,
    caption: segment.caption,
    captionStyle: segment.captionStyle,
    transition: segment.transition,
  }));
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
