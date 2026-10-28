import { existsSync } from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import type { HealthResponse, JobResponse, JobSegmentView } from "../shared/api-types";
import { parseCutlist } from "../shared/cutlist";
import { MAX_PHOTOS } from "../shared/looks";
import { displayPath, loadConfig, redact, type Config } from "./config";
import { buildAdapter } from "./generation";
import { GenerationError } from "./generation/errors";
import type { GenerationAdapter } from "./generation/types";
import { loadWorkflowFiles, workflowReady, type LoadedWorkflow } from "./generation/workflow";
import { Runner } from "./jobs/runner";
import { DeploymentController } from "./deploy/controller";
import { editSegment, JobStore, type StoredJob, type StoredSegment } from "./jobs/store";
import { resolveBinaries, type Binaries } from "./export/binaries";
import { ExportError, ExportManager } from "./export/manager";

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEGMENT_ID = /^s\d{2,4}$/;

interface UploadedFile {
  fieldname: string;
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface AppOptions {
  env?: NodeJS.ProcessEnv;
  outputsDir?: string;
  adapter?: GenerationAdapter;
  cwd?: string;
  /** Override the deployment controller (tests). `null` disables it. */
  deployment?: DeploymentController | null;
}

export interface AppHandle {
  app: express.Express;
  cfg: Config;
  store: JobStore;
  runner: Runner;
  loaded: LoadedWorkflow;
  deployment?: DeploymentController;
}

export async function createApp(opts: AppOptions = {}): Promise<AppHandle> {
  const cwd = opts.cwd ?? process.cwd();
  const cfg = loadConfig(opts.env ?? process.env, cwd);
  if (opts.outputsDir) cfg.outputsDir = opts.outputsDir;
  const loaded = await loadWorkflowFiles(cfg.workflowPath, cfg.workflowMapPath);
  const adapter = opts.adapter ?? buildAdapter(cfg, loaded);
  const store = new JobStore(cfg.outputsDir);
  await store.load();
  const deployment = opts.deployment === null
    ? undefined
    : opts.deployment ?? (cfg.backend === "comfy-cloud" && cfg.deployControl === "manage" && cfg.deploymentId && cfg.comfyApiKey
      ? new DeploymentController({
        apiKey: cfg.comfyApiKey,
        deploymentId: cfg.deploymentId,
        controlUrl: cfg.deployControlUrl,
        idleStopMs: cfg.deployIdleStopMs,
      })
      : undefined);
  if (deployment) await deployment.adopt();
  const binaries = await resolveBinaries(opts.env ?? process.env);
  const runner = new Runner({ store, adapter, cfg, workflow: loaded, deployment, ffmpegPath: binaries.ffmpeg?.path });
  await runner.resumeIncomplete();
  const exporter = new ExportManager({
    store,
    cfg,
    ffmpeg: async () => binaries.ffmpeg,
  });
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    if (req.path.startsWith("/api")) {
      res.on("finish", () => {
        console.log(`[dropcut] ${req.method} ${req.path} ${res.statusCode}`);
      });
    }
    next();
  });
  app.use("/api", apiRouter({ cfg, store, runner, loaded, binaries, exporter, deployment }));

  const samplesDir = path.resolve(cwd, "samples");
  if (existsSync(samplesDir)) {
    app.use("/samples", express.static(samplesDir, { index: false, fallthrough: true }));
  }
  app.use("/samples", (_req, res) => {
    res.status(404).json({ error: "Sample not found." });
  });

  const clientDir = path.resolve(cwd, "dist/client");
  if (existsSync(path.join(clientDir, "index.html"))) {
    app.use(express.static(clientDir, { index: false }));
    app.use((req, res, next) => {
      if (req.path.startsWith("/api")) return next();
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      res.sendFile(path.join(clientDir, "index.html"), (err) => {
        if (err) next(err);
      });
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof multer.MulterError) {
      res.status(400).json({ error: `Upload was rejected. Use 1 to ${MAX_PHOTOS} images, 25 MB each.` });
      return;
    }
    if (err instanceof ExportError) {
      if (!res.headersSent) res.status(err.status).json({ error: err.message });
      return;
    }
    if (isBadJson(err)) {
      if (!res.headersSent) res.status(400).json({ error: "Request JSON was invalid." });
      return;
    }
    const message = redact(err instanceof Error ? err.message : "Request failed.", cfg.comfyApiKey);
    const status = err instanceof GenerationError && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (!res.headersSent) res.status(status).json({ error: message });
  });

  return { app, cfg, store, runner, loaded, deployment };
}

