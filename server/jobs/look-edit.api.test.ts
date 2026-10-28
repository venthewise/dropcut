import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExportResponse, JobResponse } from "../../shared/api-types";
import { buildCutlist, segmentSeed } from "../../shared/cutlist";
import { renderPrompt } from "../../shared/looks";
import { createApp } from "../app";
import { EXPORT_HEIGHT, EXPORT_WIDTH } from "../export/ass";
import { resolveBinaries } from "../export/binaries";
import { EXPORT_FADE_SECONDS } from "../export/graph";
import { exportCacheKey } from "../export/key";
import { MockAdapter } from "../generation/mock";
import { sha256 } from "./store";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const PLACEHOLDER_ENV = {
  GENERATION_BACKEND: "mock",
  MOCK_FAIL_RATE: "0",
  MOCK_LATENCY_MS: "0",
  EXPORT_FPS: "30",
  EXPORT_END_CARD_URL: "",
  COMFY_WORKFLOW: "server/test-fixtures/placeholder.api.json",
  COMFY_WORKFLOW_MAP: "server/test-fixtures/placeholder.map.json",
};

const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function sha(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function toneWav(seconds: number): Buffer {
  const sampleRate = 8000;
  const count = Math.floor(sampleRate * seconds);
  const data = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 180 * i) / sampleRate) * 6000), i * 2);
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

function cut(lookIds: string[]) {
  return buildCutlist({
    clipStart: 0,
    clipEnd: 2,
    drops: [1],
    beats: [0, 0.5, 1, 1.5],
    photoCount: 1,
    lookIds,
    transition: "hard",
    captionStyle: "block",
    seed: 7,
    bpm: 120,
  });
}

async function listen(adapter: MockAdapter) {
  const dir = await mkdtemp(path.join(tmpdir(), "dropcut-look-"));
  dirs.push(dir);
  const handle = await createApp({ env: PLACEHOLDER_ENV, outputsDir: dir, adapter, deployment: null });
  const server = handle.app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, dir, adapter };
}

async function postJob(base: string, lookIds: string[], withAudio: boolean): Promise<JobResponse> {
  const form = new FormData();
  form.append("cutlist", JSON.stringify(cut(lookIds)));
  form.append("photos", new Blob([new Uint8Array(TINY_PNG)], { type: "image/png" }), "pixel.png");
  if (withAudio) form.append("audio", new Blob([new Uint8Array(toneWav(3))], { type: "audio/wav" }), "tone.wav");
  const created = await fetch(`${base}/api/jobs`, { method: "POST", body: form });
  expect(created.status).toBe(201);
  return (await created.json()) as JobResponse;
}

async function waitDone(base: string, id: string): Promise<JobResponse> {
  let job = (await (await fetch(`${base}/api/jobs/${id}`)).json()) as JobResponse;
  for (let i = 0; i < 50 && job.status !== "done" && job.status !== "failed"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    job = (await (await fetch(`${base}/api/jobs/${id}`)).json()) as JobResponse;
  }
  return job;
}

async function plate(base: string, job: JobResponse, id: string): Promise<string> {
  const seg = job.segments.find((item) => item.id === id);
  expect(seg?.fileUrl).toBeTruthy();
  const res = await fetch(`${base}${seg!.fileUrl}`);
  expect(res.ok).toBe(true);
  return res.text();
}

async function patchLook(base: string, jobId: string, segmentId: string, body: string, contentType = "application/json") {
  return fetch(`${base}/api/jobs/${jobId}/segments/${segmentId}`, {
    method: "PATCH",
    headers: { "Content-Type": contentType },
    body,
  });
}

