/**
 * Proves a mock job against a running DropCut server.
 * Start the server first with GENERATION_BACKEND=mock, then: npm run smoke
 * SMOKE_BASE_URL overrides the default http://127.0.0.1:8787
 */
import { buildCutlist } from "../shared/cutlist";
import type { HealthResponse, JobResponse } from "../shared/api-types";

const base = (process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function clickWav(): Buffer {
  const sampleRate = 8000;
  const seconds = 2;
  const count = sampleRate * seconds;
  const data = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) {
    const click = i % sampleRate < 180;
    data.writeInt16LE(click ? 14000 : 0, i * 2);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const healthRes = await fetch(`${base}/api/health`);
  if (!healthRes.ok) throw new Error(`health ${healthRes.status}`);
  const health = (await healthRes.json()) as HealthResponse;
  if (health.backend !== "mock") {
    throw new Error(`expected mock backend, got ${health.backend}. Start with GENERATION_BACKEND=mock.`);
  }
  if (JSON.stringify(health).includes("comfyui-")) throw new Error("health leaked a key prefix");
  console.log(`[smoke] health backend=${health.backend} workflowReady=${health.workflow.ready}`);

  const cutlist = buildCutlist({
    clipStart: 0,
    clipEnd: 2,
    drops: [1],
    beats: [0, 0.5, 1, 1.5],
    photoCount: 1,
    lookIds: ["neon", "ink"],
    transition: "hard",
    captionStyle: "block",
    seed: 4,
    bpm: 120,
  });
  const form = new FormData();
  form.append("cutlist", JSON.stringify(cutlist));
  form.append("photos", new Blob([new Uint8Array(TINY_PNG)], { type: "image/png" }), "pixel.png");
  form.append("audio", new Blob([new Uint8Array(clickWav())], { type: "audio/wav" }), "clicks.wav");

  const created = await fetch(`${base}/api/jobs`, { method: "POST", body: form });
  if (created.status !== 201) {
    throw new Error(`create ${created.status}: ${await created.text()}`);
  }
  let job = (await created.json()) as JobResponse;
  console.log(`[smoke] job ${job.id} segments=${job.segments.length}`);

  for (let i = 0; i < 50 && job.status !== "done" && job.status !== "failed"; i++) {
    await sleep(80);
    const res = await fetch(`${base}/api/jobs/${job.id}`);
    if (!res.ok) throw new Error(`poll ${res.status}`);
    job = (await res.json()) as JobResponse;
  }
  if (job.status !== "done") {
    throw new Error(`job ended ${job.status}: ${job.segments.map((seg) => seg.error ?? seg.status).join(", ")}`);
  }

  const fileUrl = job.segments[0]?.fileUrl;
  if (!fileUrl) throw new Error("missing segment file");
  const file = await fetch(`${base}${fileUrl}`);
  if (!file.ok) throw new Error(`segment file ${file.status}`);
  const svg = await file.text();
  if (!svg.includes("<svg")) throw new Error("segment file was not an SVG placeholder");

  const cut = await fetch(`${base}/api/jobs/${job.id}/cutlist.json`);
  if (!cut.ok) throw new Error(`cutlist ${cut.status}`);
  const body = (await cut.json()) as { segments?: unknown[] };
  if (!body.segments || body.segments.length !== job.segments.length) throw new Error("cut list length mismatch");

  console.log(`[smoke] ok ${job.id} ${job.segments.length} segments`);
}

main().catch((err: unknown) => {
  console.error(`[smoke] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