function apiRouter(deps: {
  cfg: Config;
  store: JobStore;
  runner: Runner;
  loaded: LoadedWorkflow;
  binaries: Binaries;
  exporter: ExportManager;
  deployment?: DeploymentController;
}): express.Router {
  const { cfg, store, runner, loaded, binaries, exporter, deployment } = deps;
  let lastLookup = 0;
  const deploymentView = async () => {
    if (!deployment) return null;
    if (Date.now() - lastLookup < 5000 && deployment.snapshot()) return deployment.snapshot() ?? null;
    lastLookup = Date.now();
    try {
      return await deployment.status();
    } catch {
      return deployment.snapshot() ?? null;
    }
  };
  const router = express.Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 32 * 1024 * 1024, files: MAX_PHOTOS + 1, fields: 8, fieldSize: 2 * 1024 * 1024 },
  });

  router.get("/health", wrap(async (_req, res) => {
    const problems = [
      ...(cfg.versionWarning ? [{ level: "warning" as const, message: cfg.versionWarning }] : []),
      ...loaded.problems,
    ];
    const body: HealthResponse = {
      ok: true,
      backend: cfg.backend,
      backendLabel: cfg.backend === "mock" ? "MOCK" : "COMFY CLOUD",
      apiVersion: cfg.backend === "comfy-cloud" ? cfg.comfyApiVersion : null,
      keyConfigured: cfg.comfyApiKey.length > 0,
      maxConcurrent: cfg.maxConcurrent,
      workflow: {
        path: displayPath(cfg.workflowPath),
        mapPath: displayPath(cfg.workflowMapPath),
        placeholder: loaded.placeholder,
        ready: workflowReady(cfg.backend, cfg.comfyApiKey.length > 0, loaded),
        problems,
      },
      ffmpeg: binaries.ffmpeg != null,
      ffmpegSource: binaries.ffmpeg?.source ?? null,
      ffmpegPath: binaries.ffmpeg?.path ?? null,
      deployment: await deploymentView(),
      idleStopMinutes: deployment ? cfg.deployIdleStopMs / 60000 : undefined,
    };
    res.json(body);
  }));

  router.get("/deployment", wrap(async (_req, res) => {
    if (!deployment) {
      res.status(404).json({ error: "No deployment configured (set COMFY_DEPLOYMENT_ID)." });
      return;
    }
    lastLookup = Date.now();
    res.json(await deployment.status());
  }));

  router.post("/deployment/stop", wrap(async (_req, res) => {
    if (!deployment) {
      res.status(404).json({ error: "No deployment configured (set COMFY_DEPLOYMENT_ID)." });
      return;
    }
    res.json(await deployment.stopIfBilling("manual"));
  }));

  router.post(
    "/jobs",
    upload.fields([
      { name: "photos", maxCount: MAX_PHOTOS },
      { name: "audio", maxCount: 1 },
    ]),
    wrap(async (req, res) => {
    if (cfg.backend === "comfy-cloud" && !workflowReady(cfg.backend, cfg.comfyApiKey.length > 0, loaded)) {
      const message = loaded.placeholder
        ? "The shipped workflow is a placeholder. Export your LTX image-to-video graph from Comfy Cloud with Export (API) and update the map before generating."
        : "Comfy Cloud is not ready. Check the key and the workflow on /api/health.";
      res.status(400).json({ error: message, problems: loaded.problems });
      return;
    }
    const body = req.body as { cutlist?: unknown };
    if (typeof body.cutlist !== "string") {
      res.status(400).json({ error: "Include the cut list as a form field named cutlist." });
      return;
    }
    let cutlist;
    try {
      cutlist = parseCutlist(JSON.parse(body.cutlist) as unknown);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Cut list was rejected." });
      return;
    }
    const files = photosOf(req);
    if (files.length !== cutlist.photoCount) {
      res.status(400).json({ error: `Send ${cutlist.photoCount} photo${cutlist.photoCount === 1 ? "" : "s"} in the photos field.` });
      return;
    }
    if (files.some((file) => !isImage(file) || file.buffer.length === 0)) {
      res.status(400).json({ error: "Photos must be PNG, JPEG, WebP, or GIF." });
      return;
    }
    const audio = audioOf(req);
    if (audio && (!isAudio(audio) || audio.buffer.length === 0)) {
      res.status(400).json({ error: "Audio must be an mp3, wav, or m4a file." });
      return;
    }
    const job = await store.create({
      backend: cfg.backend,
      cutlist,
      photos: files.map((file) => ({
        filename: file.originalname || "photo.png",
        contentType: file.mimetype || "application/octet-stream",
        bytes: file.buffer,
      })),
      audio: audio
        ? { filename: audio.originalname || "song.wav", contentType: audio.mimetype || "audio/wav", bytes: audio.buffer }
        : undefined,
    });
    void runner.run(job.id).catch((err) => {
      console.error(`[dropcut] job ${job.id} failed: ${redact(err instanceof Error ? err.message : "error", cfg.comfyApiKey)}`);
    });
    res.status(201).json(toView(job));
  }));

  router.get("/jobs/:id", wrap(async (req, res) => {
    const job = mustJob(store, req.params.id);
    if (!job) {
      res.status(404).json({ error: "Job not found." });
      return;
    }
    res.json(toView(job));
  }));

  router.get("/jobs/:id/events", (req, res) => {
    const job = mustJob(store, req.params.id);
    if (!job) {
      res.status(404).json({ error: "Job not found." });
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    let timer: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    const send = () => {
      if (closed) return;
      const current = store.get(job.id);
      if (!current) return;
      res.write(`data: ${JSON.stringify(toView(current))}\n\n`);
      if (current.status === "done" || current.status === "failed") {
        closed = true;
        if (timer) clearInterval(timer);
        res.end();
      }
    };
    send();
    if (!closed) timer = setInterval(send, 400);
    req.on("close", () => {
      closed = true;
      if (timer) clearInterval(timer);
    });
  });

  router.post("/jobs/:id/retry", express.json({ limit: "64kb" }), wrap(async (req, res) => {
    const job = mustJob(store, req.params.id);
    if (!job) {
      res.status(404).json({ error: "Job not found." });
      return;
    }
    const ids = Array.isArray(req.body?.segmentIds) ? req.body.segmentIds.filter((id: unknown) => typeof id === "string") : undefined;
    const count = runner.queueRetry(job, ids);
    if (count === 0) {
      res.status(400).json({ error: "No failed segments to retry." });
      return;
    }
    await store.save(job);
    void runner.run(job.id);
    res.json(toView(job));
  }));

  router.post("/jobs/:id/cancel", wrap(async (req, res) => {
    const job = mustJob(store, req.params.id);
    if (!job) {
      res.status(404).json({ error: "Job not found." });
      return;
    }
    await runner.cancel(job.id);
    const current = store.get(job.id);
    res.json(toView(current ?? job));
  }));

  router.post("/jobs/:id/export", express.json({ limit: "32kb" }), wrap(async (req, res) => {
    const job = mustJob(store, req.params.id);
    if (!job) {
      res.status(404).json({ error: "Job not found." });
      return;
    }
    const view = await exporter.start(job.id, captionsFrom(req.body));
    res.status(view.cached || view.status === "done" ? 200 : 202).json(view);
  }));

  router.get("/jobs/:id/export/file", wrap(async (req, res) => {
    const job = mustJob(store, req.params.id);
    if (!job) {
      res.status(404).json({ error: "Job not found." });
      return;
    }
    const current = await exporter.status(job.id);
    if (current.status === "running") {
      res.status(409).json({ error: "Export is still rendering." });
      return;
    }
    const file = await exporter.file(job.id);
    if (!file) {
      res.status(404).json({ error: "Export file is not ready." });
      return;
    }
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="dropcut-${job.id}.mp4"`);
    res.sendFile(file);
  }));

  router.get("/jobs/:id/export", wrap(async (req, res) => {
    const job = mustJob(store, req.params.id);
    if (!job) {
      res.status(404).json({ error: "Job not found." });
      return;
    }
    res.json(await exporter.status(job.id));
  }));

  router.get("/jobs/:id/cutlist.json", wrap(async (req, res) => {
    const job = mustJob(store, req.params.id);
    if (!job) {
      res.status(404).json({ error: "Job not found." });
      return;
    }
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="dropcut-${job.id}-cutlist.json"`);
    res.send(JSON.stringify(job.cutlist, null, 2));
  }));

  router.patch("/jobs/:id/segments/:segmentId", express.json({ limit: "32kb" }), wrap(async (req, res) => {
    const job = mustJob(store, req.params.id);
    if (!job) {
      res.status(404).json({ error: "Job not found." });
      return;
    }
    const segmentId = req.params.segmentId ?? "";
    if (!SEGMENT_ID.test(segmentId)) {
      res.status(400).json({ error: "Bad segment id." });
      return;
    }
    const look = (req.body as { look?: unknown } | null | undefined)?.look;
    if (typeof look !== "string" || look.length === 0) {
      res.status(400).json({ error: "Look is required." });
      return;
    }
    let requeued = false;
    try {
      requeued = editSegment(job, segmentId, { look }).requeued;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Look edit was rejected.";
      const missing = message.startsWith("Unknown segment");
      res.status(missing ? 404 : 400).json({ error: message });
      return;
    }
    await store.save(job);
    if (requeued) {
      void runner.run(job.id).catch((err) => {
        console.error(`[dropcut] job ${job.id} failed: ${redact(err instanceof Error ? err.message : "error", cfg.comfyApiKey)}`);
      });
    }
    res.json(toView(job));
  }));

  router.get("/jobs/:id/segments/:segmentId/file", wrap(async (req, res) => {
    const job = mustJob(store, req.params.id);
    if (!job) {
      res.status(404).json({ error: "Job not found." });
      return;
    }
    const segmentId = req.params.segmentId ?? "";
    if (!SEGMENT_ID.test(segmentId)) {
      res.status(400).json({ error: "Bad segment id." });
      return;
    }
    const seg = job.segments.find((item) => item.id === segmentId);
    if (!seg?.filename || seg.status !== "done") {
      res.status(404).json({ error: "Segment file is not ready." });
      return;
    }
    const abs = store.segmentAbs(job.id, seg.filename);
    res.setHeader("Content-Type", seg.contentType || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${seg.filename}"`);
    res.sendFile(abs);
  }));

  router.use((_req, res) => {
    res.status(404).json({ error: "Not found." });
  });

  return router;
}

