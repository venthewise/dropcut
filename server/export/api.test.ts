import { execFile } from "node:child_process";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExportResponse, HealthResponse, JobResponse } from "../../shared/api-types";
import { buildCutlist } from "../../shared/cutlist";
import { createApp } from "../app";
import { MockAdapter } from "../generation/mock";
import type { JobRef, SegmentStatus } from "../generation/types";
import { resolveBinaries } from "./binaries";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

class HoldAdapter extends MockAdapter {
  hold = true;

  override async getStatus(job: JobRef): Promise<SegmentStatus> {
    if (this.hold) return { state: "queued", progress: 0 };
    return super.getStatus(job);
  }
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

function probe(bin: string, file: string): Promise<{ streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number }[]; format?: { duration?: string } }> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file],
      { windowsHide: true, timeout: 20_000 },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(JSON.parse(stdout) as { streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number }[]; format?: { duration?: string } });
      },
    );
  });
}

describe("export API", () => {
  it("rejects an unfinished job, then renders a 1080x1920 H.264 MP4 and caches the next call", async () => {
    const holder = new HoldAdapter({ failRate: 0, latencyMs: 0 });
    const dir = await mkdtemp(path.join(tmpdir(), "dropcut-export-"));
    dirs.push(dir);
    const env = {
      GENERATION_BACKEND: "mock",
      MOCK_FAIL_RATE: "0",
      MOCK_LATENCY_MS: "0",
      EXPORT_FPS: "30",
      EXPORT_END_CARD_URL: "",
      COMFY_WORKFLOW: "server/test-fixtures/placeholder.api.json",
      COMFY_WORKFLOW_MAP: "server/test-fixtures/placeholder.map.json",
    };
    const handle = await createApp({ env, outputsDir: dir, adapter: holder, deployment: null });
    const server = handle.app.listen(0);
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const health = (await (await fetch(`${base}/api/health`)).json()) as HealthResponse;
      expect([null, "FFMPEG_PATH", "PATH", "ffmpeg-static"]).toContain(health.ffmpegSource);
      expect(health.ffmpeg).toBe(health.ffmpegSource != null);
      if (health.ffmpeg) expect(typeof health.ffmpegPath).toBe("string");

      const missing = await fetch(`${base}/api/jobs/not-a-job/export`, { method: "POST" });
      expect(missing.status).toBe(404);

      const cutlist = buildCutlist({
        clipStart: 0,
        clipEnd: 2,
        drops: [1],
        beats: [],
        photoCount: 1,
        lookIds: ["neon"],
        transition: "hard",
        captionStyle: "kick",
        seed: 4,
        bpm: 120,
      });
      const form = new FormData();
      form.append("cutlist", JSON.stringify(cutlist));
      form.append("photos", new Blob([new Uint8Array(TINY_PNG)], { type: "image/png" }), "pixel.png");
      form.append("audio", new Blob([new Uint8Array(toneWav(3))], { type: "audio/wav" }), "tone.wav");
      const created = await fetch(`${base}/api/jobs`, { method: "POST", body: form });
      expect(created.status).toBe(201);
      const job = (await created.json()) as JobResponse;

      const early = await fetch(`${base}/api/jobs/${job.id}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(early.status).toBe(409);

      holder.hold = false;
      let current = job;
      for (let i = 0; i < 50 && current.status !== "done" && current.status !== "failed"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        current = (await (await fetch(`${base}/api/jobs/${job.id}`)).json()) as JobResponse;
      }
      expect(current.status).toBe("done");

      const idle = (await (await fetch(`${base}/api/jobs/${job.id}/export`)).json()) as ExportResponse;
      expect(idle.status).toBe("idle");

      const bins = await resolveBinaries(env);
      if (!bins.ffmpeg || !bins.ffprobe) {
        console.info("[export] skipped ffmpeg integration: ffmpeg or ffprobe not available");
        return;
      }

      const startedRes = await fetch(`${base}/api/jobs/${job.id}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ captions: { [current.segments[0]!.id]: "Hit" } }),
      });
      expect(startedRes.status).toBe(202);
      let exp = (await startedRes.json()) as ExportResponse;
      for (let i = 0; i < 80 && exp.status === "running"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        exp = (await (await fetch(`${base}/api/jobs/${job.id}/export`)).json()) as ExportResponse;
      }
      expect(exp.status, exp.error).toBe("done");
      expect(exp.fileUrl).toBe(`/api/jobs/${job.id}/export/file`);

      const file = await fetch(`${base}${exp.fileUrl}`);
      expect(file.status).toBe(200);
      expect(file.headers.get("content-type")).toContain("video/mp4");
      expect(file.headers.get("content-disposition")).toContain("attachment");
      expect(file.headers.get("content-disposition")).toContain(".mp4");
      const bytes = Buffer.from(await file.arrayBuffer());
      expect(bytes.length).toBeGreaterThan(1000);

      const media = await probe(bins.ffprobe.path, path.join(dir, job.id, "export", "reel.mp4"));
      const video = media.streams?.find((stream) => stream.codec_type === "video");
      const audio = media.streams?.find((stream) => stream.codec_type === "audio");
      expect(video?.codec_name).toBe("h264");
      expect(video?.width).toBe(1080);
      expect(video?.height).toBe(1920);
      expect(audio?.codec_name).toBe("aac");
      expect(Math.abs(Number(media.format?.duration) - 2)).toBeLessThanOrEqual(0.1);

      const againRes = await fetch(`${base}/api/jobs/${job.id}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ captions: { [current.segments[0]!.id]: "Hit" } }),
      });
      expect(againRes.status).toBe(200);
      const again = (await againRes.json()) as ExportResponse;
      expect(again.cached).toBe(true);
      expect(again.status).toBe("done");
    } finally {
      holder.hold = false;
    }
  }, 60_000);
});
