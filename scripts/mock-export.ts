/**
 * Build a mock reel from the bundled samples and print the MP4 path.
 * Refuses to run unless GENERATION_BACKEND=mock. Does not read .env and
 * does not call Comfy Cloud.
 *
 *   npm run export:mock
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { ExportResponse, HealthResponse, JobResponse } from "../shared/api-types";
import { buildCutlist } from "../shared/cutlist";
import { createApp } from "../server/app";

const root = process.cwd();

function beats(start: number, end: number, step: number): number[] {
  const out: number[] = [];
  for (let t = start; t < end - 1e-6; t += step) out.push(Math.round(t * 1000) / 1000);
  return out;
}

async function fileBlob(name: string, type: string): Promise<Blob> {
  const bytes = await readFile(path.join(root, "samples", name));
  return new Blob([bytes], { type });
}

async function main(): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GENERATION_BACKEND: "mock",
    COMFY_CLOUD_API_KEY: "",
    COMFY_DEPLOYMENT_ID: "",
    MOCK_FAIL_RATE: "0",
    MOCK_LATENCY_MS: "0",
  };
  if (env.GENERATION_BACKEND !== "mock") {
    throw new Error("export:mock refuses to run unless GENERATION_BACKEND=mock.");
  }
  const handle = await createApp({ env, outputsDir: path.join(root, "outputs", "export-mock"), deployment: null });
  if (handle.cfg.backend !== "mock") throw new Error("Server did not stay in mock mode.");
  const server = createServer(handle.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const health = (await (await fetch(`${base}/api/health`)).json()) as HealthResponse;
    if (health.backend !== "mock") throw new Error(`expected mock, got ${health.backend}`);
    if (!health.ffmpeg) throw new Error("ffmpeg was not found. Set FFMPEG_PATH or install ffmpeg.");
    console.log(`[export:mock] ffmpeg ${health.ffmpegSource} ${health.ffmpegPath}`);

    const clipStart = 0;
    const clipEnd = 15;
    const cutlist = buildCutlist({
      clipStart,
      clipEnd,
      drops: [4, 8, 12],
      beats: beats(0, 16, 0.5),
      photoCount: 3,
      lookIds: ["neon", "film", "ink"],
      transition: "hard",
      captionStyle: "block",
      seed: 11,
      bpm: 120,
    });
    const form = new FormData();
    form.append("cutlist", JSON.stringify(cutlist));
    form.append("photos", await fileBlob("photo-a.png", "image/png"), "photo-a.png");
    form.append("photos", await fileBlob("photo-b.png", "image/png"), "photo-b.png");
    form.append("photos", await fileBlob("photo-c.png", "image/png"), "photo-c.png");
    form.append("audio", await fileBlob("song.wav", "audio/wav"), "song.wav");
    const created = await fetch(`${base}/api/jobs`, { method: "POST", body: form });
    if (created.status !== 201) throw new Error(`create ${created.status}: ${await created.text()}`);
    let job = (await created.json()) as JobResponse;
    console.log(`[export:mock] job ${job.id} segments=${job.segments.length}`);
    for (let i = 0; i < 80 && job.status !== "done" && job.status !== "failed"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      job = (await (await fetch(`${base}/api/jobs/${job.id}`)).json()) as JobResponse;
    }
    if (job.status !== "done") throw new Error(`job ${job.status}: ${job.error ?? "segments did not finish"}`);

    const started = await fetch(`${base}/api/jobs/${job.id}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (started.status !== 202 && started.status !== 200) {
      throw new Error(`export ${started.status}: ${await started.text()}`);
    }
    let exp = (await started.json()) as ExportResponse;
    for (let i = 0; i < 120 && exp.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      exp = (await (await fetch(`${base}/api/jobs/${job.id}/export`)).json()) as ExportResponse;
    }
    if (exp.status !== "done") throw new Error(exp.error || `export ${exp.status}`);
    const mp4 = path.join(root, "outputs", "export-mock", job.id, "export", "reel.mp4");
    console.log(mp4);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
