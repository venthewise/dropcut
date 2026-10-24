import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCutlist } from "../../shared/cutlist";
import { loadConfig } from "../config";
import { MockAdapter } from "../generation/mock";
import type { LoadedWorkflow } from "../generation/workflow";
import { Runner } from "../jobs/runner";
import { JobStore } from "../jobs/store";
import { DeploymentController, phaseOf, viewOf, type FetchLike } from "./controller";

const KEY = "comfyui-testkey0000000000000000";
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** A fake control plane: stopped → (start) → provisioning → starting → ready. */
function fakePlane(opts: { initial?: string; script?: string[]; startFails?: boolean } = {}) {
  let status = opts.initial ?? "stopped";
  let started = false;
  const script = [...(opts.script ?? ["provisioning", "starting", "ready"])];
  const calls: { method: string; url: string; key: string | null }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    calls.push({ method, url, key: headers.get("X-API-Key") });
    if (method === "POST" && url.endsWith("/start")) {
      if (opts.startFails) return new Response(JSON.stringify({ error: { code: "boom", message: `bad ${KEY}` } }), { status: 500 });
      status = "queued";
      started = true;
      return new Response(JSON.stringify({ id: "dep-1", status }), { status: 200 });
    }
    if (method === "POST" && url.endsWith("/stop")) {
      status = "stopped";
      return new Response(JSON.stringify({ id: "dep-1", status, stopReason: "user" }), { status: 200 });
    }
    if ((started || opts.script) && status !== "stopped" && status !== "ready" && script.length > 0) status = script.shift()!;
    const progress = status === "provisioning"
      ? { step: "staging_models", bytesDone: 50, bytesTotal: 100, modelsDone: 1, modelsTotal: 2 }
      : null;
    return new Response(JSON.stringify({
      id: "dep-1",
      status,
      endpointUrl: "https://dep-1.run.comfy.app",
      computeConfig: { gpuClass: "rtx-pro-6000-server", min: 0, max: 1 },
      progress,
    }), { status: 200 });
  };
  return { fetchImpl, calls, get status() { return status; } };
}

function controller(plane: ReturnType<typeof fakePlane>, extra: Partial<ConstructorParameters<typeof DeploymentController>[0]> = {}) {
  return new DeploymentController({
    apiKey: KEY,
    deploymentId: "dep-1",
    controlUrl: "https://control.test/deploy/",
    pollMs: 1,
    idleStopMs: 50,
    fetchImpl: plane.fetchImpl,
    log: () => undefined,
    ...extra,
  });
}

const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("deployment views", () => {
  it("maps statuses to phases and billing", () => {
    expect(phaseOf("provisioning")).toBe("warming");
    expect(phaseOf("ready")).toBe("ready");
    expect(phaseOf("stop_failed")).toBe("failed");
    const v = viewOf({ status: "provisioning", progress: { step: "staging_models", bytesDone: 25, bytesTotal: 100 } });
    expect(v.billing).toBe(true);
    expect(v.stepProgress).toBe(0.25);
    expect(v.message).toMatch(/cold start ~10 min.*staging models 25%/);
    expect(viewOf({ status: "stopped" }).billing).toBe(false);
  });
});

