/**
 * One real Comfy Cloud segment through a running DropCut server (spends credits).
 * Start the server with GENERATION_BACKEND=comfy-cloud, then:
 *   npx tsx scripts/cloud-test.ts <image.png> [seconds=2.5]
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildCutlist } from "../shared/cutlist";
import type { HealthResponse, JobResponse } from "../shared/api-types";

const base = (process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");

function silentWav(seconds: number): Buffer {
  const rate = 8000;
  const data = Buffer.alloc(Math.round(rate * seconds) * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

async function main(): Promise<void> {
  const imagePath = process.argv[2];
  const seconds = Number(process.argv[3] ?? "2.5");
  if (!imagePath) throw new Error("usage: tsx scripts/cloud-test.ts <image.png> [seconds]");
  const health = (await (await fetch(`${base}/api/health`)).json()) as HealthResponse;
  console.log(`[cloud-test] backend=${health.backend} ready=${health.workflow.ready} deployment=${health.deployment ? health.deployment.status : "none"}`);
  if (health.backend !== "comfy-cloud" || !health.workflow.ready) {
    throw new Error(`not ready: ${JSON.stringify(health.workflow.problems)}`);
  }
  const cutlist = buildCutlist({
    clipStart: 0, clipEnd: seconds, drops: [], beats: [], photoCount: 1,
    lookIds: ["neon"], transition: "hard", captionStyle: "block", seed: 11, bpm: 120,
  });
  if (cutlist.segments.length !== 1) throw new Error(`expected 1 segment, got ${cutlist.segments.length}`);
  const form = new FormData();
  form.append("cutlist", JSON.stringify(cutlist));
  form.append("photos", new Blob([new Uint8Array(await readFile(imagePath))], { type: "image/png" }), path.basename(imagePath));
  form.append("audio", new Blob([new Uint8Array(silentWav(seconds))], { type: "audio/wav" }), "silence.wav");
  const t0 = Date.now();
  const created = await fetch(`${base}/api/jobs`, { method: "POST", body: form });
  if (created.status !== 201) throw new Error(`create ${created.status}: ${await created.text()}`);
  let job = (await created.json()) as JobResponse;
  console.log(`[cloud-test] job ${job.id} segment ${cutlist.segments[0]!.duration.toFixed(2)}s`);
  let last = "";
  let readyAt: number | undefined;
  while (job.status !== "done" && job.status !== "failed") {
    await new Promise((r) => setTimeout(r, 3000));
    job = (await (await fetch(`${base}/api/jobs/${job.id}`)).json()) as JobResponse;
    const s = job.segments[0]!;
    const dep = job.deployment;
    if (dep?.phase === "ready" && readyAt === undefined) readyAt = Date.now();
    const warm = dep && dep.phase !== "ready" ? ` | deploy ${dep.status}${dep.step ? `/${dep.step}` : ""}${typeof dep.stepProgress === "number" ? ` ${Math.round(dep.stepProgress * 100)}%` : ""}` : "";
    const line = `${s.status} ${Math.round((s.progress ?? 0) * 100)}%${warm}`;
    if (line !== last) console.log(`[cloud-test] +${Math.round((Date.now() - t0) / 1000)}s ${line}`);
    last = line;
    if (Date.now() - t0 > 40 * 60 * 1000) throw new Error("timed out after 40 min");
  }
  const seg = job.segments[0]!;
  const end = Date.now();
  console.log(`[cloud-test] ${job.status} in ${Math.round((end - t0) / 1000)}s`
    + (readyAt ? ` (warm-up ~${Math.round((readyAt - t0) / 1000)}s, job ~${Math.round((end - readyAt) / 1000)}s` : "")
    + (job.deployment?.lastColdStartSeconds != null ? `, server-measured cold start ${job.deployment.lastColdStartSeconds}s)` : readyAt ? ")" : ""));
  if (job.status !== "done") throw new Error(`failed: ${seg.error ?? "unknown"}`);
  console.log(`[cloud-test] file ${seg.fileUrl} (${seg.contentType ?? "?"}) job dir outputs/${job.id}`);
}

main().catch((err: unknown) => {
  console.error(`[cloud-test] ERROR ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
