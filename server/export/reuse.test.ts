import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCutlist } from "../../shared/cutlist";
import { loadConfig } from "../config";
import { MockAdapter } from "../generation/mock";
import type { LoadedWorkflow } from "../generation/workflow";
import { Runner } from "../jobs/runner";
import { editSegment, sha256, JobStore } from "../jobs/store";
import { resolveBinaries } from "./binaries";
import { ExportManager } from "./manager";

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

function toneWav(seconds: number): Buffer {
  const sampleRate = 8000;
  const count = Math.floor(sampleRate * seconds);
  const data = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 8000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const loaded: LoadedWorkflow = { workflow: null, map: null, problems: [], placeholder: true };

async function waitDone(manager: ExportManager, jobId: string) {
  let view = await manager.status(jobId);
  for (let i = 0; i < 80 && (view.status === "running" || view.status === "idle"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    view = await manager.status(jobId);
  }
  return view;
}

describe("edited row cache", () => {
  it("regenerates only the edited row and reuses the other plates on export", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dropcut-reuse-"));
    dirs.push(dir);
    const cfg = loadConfig({
      GENERATION_BACKEND: "mock",
      MOCK_FAIL_RATE: "0",
      MOCK_LATENCY_MS: "0",
      EXPORT_FPS: "30",
      EXPORT_END_CARD_URL: "",
    });
    cfg.outputsDir = dir;
    cfg.maxConcurrent = 2;
    const store = new JobStore(dir);
    await store.load();
    const adapter = new MockAdapter({ failRate: 0, latencyMs: 0 });
    const runner = new Runner({ store, adapter, cfg, workflow: loaded });
    const job = await store.create({
      backend: "mock",
      cutlist: cut(),
      photos: [{ filename: "pixel.png", contentType: "image/png", bytes: TINY_PNG }],
      audio: { filename: "song.wav", contentType: "audio/wav", bytes: toneWav(3) },
    });
    expect(job.segments.length).toBeGreaterThan(1);
    await runner.run(job.id);
    const finished = store.get(job.id)!;
    expect(finished.status).toBe("done");
    const submits = adapter.submits;
    const kept = finished.segments[1]!;
    const keptBefore = sha256(await readFile(store.segmentAbs(job.id, kept.filename!)));
    const edited = finished.segments[0]!;
    const editedBefore = sha256(await readFile(store.segmentAbs(job.id, edited.filename!)));

    const change = editSegment(finished, edited.id, { look: "ink" });
    expect(change.requeued).toBe(true);
    expect(finished.segments.filter((segment) => segment.status === "queued")).toHaveLength(1);
    await runner.run(job.id);
    const rerun = store.get(job.id)!;
    expect(rerun.status).toBe("done");
    expect(adapter.submits).toBe(submits + 1);
    const keptAfter = sha256(await readFile(store.segmentAbs(job.id, rerun.segments[1]!.filename!)));
    expect(keptAfter).toBe(keptBefore);
    const editedAfter = sha256(await readFile(store.segmentAbs(job.id, rerun.segments[0]!.filename!)));
    expect(editedAfter).not.toBe(editedBefore);
    expect(await readFile(store.segmentAbs(job.id, rerun.segments[0]!.filename!), "utf8")).toContain('data-look="ink"');

    const bins = await resolveBinaries({});
    if (!bins.ffmpeg) {
      console.info("[export] skipped re-export assertions: ffmpeg not available");
      return;
    }
    const manager = new ExportManager({ store, cfg, ffmpeg: async () => bins.ffmpeg });
    const started = await manager.start(job.id);
    expect(started.status).toBe("running");
    const done = await waitDone(manager, job.id);
    expect(done.status, done.error).toBe("done");
    const mp4 = path.join(dir, job.id, "export", "reel.mp4");
    const firstStat = await stat(mp4);
    expect(firstStat.size).toBeGreaterThan(1000);
    const submitsAfterExport = adapter.submits;

    const cached = await manager.start(job.id);
    expect(cached.cached).toBe(true);
    expect(cached.status).toBe("done");
    expect((await stat(mp4)).mtimeMs).toBe(firstStat.mtimeMs);
    expect(adapter.submits).toBe(submitsAfterExport);
    expect(sha256(await readFile(store.segmentAbs(job.id, rerun.segments[1]!.filename!)))).toBe(keptBefore);

    const plates = await Promise.all(rerun.segments.map(async (segment) => sha256(await readFile(store.segmentAbs(job.id, segment.filename!)))));
    const recut = await manager.start(job.id, { [edited.id]: "BRAND NEW" });
    expect(recut.cached).not.toBe(true);
    expect(recut.status).toBe("running");
    const burned = await waitDone(manager, job.id);
    expect(burned.status, burned.error).toBe("done");
    expect((await stat(mp4)).mtimeMs).not.toBe(firstStat.mtimeMs);
    expect(adapter.submits).toBe(submitsAfterExport);
    const platesAfter = await Promise.all(rerun.segments.map(async (segment) => sha256(await readFile(store.segmentAbs(job.id, segment.filename!)))));
    expect(platesAfter).toEqual(plates);
  }, 60_000);
});