describe("per-row look edit", () => {
  it("rejects a bad job, segment, or look", async () => {
    const { base } = await listen(new MockAdapter({ failRate: 0, latencyMs: 0 }));
    const missingJob = await patchLook(base, "00000000-0000-4000-8000-000000000000", "s00", JSON.stringify({ look: "ink" }));
    expect(missingJob.status).toBe(404);

    const created = await postJob(base, ["neon", "film"], false);
    const badId = await patchLook(base, created.id, "nope", JSON.stringify({ look: "ink" }));
    expect(badId.status).toBe(400);
    const unknownSeg = await patchLook(base, created.id, "s99", JSON.stringify({ look: "ink" }));
    expect(unknownSeg.status).toBe(404);
    const missingLook = await patchLook(base, created.id, "s00", JSON.stringify({}));
    expect(missingLook.status).toBe(400);
    const wrongType = await patchLook(base, created.id, "s00", JSON.stringify({ look: 1 }));
    expect(wrongType.status).toBe(400);
    const unknownLook = await patchLook(base, created.id, "s00", JSON.stringify({ look: "pastel" }));
    expect(unknownLook.status).toBe(400);
    expect((await unknownLook.json() as { error: string }).error).toMatch(/unknown look/i);
    const badJson = await patchLook(base, created.id, "s00", "{");
    expect(badJson.status).toBe(400);

    const done = await waitDone(base, created.id);
    expect(done.status).toBe("done");
    const before = await plate(base, done, "s00");
    const same = await patchLook(base, created.id, "s00", JSON.stringify({ look: done.segments[0]!.look }));
    expect(same.status).toBe(200);
    const unchanged = (await same.json()) as JobResponse;
    expect(unchanged.status).toBe("done");
    expect(unchanged.segments.every((seg) => seg.status === "done")).toBe(true);
    expect(unchanged.segments.map((seg) => seg.attempt)).toEqual(done.segments.map((seg) => seg.attempt));
    expect(await plate(base, unchanged, "s00")).toBe(before);
  });

  it("re-renders only the edited row and the export uses that plate", async () => {
    const adapter = new MockAdapter({ failRate: 0, latencyMs: 0 });
    const { base, dir } = await listen(adapter);
    const created = await postJob(base, ["neon", "film"], true);
    const done = await waitDone(base, created.id);
    expect(done.status).toBe("done");
    expect(done.segments.length).toBeGreaterThan(1);
    const edited = done.segments[0]!;
    const kept = done.segments[1]!;
    expect(edited.look).toBe("neon");
    const submits = adapter.submits;
    const keptBefore = sha(await plate(base, done, kept.id));
    const editedBefore = await plate(base, done, edited.id);
    const attempts = new Map(done.segments.map((seg) => [seg.id, seg.attempt]));
    const oldManifest = await readManifest(dir, done.id);

    const patchedRes = await patchLook(base, done.id, edited.id, JSON.stringify({ look: "ink" }));
    expect(patchedRes.status).toBe(200);
    const patched = (await patchedRes.json()) as JobResponse;
    expect(patched.segments.find((seg) => seg.id === edited.id)?.status).toBe("queued");
    expect(patched.segments.find((seg) => seg.id === edited.id)?.look).toBe("ink");
    expect(patched.status).toBe("running");
    for (const seg of patched.segments) {
      if (seg.id === edited.id) continue;
      expect(seg.status).toBe("done");
      expect(seg.attempt).toBe(attempts.get(seg.id));
      expect(seg.fileUrl).toBeTruthy();
    }
    expect(patched.cutlist.segments.map((seg) => [seg.start, seg.end])).toEqual(
      done.cutlist.segments.map((seg) => [seg.start, seg.end]),
    );
    expect(patched.cutlist.segments.map((seg) => seg.caption)).toEqual(done.cutlist.segments.map((seg) => seg.caption));
    const editedCut = patched.cutlist.segments.find((seg) => seg.id === edited.id)!;
    expect(editedCut.seed).toBe(segmentSeed(Math.round(done.cutlist.seed), editedCut.index, "ink", editedCut.photoIndex));
    expect(editedCut.prompt).toBe(renderPrompt("ink").positive);

    const again = await waitDone(base, done.id);
    expect(again.status).toBe("done");
    expect(adapter.submits).toBe(submits + 1);
    const keptAfter = sha(await plate(base, again, kept.id));
    expect(keptAfter).toBe(keptBefore);
    const editedSvg = await plate(base, again, edited.id);
    expect(editedSvg).toContain('data-look="ink"');
    expect(editedSvg).not.toBe(editedBefore);
    expect(again.segments.find((seg) => seg.id === kept.id)?.attempt).toBe(attempts.get(kept.id));
    expect(again.segments.find((seg) => seg.id === edited.id)?.attempt).toBe((attempts.get(edited.id) ?? 0) + 1);

    const afterManifest = await readManifest(dir, done.id);
    const oldKey = oldManifest.segments.find((seg) => seg.id === edited.id)?.cacheKey;
    const newKey = afterManifest.segments.find((seg) => seg.id === edited.id)?.cacheKey;
    expect(newKey).toBeTruthy();
    expect(newKey).not.toBe(oldKey);
    for (const seg of afterManifest.segments) {
      if (seg.id === edited.id) continue;
      expect(seg.cacheKey).toBe(oldManifest.segments.find((item) => item.id === seg.id)?.cacheKey);
    }

    const bins = await resolveBinaries(PLACEHOLDER_ENV);
    if (!bins.ffmpeg) {
      console.info("[look-edit] skipped export assertions: ffmpeg not available");
      return;
    }
    const first = await exportMp4(base, done.id);
    expect(first.cached).not.toBe(true);
    const record = JSON.parse(await readFile(path.join(dir, done.id, "export", "export.json"), "utf8")) as { key: string };
    const exported = await readManifest(dir, done.id);
    expect(record.key).toBe(await cacheKeyFor(dir, done.id, exported, exported.segments.map((seg) => seg.cacheKey)));
    const staleKeys = exported.segments.map((seg) => (seg.id === edited.id ? oldKey! : seg.cacheKey));
    expect(record.key).not.toBe(await cacheKeyFor(dir, done.id, exported, staleKeys));
    const mp4 = await readFile(path.join(dir, done.id, "export", "reel.mp4"));
    expect(mp4.length).toBeGreaterThan(1000);
    expect(mp4.subarray(4, 8).toString("latin1")).toBe("ftyp");

    const cached = await exportMp4(base, done.id);
    expect(cached.cached).toBe(true);
    expect(adapter.submits).toBe(submits + 1);
    expect(sha(await plate(base, again, kept.id))).toBe(keptBefore);
    expect(await plate(base, again, edited.id)).toBe(editedSvg);
  }, 60_000);

  it("matches a cut list that assigned that look up front", async () => {
    const { base } = await listen(new MockAdapter({ failRate: 0, latencyMs: 0 }));
    const editedJob = await waitDone(base, (await postJob(base, ["neon", "film"], false)).id);
    expect(editedJob.status).toBe("done");
    const keptBefore = await plate(base, editedJob, editedJob.segments[1]!.id);
    const patched = await patchLook(base, editedJob.id, editedJob.segments[0]!.id, JSON.stringify({ look: "ink" }));
    expect(patched.status).toBe(200);
    const changed = await waitDone(base, editedJob.id);
    expect(changed.status).toBe("done");
    expect(await plate(base, changed, changed.segments[1]!.id)).toBe(keptBefore);

    const direct = await waitDone(base, (await postJob(base, ["ink", "film"], false)).id);
    expect(direct.status).toBe("done");
    expect(await plate(base, changed, changed.segments[0]!.id)).toBe(await plate(base, direct, direct.segments[0]!.id));
    expect(await plate(base, changed, changed.segments[1]!.id)).toBe(await plate(base, direct, direct.segments[1]!.id));
    expect(changed.cutlist.segments[0]!.seed).toBe(direct.cutlist.segments[0]!.seed);
    expect(changed.cutlist.segments[0]!.prompt).toBe(direct.cutlist.segments[0]!.prompt);
    expect(changed.cutlist.segments.map((seg) => [seg.start, seg.end])).toEqual(
      direct.cutlist.segments.map((seg) => [seg.start, seg.end]),
    );
  });
});