describe("DeploymentController", () => {
  it("starts a stopped deployment, waits for ready, and uses X-API-Key on the control URL", async () => {
    const plane = fakePlane();
    const ctl = controller(plane);
    const seen: string[] = [];
    const view = await ctl.ensureReady((v) => seen.push(v.status));
    expect(view.status).toBe("ready");
    expect(seen[0]).toBe("stopped");
    expect(seen).toContain("provisioning");
    expect(seen.at(-1)).toBe("ready");
    expect(plane.calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual(["https://control.test/deploy/v1/deployments/dep-1/start"]);
    expect(plane.calls.every((c) => c.key === KEY)).toBe(true);
    expect(ctl.lastColdStartMs).toBeGreaterThanOrEqual(0);
  });

  it("does not call start when already ready, and shares one warm-up", async () => {
    const plane = fakePlane({ initial: "ready" });
    const ctl = controller(plane);
    await Promise.all([ctl.ensureReady(), ctl.ensureReady()]);
    expect(plane.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("redacts the key from control-plane errors", async () => {
    const plane = fakePlane({ startFails: true });
    const ctl = controller(plane);
    await expect(ctl.ensureReady()).rejects.toThrow(/boom/);
    await expect(controller(fakePlane({ startFails: true })).ensureReady()).rejects.not.toThrow(new RegExp(KEY));
  });

  it("refuses to start after a stop_failed and times out a stuck warm-up", async () => {
    await expect(controller(fakePlane({ initial: "stop_failed" })).ensureReady()).rejects.toThrow(/stop_failed/);
    const stuck = fakePlane({ script: Array(1000).fill("provisioning") });
    await expect(controller(stuck, { warmTimeoutMs: 5 }).ensureReady()).rejects.toThrow(/did not become ready/);
  });

  it("stops after the idle window once the last job releases, and a new job cancels it", async () => {
    vi.useFakeTimers();
    const plane = fakePlane({ initial: "ready" });
    const ctl = controller(plane, { idleStopMs: 10 * 60 * 1000 });
    ctl.acquire();
    ctl.release();
    expect(ctl.snapshot()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    ctl.acquire(); // new job inside the window
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    expect(plane.calls.some((c) => c.url.endsWith("/stop"))).toBe(false);
    ctl.release();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 - 1);
    expect(plane.calls.some((c) => c.url.endsWith("/stop"))).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 5));
    expect(plane.calls.filter((c) => c.url.endsWith("/stop"))).toHaveLength(1);
    expect(plane.status).toBe("stopped");
  });

  it("adopts an already-running deployment so it cannot bill forever", async () => {
    const plane = fakePlane({ initial: "ready" });
    const ctl = controller(plane, { idleStopMs: 5 });
    await ctl.adopt();
    expect(ctl.snapshot()?.idleStopAt).toBeTruthy();
    await new Promise((r) => setTimeout(r, 40));
    expect(plane.status).toBe("stopped");
  });
});

describe("Runner with a deployment", () => {
  async function setup(plane: ReturnType<typeof fakePlane>) {
    const dir = await mkdtemp(path.join(tmpdir(), "dropcut-dep-"));
    dirs.push(dir);
    const cfg = loadConfig({ GENERATION_BACKEND: "mock", MOCK_LATENCY_MS: "0" });
    cfg.outputsDir = dir;
    const store = new JobStore(dir);
    await store.load();
    const adapter = new MockAdapter({ failRate: 0, latencyMs: 0 });
    const submit = vi.spyOn(adapter, "submitSegment");
    const ctl = controller(plane, { idleStopMs: 20 });
    const loaded: LoadedWorkflow = { workflow: null, map: null, problems: [], placeholder: true };
    const runner = new Runner({ store, adapter, cfg, workflow: loaded, deployment: ctl });
    const job = await store.create({
      backend: "mock",
      cutlist: buildCutlist({
        clipStart: 0, clipEnd: 2, drops: [1], beats: [0, 0.5, 1, 1.5], photoCount: 1,
        lookIds: ["neon"], transition: "hard", captionStyle: "block", seed: 7, bpm: 120,
      }),
      photos: [{ filename: "pixel.png", contentType: "image/png", bytes: TINY_PNG }],
    });
    return { store, runner, job, submit, ctl };
  }

  it("warms the GPU before any submit, then idle-stops after the job", async () => {
    const plane = fakePlane();
    const { store, runner, job, submit } = await setup(plane);
    const order: string[] = [];
    submit.mockImplementation(async function (this: unknown, ...args) {
      order.push(`submit@${plane.status}`);
      return MockAdapter.prototype.submitSegment.apply(this as MockAdapter, args as never);
    });
    await runner.run(job.id);
    const done = store.get(job.id)!;
    expect(done.status).toBe("done");
    expect(order.every((o) => o === "submit@ready")).toBe(true);
    expect(done.deployment?.phase).toBe("ready");
    expect(done.deployment?.idleStopAt).toBeTruthy();
    await new Promise((r) => setTimeout(r, 60));
    expect(plane.status).toBe("stopped");
  });

  it("fails queued segments without submitting when the GPU cannot start", async () => {
    const plane = fakePlane({ startFails: true });
    const { store, runner, job, submit } = await setup(plane);
    await runner.run(job.id);
    const failed = store.get(job.id)!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/Deployment POST \/start failed/);
    expect(submit).not.toHaveBeenCalled();
  });
});
