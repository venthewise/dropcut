import type { Cutlist } from "./cutlist";

export type SegmentStatusName = "queued" | "running" | "done" | "failed";
export type JobStatusName = "queued" | "running" | "done" | "failed";

export interface WorkflowProblem {
  level: "error" | "warning";
  message: string;
}

export type DeploymentPhase = "stopped" | "warming" | "ready" | "stopping" | "failed" | "unknown";

/** A Comfy serverless deployment the comfy-cloud backend runs on (when COMFY_DEPLOYMENT_ID is set). */
export interface DeploymentView {
  id: string;
  status: string;
  phase: DeploymentPhase;
  /** True in queued/provisioning/starting/ready/unhealthy (and possibly stop_failed). */
  billing: boolean;
  message: string;
  endpointUrl?: string;
  stopReason?: string;
  gpuClass?: string;
  minWorkers?: number;
  maxWorkers?: number;
  step?: string;
  /** 0..1 while staging models. */
  stepProgress?: number;
  etaSeconds?: number;
  warmingSince?: string;
  idleStopAt?: string;
  activeJobs?: number;
  lastColdStartSeconds?: number;
}

export interface HealthResponse {
  ok: boolean;
  backend: "mock" | "comfy-cloud";
  backendLabel: string;
  apiVersion: "v1" | "v2" | null;
  keyConfigured: boolean;
  maxConcurrent: number;
  workflow: {
    path: string;
    mapPath: string;
    placeholder: boolean;
    ready: boolean;
    problems: WorkflowProblem[];
  };
  /** True when a usable ffmpeg binary was found. */
  ffmpeg: boolean;
  /** Which check produced the binary. Null when ffmpeg is missing. */
  ffmpegSource: "FFMPEG_PATH" | "PATH" | "ffmpeg-static" | null;
  /** Command or absolute path passed to the exporter. Null when ffmpeg is missing. */
  ffmpegPath: string | null;
  deployment?: DeploymentView | null;
  idleStopMinutes?: number;
}

export type ExportStatusName = "idle" | "running" | "done" | "failed";

export interface ExportResponse {
  status: ExportStatusName;
  /** 0..1 from ffmpeg `out_time` against the output duration. */
  progress: number;
  error?: string;
  /** Present when status is done. */
  fileUrl?: string;
  /** True when POST reused a finished file with the same inputs. */
  cached?: boolean;
  fps: number;
  /** Output length in seconds. Includes a silent end card when one is configured. */
  duration?: number;
  /** Trimmed song length in seconds. The end card is not part of this. */
  songDuration?: number;
}

export interface JobSegmentView {
  id: string;
  status: SegmentStatusName;
  progress: number;
  error?: string;
  look: string;
  transition: string;
  caption: string;
  start: number;
  end: number;
  photoIndex: number;
  contentType?: string;
  attempt: number;
  fileUrl?: string;
}

export interface JobResponse {
  id: string;
  backend: string;
  status: JobStatusName;
  progress: number;
  error?: string;
  createdAt: string;
  /** Set while the job waits on (or ran on) a deployment. */
  deployment?: DeploymentView;
  cutlist: Cutlist;
  segments: JobSegmentView[];
}
