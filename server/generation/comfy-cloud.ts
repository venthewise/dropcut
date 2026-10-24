import { redact } from "../config";
import { GenerationError } from "./errors";
import type {
  AssetRef,
  GenerationAdapter,
  JobRef,
  OutputRef,
  SegmentRequest,
  SegmentStatus,
  UploadFile,
} from "./types";
import { applyWorkflow, coreAssetRef, safeFilePath, type LoadedWorkflow } from "./workflow";

export interface ComfyCloudOptions {
  apiKey: string;
  baseUrl: string;
  version: "v1" | "v2";
  loaded: LoadedWorkflow;
  fetchImpl?: typeof fetch;
}

interface V2Output {
  node_id?: string;
  name?: string;
  type?: string;
  content_type?: string;
  id?: string;
  url?: string;
}

interface V2Job {
  id?: string;
  status?: string;
  progress?: { value?: number } | null;
  outputs?: V2Output[];
  error?: { message?: string; code?: string } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function envelopeMessage(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const error = body.error;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  if (typeof body.message === "string") return body.message;
  return undefined;
}

export function envelopeCode(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const error = body.error;
  if (isRecord(error) && typeof error.code === "string") return error.code;
  return undefined;
}

/** Map the HTTP statuses the product treats as account problems. */
export function mapHttpError(status: number): GenerationError | null {
  if (status === 401) {
    return new GenerationError("API key was rejected. Check COMFY_CLOUD_API_KEY.", "bad_key", 401);
  }
  if (status === 402) {
    return new GenerationError(
      "Out of credits. Comfy Cloud needs an active subscription with credits.",
      "no_credits",
      402,
    );
  }
  if (status === 429) {
    return new GenerationError(
      "Subscription inactive. If the subscription is active, Comfy Cloud may be rate limiting this key — wait and retry.",
      "subscription",
      429,
    );
  }
  return null;
}

export function mapV2Status(job: V2Job): SegmentStatus {
  const status = job.status ?? "";
  const progress = typeof job.progress?.value === "number" ? job.progress.value : undefined;
  if (status === "queued") return { state: "queued", progress: progress ?? 0 };
  if (status === "running" || status === "canceling") return { state: "running", progress: progress ?? 0.5 };
  if (status === "succeeded") {
    return {
      state: "done",
      progress: 1,
      outputs: (job.outputs ?? []).map((output) => ({
        id: output.id ?? "",
        url: output.url,
        contentType: output.content_type,
        filename: output.name,
        nodeId: output.node_id,
        type: output.type,
      })),
    };
  }
  if (status === "failed" || status === "expired" || status === "canceled") {
    return {
      state: "failed",
      progress: 1,
      error: job.error?.message || `Comfy Cloud job ${status}.`,
    };
  }
  return { state: "running", progress: progress ?? 0 };
}

export function mapV1Status(body: unknown): SegmentStatus {
  const record = isRecord(body) ? body : {};
  const status = typeof record.status === "string" ? record.status : "";
  const outputs = extractV1Outputs(record);
  if (status === "success") {
    if (outputs.length === 0) {
      return { state: "failed", error: "Comfy Cloud reported success but did not list an output file." };
    }
    return { state: "done", progress: 1, outputs };
  }
  if (status === "error" || status === "non_retryable_error" || status === "lost" || status === "cancelled") {
    return { state: "failed", error: `Comfy Cloud job ${status}.` };
  }
  if (status === "pending" || status === "queued") return { state: "queued", progress: 0 };
  return { state: "running", progress: 0.5 };
}

function extractV1Outputs(record: Record<string, unknown>): OutputRef[] {
  const found: OutputRef[] = [];
  const push = (item: unknown, nodeId?: string) => {
    if (!isRecord(item) || typeof item.filename !== "string") return;
    found.push({
      id: item.filename,
      filename: item.filename,
      subfolder: typeof item.subfolder === "string" ? item.subfolder : "",
      type: typeof item.type === "string" ? item.type : "output",
      contentType: typeof item.content_type === "string" ? item.content_type : undefined,
      nodeId,
    });
  };
  if (Array.isArray(record.outputs)) {
    for (const item of record.outputs) push(item);
    return found;
  }
  if (isRecord(record.outputs)) {
    for (const [nodeId, nodeOut] of Object.entries(record.outputs)) {
      if (!isRecord(nodeOut)) continue;
      for (const value of Object.values(nodeOut)) {
        if (!Array.isArray(value)) continue;
        for (const item of value) push(item, nodeId);
      }
    }
  }
  return found;
}

export function pickOutput(outputs: OutputRef[], preferredNodeId?: string): OutputRef | undefined {
  if (outputs.length === 0) return undefined;
  if (preferredNodeId) {
    const match = outputs.find((output) => output.nodeId === preferredNodeId && output.id);
    if (match) return match;
  }
  return (
    outputs.find((output) => output.type === "video" && (output.id || output.url || output.filename)) ??
    outputs.find((output) => output.type === "image" && (output.id || output.url || output.filename)) ??
    outputs.find((output) => output.id || output.url || output.filename)
  );
}

type FetchImpl = typeof fetch;

export class ComfyCloudAdapter implements GenerationAdapter {
  readonly name = "comfy-cloud";
  private readonly fetchImpl: FetchImpl;

