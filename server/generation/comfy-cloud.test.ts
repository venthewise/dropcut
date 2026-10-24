import { describe, expect, it } from "vitest";
import { redact } from "../config";
import {
  ComfyCloudAdapter,
  mapHttpError,
  mapV1Status,
  mapV2Status,
} from "./comfy-cloud";
import type { LoadedWorkflow } from "./workflow";
import type { SegmentRequest } from "./types";

const workflow = {
  "1": { class_type: "LoadImage", inputs: { image: "placeholder.png" } },
  "2": { class_type: "CLIPTextEncode", inputs: { text: "pos" } },
  "3": { class_type: "CLIPTextEncode", inputs: { text: "neg" } },
  "4": {
    class_type: "PlaceholderLTXImageToVideo",
    inputs: { seed: 0, length: 97, width: 768, height: 1344, fps: 24 },
  },
  "5": { class_type: "SaveVideo", inputs: { video: ["4", 0], filename_prefix: "dropcut" } },
};

const loaded: LoadedWorkflow = {
  placeholder: false,
  problems: [],
  workflow,
  map: {
    placeholder: false,
    width: 768,
    height: 1344,
    fps: 24,
    bindings: {
      image: { nodeId: "1", input: "image" },
      positive: { nodeId: "2", input: "text" },
      negative: { nodeId: "3", input: "text" },
      seed: { nodeId: "4", input: "seed" },
      frames: { nodeId: "4", input: "length" },
      width: { nodeId: "4", input: "width" },
      height: { nodeId: "4", input: "height" },
      fps: { nodeId: "4", input: "fps" },
      output: { nodeId: "5" },
    },
  },
};

function request(overrides: Partial<SegmentRequest> = {}): SegmentRequest {
  return {
    idempotencyKey: "idem-1",
    cacheKey: "a".repeat(64),
    attempt: 1,
    image: { id: "asset-1", filename: "frame.png", contentType: "image/png", hash: "blake3:abc", filePath: "frame.png" },
    positive: "neon night",
    negative: "blur",
    seed: 7,
    frames: 24,
    width: 768,
    height: 1344,
    fps: 24,
    look: "neon",
    segmentId: "s00",
    duration: 1,
    start: 0,
    ...overrides,
  };
}

interface Call {
  url: string;
  init?: RequestInit;
}

function headersOf(init?: RequestInit): Record<string, string> {
  const headers = init?.headers;
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key] = value;
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

describe("Comfy Cloud status and errors", () => {
  it("maps v2 lifecycle statuses", () => {
    expect(mapV2Status({ status: "queued" }).state).toBe("queued");
    expect(mapV2Status({ status: "running", progress: { value: 0.4 } })).toMatchObject({ state: "running", progress: 0.4 });
    expect(mapV2Status({ status: "canceling" }).state).toBe("running");
    expect(mapV2Status({ status: "succeeded", outputs: [{ id: "out", node_id: "5", type: "video", url: "https://cdn.example/a.mp4" }] }).state).toBe("done");
    expect(mapV2Status({ status: "failed", error: { message: "node blew up" } })).toMatchObject({ state: "failed", error: "node blew up" });
    expect(mapV2Status({ status: "canceled" }).state).toBe("failed");
    expect(mapV2Status({ status: "expired" }).state).toBe("failed");
  });

  it("maps v1 terminal statuses", () => {
    expect(mapV1Status({ status: "pending" }).state).toBe("queued");
    expect(mapV1Status({ status: "in_progress" }).state).toBe("running");
    expect(mapV1Status({ status: "error" }).state).toBe("failed");
    expect(mapV1Status({ status: "non_retryable_error" }).state).toBe("failed");
    expect(mapV1Status({ status: "lost" }).state).toBe("failed");
    expect(mapV1Status({ status: "cancelled" }).state).toBe("failed");
    const done = mapV1Status({
      status: "success",
      outputs: { "5": { videos: [{ filename: "clip.mp4", subfolder: "", type: "output" }] } },
    });
    expect(done.state).toBe("done");
    expect(done.outputs?.[0]?.filename).toBe("clip.mp4");
    expect(mapV1Status({ status: "success" }).state).toBe("failed");
  });

  it("maps 401, 402, and 429 to account errors", () => {
    expect(mapHttpError(401)?.code).toBe("bad_key");
    expect(mapHttpError(402)?.message).toMatch(/credits/i);
    expect(mapHttpError(429)?.message).toMatch(/subscription inactive/i);
    expect(mapHttpError(500)).toBeNull();
  });

  it("redacts keys", () => {
    const secret = "comfyui-SUPERSECRETKEY99";
    expect(redact(`bad ${secret} Bearer ${secret}`, secret)).not.toContain(secret);
    expect(redact(`bad ${secret}`, secret)).not.toContain("comfyui-");
  });
});

