import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyWorkflow, coreAssetRef, durationSeconds, loadWorkflowFiles, validateWorkflow } from "./workflow";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function sampleWorkflow() {
  return {
    "1": { class_type: "LoadImage", inputs: { image: "placeholder.png" } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["9", 0] } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: "" } },
    "4": {
      class_type: "PlaceholderLTXImageToVideo",
      inputs: { seed: 0, length: 97, width: 768, height: 1344, fps: 24 },
    },
    "5": { class_type: "SaveVideo", inputs: { video: ["4", 0] } },
  };
}

function sampleMap(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

describe("workflow map", () => {
  it("accepts the placeholder fixture and reports a warning, not a crash", async () => {
    const loaded = await loadWorkflowFiles(
      path.join(root, "server/test-fixtures/placeholder.api.json"),
      path.join(root, "server/test-fixtures/placeholder.map.json"),
    );
    expect(loaded.placeholder).toBe(true);
    expect(loaded.problems.some((problem) => problem.level === "error")).toBe(false);
    expect(loaded.problems.some((problem) => problem.level === "warning")).toBe(true);
    expect(loaded.map?.bindings.image).toEqual([{ nodeId: "1", input: "image" }]);
  });

  it("loads the shipped LTX-2.5 workflow and writes 9:16, both seeds and whole-second duration", async () => {
    const loaded = await loadWorkflowFiles(
      path.join(root, "workflows/ltx-i2v.api.json"),
      path.join(root, "workflows/ltx-i2v.map.json"),
    );
    expect(loaded.placeholder).toBe(false);
    expect(loaded.problems).toEqual([]);
    expect(loaded.map?.outputHasAudio).toBe(true);
    const next = applyWorkflow(loaded.workflow!, loaded.map!, {
      image: "frame.png",
      positive: "neon night",
      negative: "blur",
      seed: 99,
      frames: 18,
      duration: 0.75,
      width: 0,
      height: 0,
      fps: 24,
    }) as Record<string, { inputs: Record<string, unknown> }>;
    expect(next["395"]!.inputs.image).toBe("frame.png");
    expect(next["398:376"]!.inputs.value).toBe("neon night");
    expect(next["398:373"]!.inputs.text).toBe("blur");
    expect(next["398:339"]!.inputs.noise_seed).toBe(99);
    expect(next["398:338"]!.inputs.noise_seed).toBe(99);
    expect(next["398:362"]!.inputs.value).toBe(1);
    expect(next["398:361"]!.inputs.value).toBe(24);
    expect(next["403"]!.inputs.aspect_ratio).toBe("9:16 (Portrait Widescreen)");
    expect(next["398:383"]!.inputs.value).toBe(false);
  });

  it("rounds and clamps duration to whole seconds", () => {
    const map = validateWorkflow(sampleWorkflow(), sampleMap({ durationMaxSeconds: 5 })).map!;
    expect(durationSeconds(map, 2.4)).toBe(2);
    expect(durationSeconds(map, 2.6)).toBe(3);
    expect(durationSeconds(map, 0.2)).toBe(1);
    expect(durationSeconds(map, 40)).toBe(5);
  });

  it("flags a UI-format graph and a missing node", () => {
    const result = validateWorkflow(
      { nodes: [], links: [] },
      sampleMap({ bindings: { ...sampleMap().bindings, seed: { nodeId: "99", input: "seed" } } }),
    );
    expect(result.problems.some((problem) => /UI format/i.test(problem.message))).toBe(true);
    expect(result.problems.some((problem) => problem.message.includes("99"))).toBe(true);
  });

  it("flags an input that is not on the node", () => {
    const map = sampleMap();
    map.bindings.seed = { nodeId: "4", input: "not_a_real_input" };
    const result = validateWorkflow(sampleWorkflow(), map);
    expect(result.problems.some((problem) => problem.level === "error" && problem.message.includes("not_a_real_input"))).toBe(true);
  });

  it("writes values without mutating the template", () => {
    const workflow = sampleWorkflow();
    const map = validateWorkflow(workflow, sampleMap()).map;
    expect(map).toBeTruthy();
    const image = coreAssetRef({ id: "asset-1", hash: "blake3:abc", filePath: "frame.png" });
    const next = applyWorkflow(workflow, map!, {
      image,
      positive: "neon night",
      negative: "blur",
      seed: 7,
      frames: 24,
      width: 768,
      height: 1344,
      fps: 24,
    });
    const node = next["1"] as { inputs: { image: unknown } };
    expect(node.inputs.image).toEqual({
      __type: "core/ASSET",
      info: { id: "asset-1", hash: "blake3:abc", file_path: "frame.png" },
    });
    expect((next["4"] as { inputs: { seed: number; length: number } }).inputs.seed).toBe(7);
    expect((next["4"] as { inputs: { length: number } }).inputs.length).toBe(24);
    expect((next["2"] as { inputs: { text: string } }).inputs.text).toBe("neon night");
    expect((workflow["1"] as { inputs: { image: string } }).inputs.image).toBe("placeholder.png");
  });
});
