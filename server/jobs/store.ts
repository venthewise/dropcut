import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JobStatusName, SegmentStatusName } from "../../shared/api-types";
import type { CutSegment, Cutlist } from "../../shared/cutlist";
import { lookById, renderPrompt } from "../../shared/looks";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StoredPhoto {
  index: number;
  filename: string;
  contentType: string;
  sha256: string;
  storedName: string;
}

export interface StoredSegment {
  id: string;
  cacheKey: string;
  status: SegmentStatusName;
  progress: number;
  error?: string;
  contentType?: string;
  filename?: string;
  attempt: number;
  remoteJobId?: string;
  idempotencyKey: string;
  look: string;
  transition: string;
  caption: string;
  start: number;
  end: number;
  photoIndex: number;
}

export interface StoredJob {
  id: string;
  createdAt: string;
  updatedAt: string;
  backend: string;
  status: JobStatusName;
  progress: number;
  error?: string;
  cutlist: Cutlist;
  photos: StoredPhoto[];
  segments: StoredSegment[];
  audioFile?: string;
  deployment?: import("../../shared/api-types").DeploymentView;
}

export interface IncomingPhoto {
  filename: string;
  contentType: string;
  bytes: Buffer;
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Cache key = hash of photo bytes + look + prompt + seed + duration. */
export function segmentCacheKey(parts: {
  photoHash: string;
  look: string;
  prompt: string;
  seed: number;
  durationMs: number;
}): string {
  return sha256(
    Buffer.from(JSON.stringify([parts.photoHash, parts.look, parts.prompt, parts.seed, parts.durationMs])),
  );
}

export function extFor(contentType: string): string {
  const type = contentType.toLowerCase();
  if (type.includes("svg")) return ".svg";
  if (type.includes("png")) return ".png";
  if (type.includes("jpeg") || type.includes("jpg")) return ".jpg";
  if (type.includes("webp")) return ".webp";
  if (type.includes("mp4")) return ".mp4";
  if (type.includes("webm")) return ".webm";
  if (type.includes("gif")) return ".gif";
  if (type.includes("wav")) return ".wav";
  if (type.includes("mpeg") || type.includes("mp3")) return ".mp3";
  if (type.includes("mp4") || type.includes("m4a")) return ".m4a";
  return ".bin";
}

export function rollup(job: StoredJob): void {
  const segments = job.segments;
  if (segments.length === 0) {
    job.progress = 0;
    job.status = "queued";
    job.updatedAt = new Date().toISOString();
    return;
  }
  const progress =
    segments.reduce((sum, seg) => {
      if (seg.status === "done" || seg.status === "failed") return sum + 1;
      if (seg.status === "running") return sum + Math.min(0.95, Math.max(0.05, seg.progress || 0.1));
      return sum;
    }, 0) / segments.length;
  job.progress = progress;
  const inflight = segments.some((seg) => seg.status === "queued" || seg.status === "running");
  const allDone = segments.every((seg) => seg.status === "done");
  const anyFailed = segments.some((seg) => seg.status === "failed");
  job.status = allDone ? "done" : inflight ? "running" : anyFailed ? "failed" : "queued";
  if (allDone) job.error = undefined;
  job.updatedAt = new Date().toISOString();
}

export interface SegmentEdit {
  /** Replaces the row's look and the rendered prompt. A new cache key requeues only this row. */
  look?: string;
  /** Burn-in text. Does not change the segment cache key or the plate file. */
  caption?: string;
}

/**
 * Edit one cut-list row in place.
 * A caption change keeps the finished plate. A look change recomputes the
 * cache key and, on a miss, queues that row so the runner regenerates it.
 * Other rows stay done and are not submitted again.
 */
export function editSegment(job: StoredJob, segmentId: string, edit: SegmentEdit): { requeued: boolean } {
  const cut = job.cutlist.segments.find((seg) => seg.id === segmentId);
  const stored = job.segments.find((seg) => seg.id === segmentId);
  if (!cut || !stored) throw new Error(`Unknown segment ${segmentId}.`);
  let captionChanged = false;
  if (edit.caption != null && edit.caption !== stored.caption) {
    if (edit.caption.length > 80) throw new Error("Caption is too long.");
    cut.caption = edit.caption;
    stored.caption = edit.caption;
    captionChanged = true;
  }
  let requeued = false;
  if (edit.look != null && edit.look !== cut.look) {
    if (!lookById(edit.look)) throw new Error(`Unknown look ${edit.look}.`);
    const prompt = renderPrompt(edit.look);
    cut.look = edit.look;
    cut.prompt = prompt.positive;
    cut.negativePrompt = prompt.negative;
    stored.look = edit.look;
    const photo = job.photos.find((item) => item.index === stored.photoIndex);
    if (!photo) throw new Error(`Segment ${segmentId} has no photo.`);
    const nextKey = segmentCacheKey({
      photoHash: photo.sha256,
      look: cut.look,
      prompt: cut.prompt,
      seed: cut.seed,
      durationMs: Math.round(cut.duration * 1000),
    });
    if (nextKey !== stored.cacheKey) {
      stored.cacheKey = nextKey;
      stored.status = "queued";
      stored.progress = 0;
      stored.error = undefined;
      stored.filename = undefined;
      stored.contentType = undefined;
      stored.remoteJobId = undefined;
      stored.attempt += 1;
      stored.idempotencyKey = randomUUID();
      requeued = true;
    }
  }
  if (requeued || captionChanged) rollup(job);
  return { requeued };
}

function segmentFromCut(seg: CutSegment, photoHash: string): StoredSegment {
  const durationMs = Math.round(seg.duration * 1000);
  return {
    id: seg.id,
    cacheKey: segmentCacheKey({
      photoHash,
      look: seg.look,
      prompt: seg.prompt,
      seed: seg.seed,
      durationMs,
    }),
    status: "queued",
    progress: 0,
    attempt: 1,
    idempotencyKey: randomUUID(),
    look: seg.look,
    transition: seg.transition,
    caption: seg.caption,
    start: seg.start,
    end: seg.end,
    photoIndex: seg.photoIndex,
  };
}

export class JobStore {
  private jobs = new Map<string, StoredJob>();
  private writes = new Map<string, Promise<void>>();

