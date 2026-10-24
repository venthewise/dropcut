import type { Config } from "../config";
import { ComfyCloudAdapter } from "./comfy-cloud";
import { MockAdapter } from "./mock";
import type { GenerationAdapter } from "./types";
import type { LoadedWorkflow } from "./workflow";

export function buildAdapter(cfg: Config, loaded: LoadedWorkflow): GenerationAdapter {
  if (cfg.backend === "mock") {
    return new MockAdapter({ failRate: cfg.mockFailRate, latencyMs: cfg.mockLatencyMs });
  }
  return new ComfyCloudAdapter({
    apiKey: cfg.comfyApiKey,
    baseUrl: cfg.comfyBaseUrl,
    version: cfg.comfyApiVersion,
    loaded,
  });
}
