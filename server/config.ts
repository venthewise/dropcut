import path from "node:path";

export type BackendName = "mock" | "comfy-cloud";
export type ApiVersion = "v1" | "v2";

export interface Config {
  backend: BackendName;
  port: number;
  comfyApiKey: string;
  comfyBaseUrl: string;
  comfyApiVersion: ApiVersion;
  workflowPath: string;
  workflowMapPath: string;
  maxConcurrent: number;
  mockFailRate: number;
  mockLatencyMs: number;
  outputsDir: string;
  versionWarning?: string;
  deploymentId: string;
  deployControlUrl: string;
  deployIdleStopMs: number;
  /**
   * "manage" (default): the app may start/stop COMFY_DEPLOYMENT_ID.
   * "off": never touch the deployment control plane (someone else manages it).
   * Forced to "off" when COMFY_DEPLOYMENT_ENDPOINT is set without DEPLOY_CONTROL=manage.
   */
  deployControl: "manage" | "off";
  /** True when jobs go straight to a dedicated https://<dep>.run.comfy.app endpoint. */
  deploymentEndpoint: boolean;
  /** Final MP4 frame rate. Only 24 or 30. Anything else uses 30. */
  exportFps: 24 | 30;
  /** Empty means no end card. Appended after the song, silent. */
  exportEndCardUrl: string;
  exportEndCardSeconds: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Config {
  const key = (env.COMFY_CLOUD_API_KEY ?? "").trim();
  const requested = (env.GENERATION_BACKEND ?? "").trim().toLowerCase();
  let backend: BackendName;
  if (requested === "mock" || requested === "comfy-cloud") backend = requested;
  else backend = key ? "comfy-cloud" : "mock";

  const versionRaw = (env.COMFY_CLOUD_API_VERSION ?? "v2").trim().toLowerCase() || "v2";
  let comfyApiVersion: ApiVersion = "v2";
  let versionWarning: string | undefined;
  if (versionRaw === "v1" || versionRaw === "v2") comfyApiVersion = versionRaw;
  else versionWarning = `COMFY_CLOUD_API_VERSION "${versionRaw}" is not v1 or v2. Using v2.`;

  // A dedicated deployment endpoint serves the same v2 API (Bearer auth, POST /api/v2/assets,
  // POST /api/v2/jobs) and is not subject to the shared API's plan gate.
  const endpoint = (env.COMFY_DEPLOYMENT_ENDPOINT ?? "").trim();
  const base = endpoint || (env.COMFY_CLOUD_BASE_URL ?? "").trim() || "https://cloud.comfy.org";
  if (endpoint && comfyApiVersion !== "v2") {
    versionWarning = "COMFY_DEPLOYMENT_ENDPOINT only speaks API v2. Using v2.";
    comfyApiVersion = "v2";
  }
  const controlRaw = (env.DEPLOY_CONTROL ?? "").trim().toLowerCase();
  const deployControl: "manage" | "off" =
    controlRaw === "off" || controlRaw === "none" || (endpoint && controlRaw !== "manage") ? "off" : "manage";

  return {
    backend,
    port: positiveInt(env.PORT, 8787),
    comfyApiKey: key,
    comfyBaseUrl: base.replace(/\/+$/, ""),
    comfyApiVersion,
    workflowPath: path.resolve(cwd, (env.COMFY_WORKFLOW ?? "").trim() || "workflows/ltx-i2v.api.json"),
    workflowMapPath: path.resolve(cwd, (env.COMFY_WORKFLOW_MAP ?? "").trim() || "workflows/ltx-i2v.map.json"),
    maxConcurrent: positiveInt(env.MAX_CONCURRENT_SEGMENTS, 2),
    mockFailRate: clamp01(numberOr(env.MOCK_FAIL_RATE, 0)),
    mockLatencyMs: Math.max(0, numberOr(env.MOCK_LATENCY_MS, 400)),
    outputsDir: path.resolve(cwd, "outputs"),
    versionWarning,
    deploymentId: (env.COMFY_DEPLOYMENT_ID ?? "").trim(),
    deployControlUrl: ((env.COMFY_DEPLOY_URL ?? "").trim() || "https://platformapi.comfy.org/deploy").replace(/\/+$/, ""),
    deployControl,
    deploymentEndpoint: Boolean(endpoint),
    deployIdleStopMs: Math.round(Math.max(0, numberOr(env.DEPLOY_IDLE_STOP_MIN, 10)) * 60 * 1000),
    exportFps: exportFps(env.EXPORT_FPS),
    exportEndCardUrl: (env.EXPORT_END_CARD_URL ?? "").trim(),
    exportEndCardSeconds: endCardSeconds(env.EXPORT_END_CARD_SECONDS),
  };
}

function exportFps(raw: string | undefined): 24 | 30 {
  return Number(raw) === 24 ? 24 : 30;
}

function endCardSeconds(raw: string | undefined): number {
  if (raw == null || raw.trim() === "") return 2;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 2;
  return Math.min(10, Math.max(0.5, n));
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return n;
}

function numberOr(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** Strip API keys from anything that might be logged or sent to the browser. */
export function redact(text: string, secret?: string): string {
  let out = text;
  if (secret && secret.length >= 8) out = out.split(secret).join("[REDACTED]");
  out = out.replace(/comfyui-[A-Za-z0-9_-]+/g, "[REDACTED]");
  out = out.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
  return out;
}

export function displayPath(filePath: string, cwd = process.cwd()): string {
  const rel = path.relative(cwd, filePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return path.basename(filePath);
  return rel.split(path.sep).join("/");
}
