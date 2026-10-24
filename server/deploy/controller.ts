/**
 * Comfy deployment control plane (the same routes comfy-cli uses):
 *   GET  {controlUrl}/v1/deployments/{id}         status, endpointUrl, progress, stopReason
 *   POST {controlUrl}/v1/deployments/{id}/start   resume a stopped/failed deployment (bills from here)
 *   POST {controlUrl}/v1/deployments/{id}/stop    pause it, keeping endpoint and staged models
 * Auth: X-API-Key: <workspace API key>. Jobs still go to the deployment's own /api/v2 surface.
 */
import { redact } from "../config";
import type { DeploymentPhase, DeploymentView } from "../../shared/api-types";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface DeploymentControllerOptions {
  apiKey: string;
  deploymentId: string;
  controlUrl?: string;
  idleStopMs?: number;
  pollMs?: number;
  warmTimeoutMs?: number;
  fetchImpl?: FetchLike;
  log?: (line: string) => void;
}

/** Statuses that hold compute (and bill) according to the deploy service. */
export const BILLING_STATUSES = new Set(["queued", "provisioning", "starting", "ready", "unhealthy"]);
const WARMING = new Set(["queued", "provisioning", "starting"]);
const STARTABLE = new Set(["stopped", "failed"]);

export class DeploymentError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

interface RawDeployment {
  id?: string;
  status?: string;
  endpointUrl?: string | null;
  stopReason?: string | null;
  error?: unknown;
  computeConfig?: { gpuClass?: string; region?: string; min?: number; max?: number };
  progress?: {
    step?: string;
    modelsDone?: number;
    modelsTotal?: number;
    bytesDone?: number;
    bytesTotal?: number;
    etaSeconds?: number;
    startedAt?: string;
  } | null;
}

export function phaseOf(status: string | undefined): DeploymentPhase {
  if (!status) return "unknown";
  if (status === "ready") return "ready";
  if (WARMING.has(status)) return "warming";
  if (status === "stopping") return "stopping";
  if (status === "stopped") return "stopped";
  if (status === "unhealthy" || status === "failed" || status === "stop_failed") return "failed";
  return "unknown";
}

export function viewOf(raw: RawDeployment, extra: Partial<DeploymentView> = {}): DeploymentView {
  const status = raw.status ?? "unknown";
  const p = raw.progress ?? undefined;
  let progress: number | undefined;
  if (p?.bytesTotal && p.bytesTotal > 0 && typeof p.bytesDone === "number") progress = Math.min(1, p.bytesDone / p.bytesTotal);
  else if (p?.modelsTotal && typeof p.modelsDone === "number") progress = Math.min(1, p.modelsDone / p.modelsTotal);
  const phase = phaseOf(status);
  return {
    id: raw.id ?? "",
    status,
    phase,
    billing: BILLING_STATUSES.has(status) || status === "stop_failed",
    endpointUrl: raw.endpointUrl ?? undefined,
    stopReason: raw.stopReason ?? undefined,
    gpuClass: raw.computeConfig?.gpuClass,
    minWorkers: raw.computeConfig?.min,
    maxWorkers: raw.computeConfig?.max,
    step: p?.step,
    stepProgress: progress,
    etaSeconds: p?.etaSeconds,
    message: describe(status, p?.step, progress),
    ...extra,
  };
}

function describe(status: string, step: string | undefined, progress: number | undefined): string {
  const pct = typeof progress === "number" ? ` ${Math.round(progress * 100)}%` : "";
  switch (status) {
    case "queued":
      return "Warming up (cold start ~10 min): queued for a GPU";
    case "provisioning":
      return step === "staging_models"
        ? `Warming up (cold start ~10 min): staging models${pct}`
        : `Warming up (cold start ~10 min): ${step ? step.replace(/_/g, " ") : "provisioning"}${pct}`;
    case "starting":
      return "Warming up (cold start ~10 min): starting the worker";
    case "ready":
      return "GPU ready";
    case "stopping":
      return "Stopping the GPU";
    case "stopped":
      return "GPU stopped (not billing)";
    case "unhealthy":
      return "GPU unhealthy (still billing)";
    case "stop_failed":
      return "Stop did not take; may still be billing";
    case "failed":
      return "Deployment failed";
    default:
      return status;
  }
}