describe("ComfyCloudAdapter requests", () => {
  it("builds a v2 asset upload and job with an idempotency key and core/ASSET image", async () => {
    const calls: Call[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/api/v2/assets")) {
        return Response.json({ id: "asset-1", hash: "blake3:abc", file_path: "frame.png", content_type: "image/png" }, { status: 201 });
      }
      if (url.endsWith("/api/v2/jobs")) {
        return Response.json({ id: "job-1", status: "queued" }, { status: 201 });
      }
      if (url.endsWith("/api/v2/jobs/job-1")) {
        return Response.json({
          id: "job-1",
          status: "succeeded",
          progress: { value: 1 },
          outputs: [{ id: "out-1", node_id: "5", name: "clip.mp4", type: "video", content_type: "video/mp4", url: "https://signed.example/clip.mp4" }],
          error: null,
        });
      }
      if (url === "https://signed.example/clip.mp4") {
        return new Response(Uint8Array.from([9, 9, 9]), { status: 200 });
      }
      return new Response("nope", { status: 500 });
    };
    const adapter = new ComfyCloudAdapter({
      apiKey: "comfyui-SUPERSECRETKEY99",
      baseUrl: "https://cloud.comfy.org",
      version: "v2",
      loaded,
      fetchImpl,
    });
    const asset = await adapter.uploadAsset({ filename: "frame.png", contentType: "image/png", bytes: Buffer.from([1, 2, 3]) });
    expect(asset.id).toBe("asset-1");
    const upload = calls[0]!;
    expect(upload.url).toBe("https://cloud.comfy.org/api/v2/assets");
    expect(headersOf(upload.init).Authorization).toBe("Bearer comfyui-SUPERSECRETKEY99");
    const form = upload.init?.body as FormData;
    expect(form.get("content_type")).toBe("image/png");
    expect(form.get("file_path")).toBe("frame.png");
    expect(form.get("file")).toBeTruthy();

    const job = await adapter.submitSegment(request({ image: asset }));
    expect(job.id).toBe("job-1");
    const submit = calls[1]!;
    expect(submit.url).toBe("https://cloud.comfy.org/api/v2/jobs");
    expect(headersOf(submit.init)["Idempotency-Key"]).toBe("idem-1");
    expect(headersOf(submit.init).Authorization).toContain("Bearer ");
    const body = JSON.parse(String(submit.init?.body)) as { workflow: Record<string, { inputs: Record<string, unknown> }> };
    expect(body.workflow["1"]!.inputs.image).toEqual({
      __type: "core/ASSET",
      info: { id: "asset-1", hash: "blake3:abc", file_path: "frame.png" },
    });
    expect(body.workflow["2"]!.inputs.text).toBe("neon night");
    expect(body.workflow["3"]!.inputs.text).toBe("blur");
    expect(body.workflow["4"]!.inputs.seed).toBe(7);
    expect(body.workflow["4"]!.inputs.length).toBe(24);
    expect(body.workflow["4"]!.inputs.width).toBe(768);
    expect(body.workflow["4"]!.inputs.height).toBe(1344);
    expect(JSON.stringify(body)).not.toContain("SUPERSECRETKEY99");

    const status = await adapter.getStatus(job);
    expect(status.state).toBe("done");
    const bytes = await adapter.fetchOutput(status.outputs![0]!);
    expect(Array.from(bytes)).toEqual([9, 9, 9]);
    const signed = calls.find((call) => call.url === "https://signed.example/clip.mp4");
    expect(headersOf(signed?.init).Authorization).toBeUndefined();
    expect(headersOf(signed?.init)["X-API-Key"]).toBeUndefined();
  });

  it("uses v1 upload, prompt, status, and a redirect with no auth on the signed URL", async () => {
    const calls: Call[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/api/upload/image")) return Response.json({ name: "frame.png", subfolder: "" });
      if (url.endsWith("/api/prompt")) return Response.json({ prompt_id: "prompt-7" });
      if (url.includes("/api/job/prompt-7/status")) {
        return Response.json({ status: "success", outputs: [{ filename: "out.mp4", subfolder: "drop", type: "output" }] });
      }
      if (url.includes("/api/view")) {
        return new Response(null, { status: 302, headers: { Location: "https://signed.example/out.mp4" } });
      }
      if (url === "https://signed.example/out.mp4") return new Response(Uint8Array.from([4, 5]), { status: 200 });
      return new Response("missing", { status: 500 });
    };
    const adapter = new ComfyCloudAdapter({
      apiKey: "comfyui-SUPERSECRETKEY99",
      baseUrl: "https://cloud.comfy.org/",
      version: "v1",
      loaded,
      fetchImpl,
    });
    await adapter.uploadAsset({ filename: "frame.png", contentType: "image/png", bytes: Buffer.from([1]) });
    const uploadHeaders = headersOf(calls[0]?.init);
    expect(uploadHeaders["X-API-Key"]).toBe("comfyui-SUPERSECRETKEY99");
    expect(uploadHeaders.Authorization).toBeUndefined();
    const form = calls[0]?.init?.body as FormData;
    expect(form.get("type")).toBe("input");
    expect(form.get("overwrite")).toBe("true");
    expect(form.get("image")).toBeTruthy();

    const job = await adapter.submitSegment(request());
    expect(job.id).toBe("prompt-7");
    const prompt = JSON.parse(String(calls[1]?.init?.body)) as { prompt: Record<string, { inputs: Record<string, unknown> }> };
    expect(prompt.prompt["1"]!.inputs.image).toBe("frame.png");
    expect(headersOf(calls[1]?.init).Authorization).toBeUndefined();

    const status = await adapter.getStatus(job);
    expect(status.state).toBe("done");
    const bytes = await adapter.fetchOutput(status.outputs![0]!);
    expect(Array.from(bytes)).toEqual([4, 5]);
    const view = calls.find((call) => call.url.includes("/api/view"));
    expect(view?.url).toContain("filename=out.mp4");
    expect(view?.url).toContain("subfolder=drop");
    expect(headersOf(view?.init)["X-API-Key"]).toBe("comfyui-SUPERSECRETKEY99");
    const signed = calls.find((call) => call.url === "https://signed.example/out.mp4");
    expect(headersOf(signed?.init)["X-API-Key"]).toBeUndefined();
    expect(headersOf(signed?.init).Authorization).toBeUndefined();
  });

  it("turns HTTP 401, 402, and 429 into user-facing errors", async () => {
    const statuses = [401, 402, 429];
    for (const status of statuses) {
      const fetchImpl: typeof fetch = async () => Response.json({ error: { code: "x", message: "comfyui-SUPERSECRETKEY99 leaked" } }, { status });
      const adapter = new ComfyCloudAdapter({
        apiKey: "comfyui-SUPERSECRETKEY99",
        baseUrl: "https://cloud.comfy.org",
        version: "v2",
        loaded,
        fetchImpl,
      });
      await expect(adapter.uploadAsset({ filename: "a.png", contentType: "image/png", bytes: Buffer.from([1]) })).rejects.toMatchObject({
        code: status === 401 ? "bad_key" : status === 402 ? "no_credits" : "subscription",
      });
    }
  });
});
