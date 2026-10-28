import { randomUUID } from "node:crypto";
import type { Config } from "../config";
import { redact } from "../config";
import { GenerationError } from "../generation/errors";
import { pickOutput } from "../generation/comfy-cloud";
import type { GenerationAdapter, SegmentStatus } from "../generation/types";
import type { LoadedWorkflow } from "../generation/workflow";
import { isVideo, stripAudio } from "../generation/strip-audio";
import type { DeploymentController } from "../deploy/controller";
import { JobStore, rollup, type StoredJob, type StoredSegment } from "./store";

export interface RunnerDeps {
  store: JobStore;
  adapter: GenerationAdapter;
  cfg: Config;
  workflow: LoadedWorkflow;
  /** Set when the comfy-cloud backend runs on a Comfy deployment (COMFY_DEPLOYMENT_ID). */
  deployment?: DeploymentController;
  /** Resolved ffmpeg used to strip workflow audio. Omitted uses `ffmpeg` on PATH. */
  ffmpegPath?: string;
}

const ACCOUNT_CODES = new Set(["bad_key", "no_credits", "subscription"]);

export class Runner {
  private inflight = new Map<string, Promise<void>>();
  private aborts = new Map<string, AbortController>();

  constructor(private readonly deps: RunnerDeps) {}

  run(jobId: string): Promise<void> {
    const existing = this.inflight.get(jobId);
    if (existing) return existing.then(() => this.runIfQueued(jobId), () => this.runIfQueued(jobId));
    return this.start(jobId);
  }

  /** Start a pass when this job is idle and a row is still queued. */
  private runIfQueued(jobId: string): Promise<void> {
    if (this.inflight.has(jobId)) return this.inflight.get(jobId)!;
    const job = this.deps.store.get(jobId);
    if (!job?.segments.some((seg) => seg.status === "queued")) return Promise.resolve();
    return this.start(jobId);
  }

  private start(jobId: string): Promise<void> {
    const existing = this.inflight.get(jobId);
    if (existing) return existing;
    const controller = new AbortController();
    this.aborts.set(jobId, controller);
    const task = this.execute(jobId, controller.signal).finally(() => {
      if (this.inflight.get(jobId) === task) {
        this.inflight.delete(jobId);
        this.aborts.delete(jobId);
      }
    });
    this.inflight.set(jobId, task);
    return task;
  }

  async resumeIncomplete(): Promise<void> {
    for (const job of this.deps.store.all()) {
      let dirty = false;
      for (const seg of job.segments) {
        if (seg.status === "running") {
          seg.status = "queued";
          seg.progress = 0;
          seg.remoteJobId = undefined;
          dirty = true;
        }
      }
      if (dirty) {
        rollup(job);
        await this.deps.store.save(job);
      }
      if (job.segments.some((seg) => seg.status === "queued")) {
        void this.run(job.id);
      }
    }
  }

  async cancel(jobId: string): Promise<void> {
    this.aborts.get(jobId)?.abort();
    const job = this.deps.store.get(jobId);
    if (!job) return;
    for (const seg of job.segments) {
      const status = seg.status;
      if (status === "queued") {
        seg.status = "failed";
        seg.error = "Cancelled";
      }
      if (seg.remoteJobId && (status === "running" || status === "queued")) {
        void this.deps.adapter.cancel({ id: seg.remoteJobId, adapter: this.deps.adapter.name }).catch(() => undefined);
      }
    }
    rollup(job);
    await this.deps.store.save(job);
  }

  queueRetry(job: StoredJob, segmentIds?: string[]): number {
    let count = 0;
    for (const seg of job.segments) {
      const picked = !segmentIds || segmentIds.includes(seg.id);
      if (!picked || seg.status !== "failed") continue;
      seg.status = "queued";
      seg.progress = 0;
      seg.error = undefined;
      seg.remoteJobId = undefined;
      seg.attempt += 1;
      seg.idempotencyKey = randomUUID();
      count += 1;
    }
    if (count > 0) {
      job.error = undefined;
      rollup(job);
    }
    return count;
  }

