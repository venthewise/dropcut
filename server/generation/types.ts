export interface UploadFile {
  filename: string;
  contentType: string;
  bytes: Buffer;
}

export interface AssetRef {
  id: string;
  filename: string;
  contentType: string;
  hash?: string | null;
  filePath?: string | null;
  subfolder?: string;
}

export interface SegmentRequest {
  idempotencyKey: string;
  cacheKey: string;
  attempt: number;
  image: AssetRef;
  positive: string;
  negative: string;
  seed: number;
  frames: number;
  width: number;
  height: number;
  fps: number;
  look: string;
  segmentId: string;
  duration: number;
  start: number;
}

export interface JobRef {
  id: string;
  adapter: string;
}

export interface OutputRef {
  id: string;
  url?: string;
  contentType?: string;
  filename?: string;
  nodeId?: string;
  type?: string;
  subfolder?: string;
}

export interface SegmentStatus {
  state: "queued" | "running" | "done" | "failed";
  progress?: number;
  outputs?: OutputRef[];
  error?: string;
}

export interface AdapterHealth {
  ok: boolean;
  detail?: string;
}

export interface GenerationAdapter {
  name: string;
  health(): Promise<AdapterHealth>;
  uploadAsset(file: UploadFile): Promise<AssetRef>;
  submitSegment(req: SegmentRequest): Promise<JobRef>;
  getStatus(job: JobRef): Promise<SegmentStatus>;
  fetchOutput(output: OutputRef): Promise<Buffer>;
  cancel(job: JobRef): Promise<void>;
}