interface ManifestFile {
  audioFile: string;
  cutlist: JobResponse["cutlist"];
  segments: { id: string; cacheKey: string }[];
}

async function readManifest(dir: string, jobId: string): Promise<ManifestFile> {
  return JSON.parse(await readFile(path.join(dir, jobId, "manifest.json"), "utf8")) as ManifestFile;
}

async function cacheKeyFor(dir: string, jobId: string, manifest: ManifestFile, segmentCacheKeys: string[]): Promise<string> {
  const song = sha256(await readFile(path.join(dir, jobId, manifest.audioFile)));
  return exportCacheKey({
    segmentCacheKeys,
    rows: manifest.cutlist.segments.map((seg) => ({
      id: seg.id,
      start: seg.start,
      end: seg.end,
      caption: seg.caption,
      captionStyle: seg.captionStyle,
      transition: seg.transition,
    })),
    songSha256: song,
    fps: 30,
    width: EXPORT_WIDTH,
    height: EXPORT_HEIGHT,
    endCardUrl: "",
    endCardSeconds: 0,
    fadeSeconds: EXPORT_FADE_SECONDS,
  });
}

async function exportMp4(base: string, jobId: string): Promise<ExportResponse> {
  const started = await fetch(`${base}/api/jobs/${jobId}/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  expect([200, 202]).toContain(started.status);
  let exp = (await started.json()) as ExportResponse;
  for (let i = 0; i < 80 && exp.status === "running"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    exp = (await (await fetch(`${base}/api/jobs/${jobId}/export`)).json()) as ExportResponse;
  }
  expect(exp.status, exp.error).toBe("done");
  return exp;
}