  constructor(readonly root: string) {}

  async load(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(path.join(this.root, "cache"), { recursive: true });
    let entries: { name: string; isDirectory: () => boolean }[] = [];
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "cache" || !UUID_RE.test(entry.name)) continue;
      try {
        const raw = await readFile(path.join(this.root, entry.name, "manifest.json"), "utf8");
        const job = JSON.parse(raw) as StoredJob;
        if (job && job.id === entry.name && Array.isArray(job.segments)) this.jobs.set(job.id, job);
      } catch {
        // Leave a corrupt folder alone. The next job id will not reuse it.
      }
    }
  }

  get(id: string): StoredJob | undefined {
    return this.jobs.get(id);
  }

  all(): StoredJob[] {
    return [...this.jobs.values()];
  }

  async create(input: { backend: string; cutlist: Cutlist; photos: IncomingPhoto[]; audio?: IncomingPhoto }): Promise<StoredJob> {
    const id = randomUUID();
    const photos: StoredPhoto[] = [];
    for (let index = 0; index < input.photos.length; index++) {
      const photo = input.photos[index]!;
      const hash = sha256(photo.bytes);
      const storedName = `${index}${extFor(photo.contentType)}`;
      photos.push({
        index,
        filename: photo.filename,
        contentType: photo.contentType,
        sha256: hash,
        storedName,
      });
      const dir = path.join(this.root, id, "photos");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, storedName), photo.bytes);
    }
    const now = new Date().toISOString();
    const job: StoredJob = {
      id,
      createdAt: now,
      updatedAt: now,
      backend: input.backend,
      status: "queued",
      progress: 0,
      cutlist: input.cutlist,
      photos,
      segments: input.cutlist.segments.map((seg) => {
        const photo = photos[seg.photoIndex];
        if (!photo) throw new Error(`Segment ${seg.id} has no photo.`);
        return segmentFromCut(seg, photo.sha256);
      }),
    };
    if (input.audio) {
      const audioExt = extFor(input.audio.contentType);
      const audioName = `audio${audioExt === ".bin" ? ".wav" : audioExt}`;
      await mkdir(path.join(this.root, id), { recursive: true });
      await writeFile(path.join(this.root, id, audioName), input.audio.bytes);
      job.audioFile = audioName;
    }
    this.jobs.set(id, job);
    await this.save(job);
    return job;
  }

  async readPhoto(jobId: string, photo: StoredPhoto): Promise<Buffer> {
    return readFile(path.join(this.root, jobId, "photos", photo.storedName));
  }

  async readCache(cacheKey: string): Promise<{ bytes: Buffer; contentType: string } | null> {
    if (!/^[a-f0-9]{64}$/.test(cacheKey)) return null;
    const bin = path.join(this.root, "cache", `${cacheKey}.bin`);
    const metaPath = path.join(this.root, "cache", `${cacheKey}.json`);
    try {
      const [bytes, metaRaw] = await Promise.all([readFile(bin), readFile(metaPath, "utf8")]);
      const meta = JSON.parse(metaRaw) as { contentType?: string };
      return { bytes, contentType: meta.contentType || "application/octet-stream" };
    } catch {
      return null;
    }
  }

  async writeSegment(jobId: string, seg: StoredSegment, bytes: Buffer, contentType: string): Promise<void> {
    const filename = `${seg.id}${extFor(contentType)}`;
    const dir = path.join(this.root, jobId, "segments");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, filename), bytes);
    const cacheDir = path.join(this.root, "cache");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(path.join(cacheDir, `${seg.cacheKey}.bin`), bytes);
    await writeFile(path.join(cacheDir, `${seg.cacheKey}.json`), JSON.stringify({ contentType }));
    seg.filename = filename;
    seg.contentType = contentType;
  }

  segmentAbs(jobId: string, filename: string): string {
    if (!/^[a-z0-9._-]+$/i.test(filename)) throw new Error("Bad segment filename.");
    return path.join(this.root, jobId, "segments", path.basename(filename));
  }

  save(job: StoredJob): Promise<void> {
    const prev = this.writes.get(job.id) ?? Promise.resolve();
    const next = prev.then(() => this.writeManifest(job));
    this.writes.set(
      job.id,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  private async writeManifest(job: StoredJob): Promise<void> {
    const dir = path.join(this.root, job.id);
    await mkdir(dir, { recursive: true });
    const target = path.join(dir, "manifest.json");
    const tmp = path.join(dir, "manifest.json.tmp");
    await writeFile(tmp, JSON.stringify(job, null, 2));
    await writeFile(target, await readFile(tmp));
  }
}