  private async execute(jobId: string, signal: AbortSignal): Promise<void> {
    const job = this.deps.store.get(jobId);
    if (!job) return;
    const todo = job.segments.filter((seg) => seg.status === "queued");
    const deployment = this.deps.deployment;
    let acquired = false;
    if (deployment && todo.length > 0 && (await this.needsGpu(todo))) {
      deployment.acquire();
      acquired = true;
      try {
        const ready = await deployment.ensureReady((view) => {
          job.deployment = view;
          rollup(job);
          void this.deps.store.save(job).catch(() => undefined);
        }, signal);
        job.deployment = ready;
        await this.deps.store.save(job);
      } catch (err) {
        deployment.release();
        const message = redact(err instanceof Error ? err.message : "The GPU deployment did not start.", this.deps.cfg.comfyApiKey);
        if (!signal.aborted) {
          job.error = message;
          for (const seg of job.segments) {
            if (seg.status === "queued") {
              seg.status = "failed";
              seg.error = message;
            }
          }
        }
        job.deployment = deployment.snapshot();
        rollup(job);
        await this.deps.store.save(job);
        return;
      }
    }
    try {
      // A look edit during this pass queues one row. Keep going until none are left.
      while (!signal.aborted) {
        const live = this.deps.store.get(jobId);
        if (!live) return;
        const pending = live.segments.filter((seg) => seg.status === "queued");
        if (pending.length === 0) break;
        await this.runTodo(live, pending, signal);
      }
    } finally {
      if (acquired && deployment) {
        deployment.release();
        job.deployment = deployment.snapshot();
        await this.deps.store.save(job).catch(() => undefined);
      }
    }
  }

  private async needsGpu(todo: StoredSegment[]): Promise<boolean> {
    for (const seg of todo) {
      if (!(await this.deps.store.readCache(seg.cacheKey))) return true;
    }
    return false;
  }

  private async runTodo(job: StoredJob, todo: StoredSegment[], signal: AbortSignal): Promise<void> {
    const jobId = job.id;
    await runPool(todo, this.deps.cfg.maxConcurrent, async (seg) => {
      if (signal.aborted) return;
      const live = this.deps.store.get(jobId)?.segments.find((item) => item.id === seg.id);
      if (!live || live.status !== "queued") return;
      try {
        await this.runSegment(job, live, signal);
      } catch (err) {
        const message = redact(err instanceof Error ? err.message : "Segment failed.", this.deps.cfg.comfyApiKey);
        live.status = "failed";
        live.error = message;
        if (err instanceof GenerationError && ACCOUNT_CODES.has(err.code)) {
          job.error = message;
          for (const other of job.segments) {
            if (other.status === "queued") {
              other.status = "failed";
              other.error = message;
            }
          }
          this.aborts.get(jobId)?.abort();
        }
        rollup(job);
        await this.deps.store.save(job);
      }
    });
    rollup(job);
    await this.deps.store.save(job);
  }

