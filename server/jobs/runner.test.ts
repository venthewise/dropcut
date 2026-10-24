import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCutlist } from "../../shared/cutlist";
import { loadConfig } from "../config";
import { MockAdapter, shouldFail } from "../generation/mock";
import type { LoadedWorkflow } from "../generation/workflow";
import { Runner } from "./runner";
import { JobStore } from "./store";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function cut() {
  return buildCutlist({
    clipStart: 0,
    clipEnd: 2,
    drops: [1],
    beats: [0, 0.5, 1, 1.5],
    photoCount: 1,
    lookIds: ["neon", "film"],
    transition: "hard",
    captionStyle: "block",
    seed: 7,
    bpm: 120,
  });
}

const loaded: LoadedWorkflow = { workflow: null, map: null, problems: [], placeholder: true };

async function setup(failRate: number) {
  const dir = await mkdtemp(path.join(tmpdir(), "dropcut-"));
  dirs.push(dir);
  const cfg = loadConfig({ GENERATION_BACKEND: "mock", MOCK_FAIL_RATE: String(failRate), MOCK_LATENCY_MS: "0" });
  cfg.outputsDir = dir;
  cfg.maxConcurrent = 2;
  const store = new JobStore(dir);
  await store.load();
  const adapter = new MockAdapter({ failRate, latencyMs: 0 });
  const runner = new Runner({ store, adapter, cfg, workflow: loaded });
  return { dir, store, adapter, runner, cfg };
}

describe("mock job run", () => {
  it("fails deterministically from the cache key and attempt", () => {
    expect(shouldFail("abc", 1, 0)).toBe(false);
    expect(shouldFail("abc", 1, 1)).toBe(true);
    expect(shouldFail("abc", 1, 0.5)).toBe(shouldFail("abc", 1, 0.5));
  });

  it("runs every segment, writes files, and skips finished cache hits", async () => {
    const { store, adapter, runner } = await setup(0);
    const job = await store.create({
      backend: "mock",
      cutlist: cut(),
      photos: [{ filename: "pixel.png", contentType: "image/png", bytes: TINY_PNG }],
    });
    expect(job.segments.length).toBeGreaterThan(1);
    await runner.run(job.id);
    const done = store.get(job.id)!;
    expect(done.status).toBe("done");
    expect(done.segments.every((seg) => seg.status === "done")).toBe(true);
    const manifest = JSON.parse(await readFile(path.join(store.root, job.id, "manifest.json"), "utf8")) as { status: string };
    expect(manifest.status).toBe("done");
    const first = done.segments[0]!;
    const svg = await readFile(store.segmentAbs(job.id, first.filename!), "utf8");
    expect(svg).toContain(`data-look="${first.look}"`);
    const submits = adapter.submits;

    const again = await store.create({
      backend: "mock",
      cutlist: cut(),
      photos: [{ filename: "pixel.png", contentType: "image/png", bytes: TINY_PNG }],
    });
    await runner.run(again.id);
    expect(store.get(again.id)!.status).toBe("done");
    expect(adapter.submits).toBe(submits);
  });

  it("records a deterministic failure and can retry when the rate allows it", async () => {
    const { store, runner } = await setup(1);
    const job = await store.create({
      backend: "mock",
      cutlist: cut(),
      photos: [{ filename: "pixel.png", contentType: "image/png", bytes: TINY_PNG }],
    });
    await runner.run(job.id);
    expect(store.get(job.id)!.status).toBe("failed");
    expect(store.get(job.id)!.segments.every((seg) => seg.status === "failed")).toBe(true);

    const retry = await setup(0);
    const ok = await retry.store.create({
      backend: "mock",
      cutlist: cut(),
      photos: [{ filename: "pixel.png", contentType: "image/png", bytes: TINY_PNG }],
    });
    await retry.runner.run(ok.id);
    expect(retry.store.get(ok.id)!.status).toBe("done");
  });
});
