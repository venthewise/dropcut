import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HealthResponse, JobResponse } from "../shared/api-types";
import { buildCutlist } from "../shared/cutlist";
import { createApp } from "./app";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const SECRET = "comfyui-SUPERSECRETKEY99";
const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const PLACEHOLDER_ENV = {
  COMFY_WORKFLOW: "server/test-fixtures/placeholder.api.json",
  COMFY_WORKFLOW_MAP: "server/test-fixtures/placeholder.map.json",
};

async function listen(env: NodeJS.ProcessEnv) {
  const dir = await mkdtemp(path.join(tmpdir(), "dropcut-http-"));
  dirs.push(dir);
  const handle = await createApp({ env, outputsDir: dir });
  const server = handle.app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, handle };
}

function sampleCut() {
  return buildCutlist({
    clipStart: 0,
    clipEnd: 2,
    drops: [1],
    beats: [],
    photoCount: 1,
    lookIds: ["neon"],
    transition: "whip",
    captionStyle: "stamp",
    seed: 3,
    bpm: 100,
  });
}

describe("HTTP API", () => {
  it("serves health without the API key and runs a mock job", async () => {
    const { base } = await listen({
      GENERATION_BACKEND: "mock",
      COMFY_CLOUD_API_KEY: SECRET,
      ...PLACEHOLDER_ENV,
      MOCK_FAIL_RATE: "0",
      MOCK_LATENCY_MS: "0",
    });
    const healthRes = await fetch(`${base}/api/health`);
    const healthText = await healthRes.text();
    expect(healthText).not.toContain(SECRET);
    expect(healthText).not.toContain("comfyui-");
    const health = JSON.parse(healthText) as HealthResponse;
    expect(health.ok).toBe(true);
    expect(health.backend).toBe("mock");
    expect(health.backendLabel).toBe("MOCK");
    expect(health.deployment).toBeNull();
    expect(health.keyConfigured).toBe(true);
    expect(health.workflow.placeholder).toBe(true);
    expect(health.workflow.ready).toBe(true);

    const form = new FormData();
    form.append("cutlist", JSON.stringify(sampleCut()));
    form.append("photos", new Blob([new Uint8Array(TINY_PNG)], { type: "image/png" }), "pixel.png");
    const created = await fetch(`${base}/api/jobs`, { method: "POST", body: form });
    expect(created.status).toBe(201);
    let job = (await created.json()) as JobResponse;
    expect(JSON.stringify(job)).not.toContain(SECRET);

    for (let i = 0; i < 40 && job.status !== "done" && job.status !== "failed"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      job = (await (await fetch(`${base}/api/jobs/${job.id}`)).json()) as JobResponse;
    }
    expect(job.status).toBe("done");
    const file = await fetch(`${base}${job.segments[0]!.fileUrl}`);
    expect(file.ok).toBe(true);
    expect(file.headers.get("content-type")).toContain("image/svg+xml");
    const svg = await file.text();
    expect(svg).toContain("data-look");
    const cutlist = await fetch(`${base}/api/jobs/${job.id}/cutlist.json`);
    expect(cutlist.ok).toBe(true);
    expect(cutlist.headers.get("content-disposition")).toContain("cutlist.json");
  });

  it("refuses Comfy Cloud generation while the workflow is still a placeholder", async () => {
    const { base } = await listen({
      GENERATION_BACKEND: "comfy-cloud",
      COMFY_CLOUD_API_KEY: SECRET,
      ...PLACEHOLDER_ENV,
      COMFY_CLOUD_BASE_URL: "http://127.0.0.1:9",
    });
    const health = (await (await fetch(`${base}/api/health`)).json()) as HealthResponse;
    expect(health.backend).toBe("comfy-cloud");
    expect(health.backendLabel).toBe("COMFY CLOUD");
    expect(health.workflow.ready).toBe(false);
    expect(JSON.stringify(health)).not.toContain(SECRET);
    const form = new FormData();
    form.append("cutlist", JSON.stringify(sampleCut()));
    form.append("photos", new Blob([new Uint8Array(TINY_PNG)], { type: "image/png" }), "pixel.png");
    const res = await fetch(`${base}/api/jobs`, { method: "POST", body: form });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/placeholder/i);
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });
});