function toView(job: StoredJob): JobResponse {
  return {
    id: job.id,
    backend: job.backend,
    status: job.status,
    progress: job.progress,
    error: job.error,
    createdAt: job.createdAt,
    deployment: job.deployment,
    cutlist: job.cutlist,
    segments: job.segments.map((seg) => segmentView(job.id, seg)),
  };
}

function segmentView(jobId: string, seg: StoredSegment): JobSegmentView {
  return {
    id: seg.id,
    status: seg.status,
    progress: seg.progress,
    error: seg.error,
    look: seg.look,
    transition: seg.transition,
    caption: seg.caption,
    start: seg.start,
    end: seg.end,
    photoIndex: seg.photoIndex,
    contentType: seg.contentType,
    attempt: seg.attempt,
    fileUrl: seg.status === "done" && seg.filename
      ? `/api/jobs/${jobId}/segments/${seg.id}/file?v=${seg.attempt}`
      : undefined,
  };
}

function isBadJson(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const rec = err as { type?: string; status?: number; statusCode?: number };
  if (rec.type === "entity.parse.failed") return true;
  const status = rec.status ?? rec.statusCode;
  return err instanceof SyntaxError && status === 400;
}

function mustJob(store: JobStore, id: string | undefined): StoredJob | undefined {
  if (!id || !JOB_ID.test(id)) return undefined;
  return store.get(id);
}

