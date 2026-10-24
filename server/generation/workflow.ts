import { readFile } from "node:fs/promises";
import type { WorkflowProblem } from "../../shared/api-types";
import { displayPath } from "../config";
import { GenerationError } from "./errors";

export interface Binding {
  nodeId: string;
  input: string;
}

export interface OutputBinding {
  nodeId: string;
  input?: string;
}

/** A map entry may target one node input or several (e.g. two RandomNoise seeds). */
export type BindingSpec = Binding | Binding[];

export function bindingList(spec: BindingSpec | undefined): Binding[] {
  if (!spec) return [];
  return Array.isArray(spec) ? spec : [spec];
}

export interface WorkflowMap {
  placeholder: boolean;
  todo?: string;
  width?: number;
  height?: number;
  fps?: number;
  /** Constant written to the aspect binding (e.g. "9:16 (Portrait Widescreen)"). */
  aspect?: string;
  /** Constant written to the prompt-enhance toggle. */
  enhancePrompt?: boolean;
  /** Integer-seconds duration input: segment seconds are rounded and clamped here. */
  durationMinSeconds?: number;
  durationMaxSeconds?: number;
  /** True when the workflow renders its own audio track; DropCut strips it (the user's song is used). */
  outputHasAudio?: boolean;
  bindings: {
    image: BindingSpec;
    positive: BindingSpec;
    negative?: BindingSpec;
    seed?: BindingSpec;
    frames?: BindingSpec;
    duration?: BindingSpec;
    width?: BindingSpec;
    height?: BindingSpec;
    fps?: BindingSpec;
    aspect?: BindingSpec;
    enhance?: BindingSpec;
    output: OutputBinding;
  };
}

export interface LoadedWorkflow {
  workflow: Record<string, unknown> | null;
  map: WorkflowMap | null;
  problems: WorkflowProblem[];
  placeholder: boolean;
}

export interface WorkflowValues {
  image: unknown;
  positive: string;
  negative: string;
  seed: number;
  frames: number;
  /** Segment length in seconds (from the cut list). */
  duration?: number;
  width: number;
  height: number;
  fps: number;
}

const REQUIRED_BINDINGS = ["image", "positive"] as const;
const OPTIONAL_BINDINGS = ["negative", "seed", "frames", "duration", "width", "height", "fps", "aspect", "enhance"] as const;
type BindingKey = (typeof REQUIRED_BINDINGS)[number] | (typeof OPTIONAL_BINDINGS)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function coreAssetRef(asset: { id: string; hash?: string | null; filePath?: string | null }): {
  __type: "core/ASSET";
  info: { id: string; hash?: string; file_path?: string };
} {
  const info: { id: string; hash?: string; file_path?: string } = { id: asset.id };
  if (asset.hash) info.hash = asset.hash;
  if (asset.filePath) info.file_path = asset.filePath;
  return { __type: "core/ASSET", info };
}

/** Whole seconds for an integer duration input: rounded, clamped to the map's min/max. */
export function durationSeconds(map: WorkflowMap, seconds: number): number {
  const min = map.durationMinSeconds ?? 1;
  const max = map.durationMaxSeconds ?? 10;
  const rounded = Math.round(Number.isFinite(seconds) ? seconds : min);
  return Math.min(max, Math.max(min, rounded));
}

