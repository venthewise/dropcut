import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";
import { buildAdapter } from "./generation";
import type { LoadedWorkflow } from "./generation/workflow";

const DEP = "https://dep-test.run.comfy.app";
const KEY = "comfyui-test-key-1234567890";

const loaded: LoadedWorkflow = {
  placeholder: false,
  problems: [],
  workflow: {
    "1": { class_type: "LoadImage", inputs: { image: "x.png" } },
    "2": { class_type: "SaveVideo", inputs: { filename_prefix: "dropcut" } },
  },
  map: { placeholder: false, bindings: { image: { nodeId: "1", input: "image" }, output: { nodeId: "2" } } } as never,
};

describe("dedicated deployment endpoint", () => {
  it("routes jobs to the endpoint and never manages the deployment by default", () => {
    const cfg = loadConfig({
      COMFY_CLOUD_API_KEY: KEY,
      COMFY_DEPLOYMENT_ENDPOINT: `${DEP}/`,
      COMFY_DEPLOYMENT_ID: "dep-test",
      COMFY_CLOUD_API_VERSION: "v1",
    });
    expect(cfg.backend).toBe("comfy-cloud");
    expect(cfg.comfyBaseUrl).toBe(DEP);
    expect(cfg.comfyApiVersion).toBe("v2");
    expect(cfg.deploymentEndpoint).toBe(true);
    expect(cfg.deployControl).toBe("off");
  });

  it("only manages the deployment when asked explicitly", () => {
    expect(loadConfig({ COMFY_DEPLOYMENT_ENDPOINT: DEP, DEPLOY_CONTROL: "manage" }).deployControl).toBe("manage");
    expect(loadConfig({ COMFY_DEPLOYMENT_ID: "dep-test", DEPLOY_CONTROL: "off" }).deployControl).toBe("off");
    expect(loadConfig({ COMFY_DEPLOYMENT_ID: "dep-test" }).deployControl).toBe("manage");
  });

  it("uploads photos and submits jobs on the endpoint with Bearer auth", async () => {
    const calls: { url: string; auth?: string; apiKey?: string }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, auth: h.Authorization, apiKey: h["X-API-Key"] });
      if (url.endsWith("/api/v2/assets")) {
        return new Response(JSON.stringify({ id: "a1", hash: "blake3:ff", file_path: "p.png", content_type: "image/png" }), { status: 201 });
      }
      return new Response(JSON.stringify({ id: "j1" }), { status: 201 });
    }) as typeof fetch;
    const cfg = loadConfig({ COMFY_CLOUD_API_KEY: KEY, COMFY_DEPLOYMENT_ENDPOINT: DEP });
    const adapter = buildAdapter(cfg, loaded, fetchImpl);
    const asset = await adapter.uploadAsset({ bytes: Buffer.from([1, 2, 3]), filename: "p.png", contentType: "image/png" });
    await adapter.submitSegment({
      idempotencyKey: "k", cacheKey: "c", attempt: 1, image: asset, positive: "p", negative: "n", seed: 1, frames: 49,
      width: 1080, height: 1920, fps: 24, look: "film", segmentId: "s00",
    } as never);
    expect(calls.map((c) => c.url)).toEqual([`${DEP}/api/v2/assets`, `${DEP}/api/v2/jobs`]);
    for (const c of calls) {
      expect(c.auth).toBe(`Bearer ${KEY}`);
      expect(c.apiKey).toBeUndefined();
      expect(c.url).not.toContain("cloud.comfy.org");
    }
  });
});