  constructor(private readonly opts: ComfyCloudOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    if (!this.opts.apiKey) return { ok: false, detail: "COMFY_CLOUD_API_KEY is not set." };
    const errors = this.opts.loaded.problems.filter((problem) => problem.level === "error");
    if (errors.length > 0) return { ok: false, detail: errors.map((problem) => problem.message).join(" ") };
    if (this.opts.loaded.placeholder) {
      return { ok: false, detail: "Workflow is still the shipped placeholder." };
    }
    return { ok: true };
  }

  async uploadAsset(file: UploadFile): Promise<AssetRef> {
    if (this.opts.version === "v1") return this.uploadV1(file);
    const fd = new FormData();
    const blob = new Blob([new Uint8Array(file.bytes)], { type: file.contentType });
    const filePath = safeFilePath(file.filename);
    // Comfy Cloud reads metadata fields first: content_type and file_path must precede file.
    fd.append("content_type", file.contentType || "application/octet-stream");
    fd.append("file_path", filePath);
    fd.append("file", blob, filePath);
    const res = await this.fetchImpl(`${this.opts.baseUrl}/api/v2/assets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
      body: fd,
    });
    if (!res.ok) await this.readError(res);
    const asset = (await res.json()) as { id?: string; hash?: string | null; file_path?: string | null; content_type?: string };
    if (!asset.id) throw new GenerationError("Asset upload did not return an id.", "upstream", res.status);
    return {
      id: asset.id,
      filename: filePath,
      contentType: asset.content_type || file.contentType,
      hash: asset.hash ?? null,
      filePath: asset.file_path ?? filePath,
    };
  }

  private async uploadV1(file: UploadFile): Promise<AssetRef> {
    const fd = new FormData();
    const filePath = safeFilePath(file.filename);
    const blob = new Blob([new Uint8Array(file.bytes)], { type: file.contentType });
    fd.append("image", blob, filePath);
    fd.append("type", "input");
    fd.append("overwrite", "true");
    const res = await this.fetchImpl(`${this.opts.baseUrl}/api/upload/image`, {
      method: "POST",
      headers: { "X-API-Key": this.opts.apiKey },
      body: fd,
    });
    if (!res.ok) await this.readError(res);
    const body = (await res.json()) as { name?: string; subfolder?: string };
    if (!body.name) throw new GenerationError("Image upload did not return a filename.", "upstream", res.status);
    return {
      id: body.name,
      filename: body.name,
      contentType: file.contentType,
      filePath: body.name,
      subfolder: body.subfolder ?? "",
    };
  }

  async submitSegment(req: SegmentRequest): Promise<JobRef> {
    const workflow = this.buildGraph(req);
    if (this.opts.version === "v1") {
      const res = await this.fetchImpl(`${this.opts.baseUrl}/api/prompt`, {
        method: "POST",
        headers: {
          "X-API-Key": this.opts.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt: workflow }),
      });
      if (!res.ok) await this.readError(res);
      const body = (await res.json()) as { prompt_id?: string };
      if (!body.prompt_id) throw new GenerationError("Comfy Cloud did not return a prompt id.", "upstream", res.status);
      return { id: body.prompt_id, adapter: this.name };
    }
    const res = await this.fetchImpl(`${this.opts.baseUrl}/api/v2/jobs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": req.idempotencyKey,
      },
      body: JSON.stringify({ workflow }),
    });
    if (!res.ok) await this.readError(res);
    const body = (await res.json()) as { id?: string };
    if (!body.id) throw new GenerationError("Comfy Cloud did not return a job id.", "upstream", res.status);
    return { id: body.id, adapter: this.name };
  }

  private buildGraph(req: SegmentRequest): Record<string, unknown> {
    const { workflow, map } = this.opts.loaded;
    if (!workflow || !map) {
      throw new GenerationError("Workflow is not loaded. See /api/health.", "workflow", 422);
    }
    const image =
      this.opts.version === "v2"
        ? coreAssetRef({ id: req.image.id, hash: req.image.hash, filePath: req.image.filePath })
        : (req.image.filePath || req.image.filename);
    return applyWorkflow(workflow, map, {
      image,
      positive: req.positive,
      negative: req.negative,
      seed: req.seed >>> 0,
      frames: req.frames,
      duration: req.duration,
      width: map.width ?? req.width,
      height: map.height ?? req.height,
      fps: map.fps ?? req.fps,
    });
  }

  async getStatus(job: JobRef): Promise<SegmentStatus> {
    if (this.opts.version === "v1") {
      const res = await this.fetchImpl(`${this.opts.baseUrl}/api/job/${encodeURIComponent(job.id)}/status`, {
        headers: { "X-API-Key": this.opts.apiKey },
      });
      if (!res.ok) await this.readError(res);
      const mapped = mapV1Status(await res.json());
      if (mapped.error) mapped.error = redact(mapped.error, this.opts.apiKey);
      return mapped;
    }
    const res = await this.fetchImpl(`${this.opts.baseUrl}/api/v2/jobs/${encodeURIComponent(job.id)}`, {
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
    });
    if (!res.ok) await this.readError(res);
    const mapped = mapV2Status((await res.json()) as V2Job);
    if (mapped.error) mapped.error = redact(mapped.error, this.opts.apiKey);
    return mapped;
  }

  async fetchOutput(output: OutputRef): Promise<Buffer> {
    if (output.url) {
      return this.fetchFollowing(output.url, this.isApiUrl(output.url));
    }
    if (this.opts.version === "v1" && output.filename) {
      const params = new URLSearchParams({
        filename: output.filename,
        subfolder: output.subfolder ?? "",
        type: output.type || "output",
      });
      return this.fetchFollowing(`${this.opts.baseUrl}/api/view?${params.toString()}`, true);
    }
    if (output.id) {
      return this.fetchFollowing(`${this.opts.baseUrl}/api/v2/assets/${encodeURIComponent(output.id)}/content`, true);
    }
    throw new GenerationError("Output has no download location.", "upstream");
  }

  async cancel(job: JobRef): Promise<void> {
    if (this.opts.version !== "v2") return;
    const res = await this.fetchImpl(`${this.opts.baseUrl}/api/v2/jobs/${encodeURIComponent(job.id)}/cancel`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
    });
    if (res.status === 404 || res.status === 409) return;
    if (!res.ok) await this.readError(res);
  }

  private isApiUrl(url: string): boolean {
    try {
      const target = new URL(url, this.opts.baseUrl);
      const base = new URL(this.opts.baseUrl);
      return target.origin === base.origin && target.pathname.includes("/api/");
    } catch {
      return false;
    }
  }

  /**
   * Signed download URLs must be fetched with no auth header.
   * A 302 from the API is followed once, without the key.
   */
  private async fetchFollowing(url: string, auth: boolean): Promise<Buffer> {
    const headers: Record<string, string> = {};
    if (auth) {
      if (this.opts.version === "v1") headers["X-API-Key"] = this.opts.apiKey;
      else headers.Authorization = `Bearer ${this.opts.apiKey}`;
    }
    const res = await this.fetchImpl(url, { headers, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new GenerationError("Download redirect was missing a Location header.", "upstream", res.status);
      const next = new URL(location, url).toString();
      const signed = await this.fetchImpl(next, { redirect: "follow" });
      if (!signed.ok) {
        throw new GenerationError(redact(`Download failed (${signed.status}).`, this.opts.apiKey), "upstream", signed.status);
      }
      return Buffer.from(await signed.arrayBuffer());
    }
    if (!res.ok) await this.readError(res);
    return Buffer.from(await res.arrayBuffer());
  }

  private async readError(res: Response): Promise<never> {
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
    const mapped = mapHttpError(res.status);
    if (mapped) throw mapped;
    const detail = envelopeMessage(body);
    const message = detail
      ? redact(detail, this.opts.apiKey)
      : `Comfy Cloud request failed (${res.status}).`;
    throw new GenerationError(message, "upstream", res.status);
  }
}
