import { createHash, randomUUID } from "node:crypto";
import { hashUnit } from "../../shared/hash";
import { renderPlaceholderSvg } from "./placeholder";
import type {
  AssetRef,
  GenerationAdapter,
  JobRef,
  OutputRef,
  SegmentRequest,
  SegmentStatus,
  UploadFile,
} from "./types";

interface MockJob {
  id: string;
  created: number;
  queueMs: number;
  runMs: number;
  fail: boolean;
  svg: string;
  cancelled: boolean;
  segmentId: string;
}

export interface MockAdapterOptions {
  failRate?: number;
  latencyMs?: number;
  now?: () => number;
}

/**
 * Failures are deterministic: the same cache key and attempt always fail or always pass.
 * Attempt is part of the key so a retry can succeed when the rate is between 0 and 1.
 * Rate 0 never fails. Rate 1 always fails.
 */
export function shouldFail(cacheKey: string, attempt: number, rate: number): boolean {
  if (!(rate > 0)) return false;
  if (rate >= 1) return true;
  return hashUnit(`${cacheKey}:${attempt}`) < rate;
}

export class MockAdapter implements GenerationAdapter {
  readonly name = "mock";
  submits = 0;
  uploads = 0;
  private jobs = new Map<string, MockJob>();
  private readonly failRate: number;
  private readonly latencyMs: number;
  private readonly now: () => number;

  constructor(opts: MockAdapterOptions = {}) {
    this.failRate = opts.failRate ?? 0;
    this.latencyMs = opts.latencyMs ?? 400;
    this.now = opts.now ?? (() => Date.now());
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: "Mock adapter. No network calls." };
  }

  async uploadAsset(file: UploadFile): Promise<AssetRef> {
    this.uploads += 1;
    const id = `mock-${createHash("sha256").update(file.bytes).digest("hex").slice(0, 16)}`;
    return {
      id,
      filename: file.filename,
      contentType: file.contentType,
      hash: null,
      filePath: file.filename,
    };
  }

  async submitSegment(req: SegmentRequest): Promise<JobRef> {
    this.submits += 1;
    const id = randomUUID();
    const latency = this.latencyMs;
    const queueMs = latency <= 0 ? 0 : Math.round(latency * 0.35);
    const runMs = latency <= 0 ? 0 : Math.max(0, latency - queueMs);
    this.jobs.set(id, {
      id,
      created: this.now(),
      queueMs,
      runMs,
      fail: shouldFail(req.cacheKey, req.attempt, this.failRate),
      svg: renderPlaceholderSvg({
        look: req.look,
        seed: req.seed,
        segmentId: req.segmentId,
        start: req.start,
      }),
      cancelled: false,
      segmentId: req.segmentId,
    });
    return { id, adapter: this.name };
  }

  async getStatus(job: JobRef): Promise<SegmentStatus> {
    const found = this.jobs.get(job.id);
    if (!found) return { state: "failed", error: "Unknown mock job." };
    if (found.cancelled) return { state: "failed", error: "Cancelled" };
    const elapsed = this.now() - found.created;
    if (elapsed < found.queueMs) return { state: "queued", progress: 0 };
    if (elapsed < found.queueMs + found.runMs) {
      const progress = (elapsed - found.queueMs) / Math.max(1, found.runMs);
      return { state: "running", progress };
    }
    if (found.fail) {
      return { state: "failed", error: "Mock adapter failed this segment (MOCK_FAIL_RATE)." };
    }
    return {
      state: "done",
      progress: 1,
      outputs: [
        {
          id: found.id,
          contentType: "image/svg+xml",
          filename: `${found.segmentId}.svg`,
          type: "image",
        },
      ],
    };
  }

  async fetchOutput(output: OutputRef): Promise<Buffer> {
    const found = this.jobs.get(output.id);
    if (!found) throw new Error("Mock output is missing.");
    return Buffer.from(found.svg, "utf8");
  }

  async cancel(job: JobRef): Promise<void> {
    const found = this.jobs.get(job.id);
    if (found) found.cancelled = true;
  }
}