export class DeploymentController {
  private readonly controlUrl: string;
  private readonly idleStopMs: number;
  private readonly pollMs: number;
  private readonly warmTimeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly log: (line: string) => void;
  private last: DeploymentView | undefined;
  private warming: Promise<DeploymentView> | undefined;
  private warmStartedAt: number | undefined;
  private active = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private idleStopAt: number | undefined;
  lastColdStartMs: number | undefined;

  constructor(private readonly opts: DeploymentControllerOptions) {
    this.controlUrl = (opts.controlUrl ?? "https://platformapi.comfy.org/deploy").replace(/\/+$/, "");
    this.idleStopMs = opts.idleStopMs ?? 10 * 60 * 1000;
    this.pollMs = opts.pollMs ?? 5000;
    this.warmTimeoutMs = opts.warmTimeoutMs ?? 30 * 60 * 1000;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.log = opts.log ?? ((line) => console.log(`[dropcut] ${line}`));
  }

  get id(): string {
    return this.opts.deploymentId;
  }

  /** Latest known view plus local warm-up / idle-stop bookkeeping. */
  snapshot(): DeploymentView | undefined {
    if (!this.last) return undefined;
    return {
      ...this.last,
      warmingSince: this.warmStartedAt ? new Date(this.warmStartedAt).toISOString() : undefined,
      idleStopAt: this.idleStopAt ? new Date(this.idleStopAt).toISOString() : undefined,
      activeJobs: this.active,
      lastColdStartSeconds: this.lastColdStartMs != null ? Math.round(this.lastColdStartMs / 1000) : undefined,
    };
  }

  async status(): Promise<DeploymentView> {
    const raw = await this.call<RawDeployment>("GET", "");
    this.last = viewOf(raw);
    return this.snapshot()!;
  }

  async start(): Promise<void> {
    this.log(`deployment ${this.id}: start`);
    await this.call("POST", "/start");
  }

  async stop(reason = "idle"): Promise<DeploymentView> {
    this.clearIdle();
    this.log(`deployment ${this.id}: stop (${reason})`);
    const raw = await this.call<RawDeployment>("POST", "/stop");
    this.last = viewOf({ ...(this.last ? { id: this.last.id, endpointUrl: this.last.endpointUrl } : {}), ...raw });
    return this.snapshot()!;
  }

  /**
   * Resolve once the deployment is `ready`, starting it if it is stopped or failed.
   * Concurrent callers share one warm-up. Calls onUpdate on every poll.
   */
  ensureReady(onUpdate?: (view: DeploymentView) => void, signal?: AbortSignal): Promise<DeploymentView> {
    this.clearIdle();
    if (!this.warming) {
      this.warming = this.warm(onUpdate, signal).finally(() => {
        this.warming = undefined;
        this.warmStartedAt = undefined;
      });
    } else if (onUpdate) {
      const view = this.snapshot();
      if (view) onUpdate(view);
    }
    return this.warming;
  }