function fileBag(req: Request): { photos?: UploadedFile[]; audio?: UploadedFile[] } {
  const files = (req as Request & { files?: { photos?: UploadedFile[]; audio?: UploadedFile[] } | UploadedFile[] }).files;
  if (!files || Array.isArray(files)) return {};
  return files;
}

function photosOf(req: Request): UploadedFile[] {
  return fileBag(req).photos ?? [];
}

function audioOf(req: Request): UploadedFile | undefined {
  return fileBag(req).audio?.[0];
}

function isImage(file: UploadedFile): boolean {
  if (file.mimetype.startsWith("image/")) return true;
  return /\.(png|jpe?g|webp|gif)$/i.test(file.originalname);
}

function isAudio(file: UploadedFile): boolean {
  if (file.mimetype.startsWith("audio/")) return true;
  return /\.(mp3|wav|m4a)$/i.test(file.originalname);
}

function captionsFrom(body: unknown): Record<string, string> | undefined {
  if (body == null || typeof body !== "object" || Array.isArray(body)) return undefined;
  const captions = (body as { captions?: unknown }).captions;
  if (captions == null) return undefined;
  if (typeof captions !== "object" || Array.isArray(captions)) {
    throw new ExportError(400, "captions must be an object of segment id to text.");
  }
  const out: Record<string, string> = {};
  for (const [id, value] of Object.entries(captions)) {
    if (!/^s\d{2,4}$/.test(id) || typeof value !== "string" || value.length > 80) {
      throw new ExportError(400, "A caption edit was rejected.");
    }
    out[id] = value;
  }
  return out;
}

function wrap(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}