  private async runSegment(job: StoredJob, seg: StoredSegment, signal: AbortSignal): Promise<void> {
    const owns = (ticket: number, cacheKey: string) => seg.attempt === ticket && seg.cacheKey === cacheKey;
    if (signal.aborted) {
      seg.status = "failed";
      seg.error = "Cancelled";
      rollup(job);
      await this.deps.store.save(job);
      return;
    }
    const ticket = seg.attempt;
    const cacheKey = seg.cacheKey;
    const cached = await this.deps.store.readCache(cacheKey);
    if (!owns(ticket, cacheKey)) return;
    if (signal.aborted) {
      seg.status = "failed";
      seg.error = "Cancelled";
      rollup(job);
      await this.deps.store.save(job);
      return;
    }
    if (cached) {
      await this.deps.store.writeSegment(job.id, seg, cached.bytes, cached.contentType);
      if (!owns(ticket, cacheKey)) return;
      seg.status = "done";
      seg.progress = 1;
      seg.error = undefined;
      rollup(job);
      await this.deps.store.save(job);
      return;
    }

    seg.status = "running";
    seg.progress = 0.05;
    rollup(job);
    await this.deps.store.save(job);
    if (!owns(ticket, cacheKey)) return;

    const cut = job.cutlist.segments.find((item) => item.id === seg.id);
    const photo = job.photos.find((item) => item.index === seg.photoIndex);
    if (!cut || !photo) throw new Error(`Segment ${seg.id} is missing its photo or cut.`);
    const bytes = await this.deps.store.readPhoto(job.id, photo);
    if (!owns(ticket, cacheKey)) return;
    const asset = await this.deps.adapter.uploadAsset({
      filename: photo.filename,
      contentType: photo.contentType,
      bytes,
    });
    if (!owns(ticket, cacheKey)) return;
    if (signal.aborted) {
      seg.status = "failed";
      seg.error = "Cancelled";
      rollup(job);
      await this.deps.store.save(job);
      return;
    }
    const remote = await this.deps.adapter.submitSegment({
      idempotencyKey: seg.idempotencyKey,
      cacheKey,
      attempt: ticket,
      image: asset,
      positive: cut.prompt,
      negative: cut.negativePrompt,
      seed: cut.seed,
      frames: cut.frames,
      width: this.deps.workflow.map?.width ?? cut.width,
      height: this.deps.workflow.map?.height ?? cut.height,
      fps: this.deps.workflow.map?.fps ?? cut.fps,
      look: cut.look,
      segmentId: cut.id,
      duration: cut.duration,
      start: cut.start,
    });
    if (!owns(ticket, cacheKey)) {
      void this.deps.adapter.cancel(remote).catch(() => undefined);
      return;
    }
    seg.remoteJobId = remote.id;
    const status = await this.poll(remote, job, seg, signal, ticket, cacheKey);
    if (!owns(ticket, cacheKey)) {
      void this.deps.adapter.cancel(remote).catch(() => undefined);
      return;
    }
    if (status.state !== "done") {
      seg.status = "failed";
      seg.error = status.error || "Generation failed.";
      seg.progress = 1;
      rollup(job);
      await this.deps.store.save(job);
      return;
    }
    const output = pickOutput(status.outputs ?? [], this.deps.workflow.map?.bindings.output.nodeId);
    if (!output) {
      seg.status = "failed";
      seg.error = "Generation finished without an output file.";
      rollup(job);
      await this.deps.store.save(job);
      return;
    }
    let file = await this.deps.adapter.fetchOutput(output);
    if (!owns(ticket, cacheKey)) {
      void this.deps.adapter.cancel(remote).catch(() => undefined);
      return;
    }
    let contentType = output.contentType || sniff(file);
    if (isVideo(contentType, file)) {
      if (!contentType.startsWith("video/")) contentType = file.subarray(4, 8).toString("latin1") === "ftyp" ? "video/mp4" : "video/webm";
      if (this.deps.workflow.map?.outputHasAudio) {
        // The workflow renders its own audio; DropCut uses the user's song instead.
        const ext = contentType === "video/webm" ? ".webm" : ".mp4";
        file = (await stripAudio(file, ext, this.deps.ffmpegPath)).bytes;
      }
    }
    if (!owns(ticket, cacheKey)) return;
    await this.deps.store.writeSegment(job.id, seg, file, contentType);
    if (!owns(ticket, cacheKey)) return;
    seg.status = "done";
    seg.progress = 1;
    seg.error = undefined;
    rollup(job);
    await this.deps.store.save(job);
  }

  private async poll(
    ref: { id: string; adapter: string },
    job: StoredJob,
    seg: StoredSegment,
    signal: AbortSignal,
    ticket: number,
    cacheKey: string,
  ): Promise<SegmentStatus> {
    const interval = this.deps.adapter.name === "mock" ? 30 : 1500;
    const deadline = Date.now() + 15 * 60 * 1000;
    const current = () => seg.attempt === ticket && seg.cacheKey === cacheKey;
    for (;;) {
      if (!current()) return { state: "queued" };
      if (signal.aborted) return { state: "failed", error: "Cancelled" };
      const status = await this.deps.adapter.getStatus(ref);
      if (!current()) return { state: "queued" };
      if (status.state === "queued" || status.state === "running") {
        seg.status = status.state;
        if (typeof status.progress === "number") seg.progress = status.progress;
        rollup(job);
        await this.deps.store.save(job);
        if (!current()) return { state: "queued" };
        if (Date.now() > deadline) return { state: "failed", error: "Timed out waiting for generation." };
        await sleep(interval, signal);
        continue;
      }
      return status;
    }
  }
}

function sniff(bytes: Buffer): string {
  const head = bytes.subarray(0, 80).toString("utf8");
  if (head.includes("<svg")) return "image/svg+xml";
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  return "application/octet-stream";
}

async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  let cursor = 0;
  const workers = Math.max(1, Math.min(limit, items.length));
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await fn(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