  private async warm(onUpdate?: (view: DeploymentView) => void, signal?: AbortSignal): Promise<DeploymentView> {
    let view = await this.status();
    onUpdate?.(view);
    if (view.status === "ready") return view;
    if (view.status === "stop_failed") {
      throw new DeploymentError("The last stop did not take (stop_failed). Stop the deployment again before generating.", "stop_failed");
    }
    if (view.status === "unhealthy") {
      throw new DeploymentError("The GPU deployment is unhealthy. Stop it and try again.", "unhealthy");
    }
    const started = Date.now();
    this.warmStartedAt = started;
    let requestedStart = false;
    for (;;) {
      if (signal?.aborted) throw new DeploymentError("Cancelled while warming up.", "cancelled");
      if (STARTABLE.has(view.status) && !requestedStart) {
        if (view.stopReason === "credits") {
          throw new DeploymentError("The deployment was stopped for credits. Top up before starting it.", "credits");
        }
        await this.start();
        requestedStart = true;
      } else if (view.status === "failed" && requestedStart) {
        throw new DeploymentError(`The GPU deployment failed to start${view.stopReason ? ` (${view.stopReason})` : ""}.`, "failed");
      } else if (view.status === "ready") {
        this.lastColdStartMs = Date.now() - started;
        this.log(`deployment ${this.id}: ready after ${Math.round(this.lastColdStartMs / 1000)}s`);
        return this.snapshot()!;
      } else if (view.status === "unhealthy") {
        throw new DeploymentError("The GPU deployment came up unhealthy.", "unhealthy");
      }
      if (Date.now() - started > this.warmTimeoutMs) {
        throw new DeploymentError(`The GPU did not become ready within ${Math.round(this.warmTimeoutMs / 60000)} min.`, "timeout");
      }
      await sleep(this.pollMs, signal);
      view = await this.status();
      onUpdate?.(view);
    }
  }

  /** Mark a job as using the GPU; cancels any pending idle stop. */
  acquire(): void {
    this.active += 1;
    this.clearIdle();
  }

  /** Release a job; when nothing is active, schedule the idle stop. */
  release(): void {
    this.active = Math.max(0, this.active - 1);
    if (this.active === 0) this.scheduleIdleStop();
  }

  scheduleIdleStop(ms = this.idleStopMs): void {
    this.clearIdle();
    if (ms <= 0) return;
    this.idleStopAt = Date.now() + ms;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      this.idleStopAt = undefined;
      if (this.active > 0 || this.warming) return;
      void this.stopIfBilling("idle").catch((err: unknown) => {
        this.log(`deployment ${this.id}: idle stop failed: ${redact(err instanceof Error ? err.message : String(err), this.opts.apiKey)}`);
      });
    }, ms);
    this.idleTimer.unref?.();
  }

  /** Stop only if the deployment is in a compute-holding state. */
  async stopIfBilling(reason: string): Promise<DeploymentView> {
    const view = await this.status();
    if (!view.billing) return view;
    return this.stop(reason);
  }

  /** On server start: a ready-but-idle deployment gets the idle timer so it can't bill forever. */
  async adopt(): Promise<void> {
    try {
      const view = await this.status();
      if (view.billing && this.active === 0) this.scheduleIdleStop();
      if (view.minWorkers != null && view.minWorkers !== 0) {
        this.log(`deployment ${this.id}: warning, min workers is ${view.minWorkers} (expected 0)`);
      }
    } catch (err) {
      this.log(`deployment ${this.id}: status check failed: ${redact(err instanceof Error ? err.message : String(err), this.opts.apiKey)}`);
    }
  }

  dispose(): void {
    this.clearIdle();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.idleStopAt = undefined;
  }

  private async call<T>(method: "GET" | "POST", suffix: string): Promise<T> {
    const url = `${this.controlUrl}/v1/deployments/${encodeURIComponent(this.opts.deploymentId)}${suffix}`;
    const res = await this.fetchImpl(url, {
      method,
      headers: { "X-API-Key": this.opts.apiKey, Accept: "application/json", ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
      body: method === "POST" ? "{}" : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 300);
      try {
        const body = JSON.parse(text) as { error?: { code?: string; message?: string } | string; message?: string; code?: string };
        const err = typeof body.error === "object" ? body.error : undefined;
        detail = [err?.code ?? body.code, err?.message ?? (typeof body.error === "string" ? body.error : body.message)].filter(Boolean).join(": ") || detail;
      } catch {
        // not JSON
      }
      throw new DeploymentError(redact(`Deployment ${method} ${suffix || "status"} failed (${res.status}): ${detail}`, this.opts.apiKey), `http_${res.status}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