export function validateWorkflow(workflow: unknown, map: unknown): {
  problems: WorkflowProblem[];
  placeholder: boolean;
  map: WorkflowMap | null;
} {
  const problems: WorkflowProblem[] = [];
  if (!isRecord(workflow)) {
    problems.push({ level: "error", message: "Workflow JSON must be an API-format object keyed by node id." });
    return { problems, placeholder: false, map: null };
  }
  if (Array.isArray(workflow.nodes) && Array.isArray(workflow.links)) {
    problems.push({
      level: "error",
      message: "Workflow looks like the UI format (nodes and links). Export it with Export (API).",
    });
  }

  const parsed = parseMap(map, problems);
  if (!parsed) return { problems, placeholder: false, map: null };

  if (parsed.placeholder) {
    problems.push({
      level: "warning",
      message:
        "Placeholder workflow. Export your LTX image-to-video graph from Comfy Cloud with Export (API), replace the workflow file, and fill in the map.",
    });
  }

  for (const key of [...REQUIRED_BINDINGS, ...OPTIONAL_BINDINGS]) {
    const spec = parsed.bindings[key];
    if (!spec) continue;
    for (const binding of bindingList(spec)) checkBinding(workflow, binding, key, problems, true);
  }
  if (!parsed.bindings.frames && !parsed.bindings.duration) {
    problems.push({ level: "warning", message: "Map has neither a frames nor a duration binding; segment length is not set." });
  }
  if (parsed.bindings.aspect && !parsed.aspect) {
    problems.push({ level: "error", message: 'Map has an aspect binding but no "aspect" value.' });
  }
  checkBinding(workflow, { nodeId: parsed.bindings.output.nodeId, input: "" }, "output", problems, false);

  return { problems, placeholder: parsed.placeholder, map: parsed };
}

function readSpec(raw: unknown): Binding[] | null {
  const one = (item: unknown): Binding | null =>
    isRecord(item) && typeof item.nodeId === "string" && typeof item.input === "string" && item.nodeId && item.input
      ? { nodeId: item.nodeId, input: item.input }
      : null;
  if (Array.isArray(raw)) {
    const list = raw.map(one);
    return list.length > 0 && list.every((b): b is Binding => b !== null) ? list : null;
  }
  const single = one(raw);
  return single ? [single] : null;
}

function parseMap(map: unknown, problems: WorkflowProblem[]): WorkflowMap | null {
  if (!isRecord(map)) {
    problems.push({ level: "error", message: "Workflow map must be a JSON object." });
    return null;
  }
  if (!isRecord(map.bindings)) {
    problems.push({ level: "error", message: "Workflow map is missing bindings." });
    return null;
  }
  const raw = map.bindings;
  const bindings: Partial<Record<BindingKey, BindingSpec>> = {};
  let ok = true;
  for (const key of REQUIRED_BINDINGS) {
    const spec = readSpec(raw[key]);
    if (!spec) {
      problems.push({ level: "error", message: `Map binding "${key}" needs a nodeId and an input name.` });
      ok = false;
    } else bindings[key] = spec;
  }
  for (const key of OPTIONAL_BINDINGS) {
    if (raw[key] === undefined || raw[key] === null) continue;
    const spec = readSpec(raw[key]);
    if (!spec) {
      problems.push({ level: "error", message: `Map binding "${key}" needs a nodeId and an input name.` });
      ok = false;
    } else bindings[key] = spec;
  }
  const outputRaw = raw.output;
  if (!isRecord(outputRaw) || typeof outputRaw.nodeId !== "string" || !outputRaw.nodeId) {
    problems.push({ level: "error", message: 'Map binding "output" needs a nodeId.' });
    return null;
  }
  if (!ok) return null;
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  return {
    placeholder: map.placeholder === true,
    todo: typeof map.todo === "string" ? map.todo : undefined,
    width: num(map.width),
    height: num(map.height),
    fps: num(map.fps),
    aspect: typeof map.aspect === "string" ? map.aspect : undefined,
    enhancePrompt: typeof map.enhancePrompt === "boolean" ? map.enhancePrompt : undefined,
    durationMinSeconds: num(map.durationMinSeconds),
    durationMaxSeconds: num(map.durationMaxSeconds),
    outputHasAudio: map.outputHasAudio === true,
    bindings: {
      ...bindings,
      image: bindings.image!,
      positive: bindings.positive!,
      output: { nodeId: outputRaw.nodeId, input: typeof outputRaw.input === "string" ? outputRaw.input : undefined },
    },
  };
}

function checkBinding(
  workflow: Record<string, unknown>,
  binding: Binding,
  label: string,
  problems: WorkflowProblem[],
  requireInput: boolean,
): void {
  const node = workflow[binding.nodeId];
  if (!isRecord(node)) {
    problems.push({ level: "error", message: `Map ${label} points at node ${binding.nodeId}, which is not in the workflow.` });
    return;
  }
  if (typeof node.class_type !== "string") {
    problems.push({ level: "error", message: `Node ${binding.nodeId} is missing class_type.` });
  }
  if (!requireInput) return;
  if (!isRecord(node.inputs)) {
    problems.push({ level: "error", message: `Node ${binding.nodeId} has no inputs object for "${binding.input}".` });
    return;
  }
  if (!(binding.input in node.inputs)) {
    problems.push({
      level: "error",
      message: `Node ${binding.nodeId} has no input named "${binding.input}" (${label}).`,
    });
  }
}

export function applyWorkflow(
  workflow: Record<string, unknown>,
  map: WorkflowMap,
  values: WorkflowValues,
): Record<string, unknown> {
  const graph = structuredClone(workflow);
  const assign = (spec: BindingSpec | undefined, value: unknown, label: string) => {
    if (!spec || value === undefined) return;
    for (const binding of bindingList(spec)) {
      const node = graph[binding.nodeId];
      if (!isRecord(node)) {
        throw new GenerationError(`Workflow node ${binding.nodeId} is missing (${label}).`, "workflow", 422);
      }
      if (!isRecord(node.inputs)) {
        throw new GenerationError(`Workflow node ${binding.nodeId} has no inputs (${label}).`, "workflow", 422);
      }
      node.inputs[binding.input] = value;
    }
  };
  const b = map.bindings;
  assign(b.image, values.image, "image");
  assign(b.positive, values.positive, "positive");
  assign(b.negative, values.negative, "negative");
  assign(b.seed, values.seed, "seed");
  assign(b.frames, values.frames, "frames");
  if (b.duration) {
    const seconds = values.duration ?? values.frames / Math.max(1, values.fps);
    assign(b.duration, durationSeconds(map, seconds), "duration");
  }
  assign(b.width, values.width, "width");
  assign(b.height, values.height, "height");
  assign(b.fps, values.fps, "fps");
  assign(b.aspect, map.aspect, "aspect");
  assign(b.enhance, map.enhancePrompt, "enhance");
  return graph;
}

export async function loadWorkflowFiles(workflowPath: string, mapPath: string): Promise<LoadedWorkflow> {
  const problems: WorkflowProblem[] = [];
  let workflow: unknown;
  let map: unknown;
  try {
    workflow = JSON.parse(await readFile(workflowPath, "utf8")) as unknown;
  } catch (err) {
    problems.push({
      level: "error",
      message: `Could not read workflow ${displayPath(workflowPath)} (${err instanceof Error ? err.message : "read failed"}).`,
    });
  }
  try {
    map = JSON.parse(await readFile(mapPath, "utf8")) as unknown;
  } catch (err) {
    problems.push({
      level: "error",
      message: `Could not read workflow map ${displayPath(mapPath)} (${err instanceof Error ? err.message : "read failed"}).`,
    });
  }
  if (workflow === undefined || map === undefined) {
    return { workflow: null, map: null, problems, placeholder: false };
  }
  const checked = validateWorkflow(workflow, map);
  return {
    workflow: isRecord(workflow) ? workflow : null,
    map: checked.map,
    problems: [...problems, ...checked.problems],
    placeholder: checked.placeholder,
  };
}

export function workflowReady(backend: "mock" | "comfy-cloud", hasKey: boolean, loaded: LoadedWorkflow): boolean {
  if (loaded.problems.some((problem) => problem.level === "error")) return false;
  if (!loaded.workflow || !loaded.map) return false;
  if (backend === "comfy-cloud" && (loaded.placeholder || !hasKey)) return false;
  return true;
}

export function safeFilePath(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? "image.png";
  const clean = base.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 120);
  return clean || "image.png";
}
