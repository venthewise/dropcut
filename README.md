# DropCut

DropCut turns 1–5 photos and a song into a vertical 9:16 reel. The browser finds beats and drops, builds a deterministic cut list, and each segment is generated through an adapter. The default path with no API key is a local mock that draws a placeholder plate per look. With a Comfy Cloud key, the same cut list is sent to ComfyUI as an API-format workflow (LTX family, open weights).

The interface is the Cut Sheet: editorial type, a hard grid, black, paper, and one acid accent.

## Stack

- Frontend: Vite, TypeScript, no framework
- Backend: Node 22, Express, TypeScript
- Tests: Vitest
- One `npm run dev` process pair: the API on port 8787 and Vite on port 5173, with `/api` proxied to the API

## Folder layout

```
index.html              marketing page + tool mount
src/                    browser app (beats, cut sheet UI, player)
shared/                 cut list, looks, timecode (used by client and server)
server/                 HTTP API, job store, generation adapters
server/generation/      GenerationAdapter, mock, Comfy Cloud, workflow map
server/export/          ffmpeg assembly, ASS captions, binary detection
samples/                CC0 sample song and three abstract plates
workflows/              API-format ComfyUI graph + node map (placeholder)
docs/                   Comfy API v2 spec and notes
outputs/                job manifests, segment files, and MP4 exports (gitignored)
scripts/smoke.ts        mock job against a running server
scripts/mock-export.ts  mock job plus final MP4 from the bundled samples
design-ref/cut-sheet/   approved visual reference
```

## Setup on Windows

Node 22 is required.

```
npm install
copy .env.example .env
npm run dev
```

Open http://localhost:5173

| Command | What it does |
| --- | --- |
| `npm run dev` | API + Vite together |
| `npm run build` | Typecheck, compile the server to `dist/`, build the client to `dist/client` |
| `npm start` | Serve the built site and the API from Node (`PORT`, default 8787) |
| `npm test` | Vitest |
| `npm run smoke` | Health check plus one mock job. The server must already be running in mock mode. |
| `npm run export:mock` | In-process mock job from `samples/`, then a final MP4. Prints the file path. |

`npm start` is run from the project folder so it can see `dist/client`, `workflows/`, and `outputs/`.

## Mock mode

Leave `COMFY_CLOUD_API_KEY` empty, or set `GENERATION_BACKEND=mock`. The UI badge reads **MOCK**. Each segment becomes an SVG plate tinted by its look. No network calls.

`MOCK_FAIL_RATE` (default `0`) fails segments deterministically from the cache key and attempt. `0` never fails. `1` always fails. `MOCK_LATENCY_MS` (default `400`) is the simulated queue plus run time.

Finished segments are cached under `outputs/cache/` by a hash of photo bytes, look, prompt, seed, and duration. A retry or a new job with the same inputs reuses the file.

## Comfy Cloud

1. Create a key at https://platform.comfy.org/profile/api-keys . Generation needs an active Comfy Cloud subscription with credits.
2. In `.env`:

```
GENERATION_BACKEND=comfy-cloud
COMFY_CLOUD_API_KEY=your-key
COMFY_CLOUD_BASE_URL=https://cloud.comfy.org
COMFY_CLOUD_API_VERSION=v2
COMFY_WORKFLOW=workflows/ltx-i2v.api.json
COMFY_WORKFLOW_MAP=workflows/ltx-i2v.map.json
```

3. Export your real LTX image-to-video workflow from Comfy Cloud with **Export (API)** and replace `workflows/ltx-i2v.api.json`. Fill `workflows/ltx-i2v.map.json` so each binding names the node id and input that should receive the still, positive prompt, negative prompt, seed, frame count, width, height, and fps, plus the output node.

The key is read only on the server. It is never sent to the browser and is redacted from errors. The badge reads **COMFY CLOUD**. The shipped graph is a placeholder: `/api/health` reports that, and the API refuses cloud jobs until the placeholder flag is cleared by a real export. The process still starts.

`COMFY_CLOUD_API_VERSION=v1` uses the deprecated ComfyUI-compatible endpoints (`X-API-Key`). v2 is the default (`Authorization: Bearer`).

HTTP 401, 402, and 429 from Comfy Cloud become: bad key, out of credits, subscription inactive (or rate limited).

### Endpoints the adapter calls

Base URL defaults to `https://cloud.comfy.org`.

**API v2**

- `POST /api/v2/assets` — multipart upload (`file`, `content_type`, `file_path`)
- `POST /api/v2/jobs` — body `{ workflow }` plus an `Idempotency-Key` header per segment. The still is a `core/ASSET` object (`__type`, `info.id`, optional `hash` and `file_path`)
- `GET /api/v2/jobs/{id}` — poll status and outputs
- `POST /api/v2/jobs/{id}/cancel`
- Download the output `url` from the job, or `GET /api/v2/assets/{id}/content`. A 302 to a signed URL is followed with no auth header

**API v1** (`COMFY_CLOUD_API_VERSION=v1`)

- `POST /api/upload/image` — multipart `image`, `type=input`, `overwrite=true`
- `POST /api/prompt` — body `{ prompt }` (the API-format graph)
- `GET /api/job/{id}/status`
- `GET /api/view?filename=&subfolder=&type=output` — manual redirect, no auth header on the signed URL

### This app's API

- `GET /api/health` — backend, workflow problems, no secrets
- `POST /api/jobs` — multipart `cutlist` (JSON), `photos` (1–5), optional `audio`
- `GET /api/jobs/:id` — poll
- `GET /api/jobs/:id/events` — server-sent events
- `POST /api/jobs/:id/retry` — optional JSON `{ segmentIds }`
- `POST /api/jobs/:id/cancel`
- `GET /api/jobs/:id/cutlist.json`
- `GET /api/jobs/:id/segments/:segmentId/file`
- `POST /api/jobs/:id/export` — start an MP4. Optional JSON `{ "captions": { "s00": "DROP" } }` updates burn-in text without regenerating plates. `409` if any segment is not done. `202` while rendering, `200` when a cached file is returned
- `GET /api/jobs/:id/export` — `{ status, progress, error, fileUrl, fps, duration }`
- `GET /api/jobs/:id/export/file` — the MP4, `Content-Disposition: attachment`

The UI polls and also listens on the event stream. Per-segment status is `queued`, `running`, `done`, or `failed`.

## Final MP4

When every plate is done, **Export MP4** assembles them in cut-list order.

- Picture: 1080×1920, H.264, `yuv420p`, `+faststart`, AAC, 30 fps (`EXPORT_FPS=24` or `30`, default 30).
- Each segment is scaled and center-cropped to cover 1080×1920, then trimmed or padded by cloning its last frame so its length is exactly `end - start`. Cuts stay on the beats. The picture length of the song portion equals the trimmed window (`clipEnd - clipStart`).
- Audio is only the uploaded song, trimmed to that window, with a 50 ms fade in and out. Audio inside segment files is ignored.
- Captions from the cut list are burned in as ASS subtitles (Archivo Black, the Cut Sheet styles). Text stays inside a safe area: 90 px from each side, below the top 250 px, and above the bottom 420 px. The player CSS uppercases captions, and so does the burn-in.
- Transitions do not change the duration and do not move the cut. `hard` is a concat. `flash` is one acid frame at the start of each segment after the first. `whip` is a ~120 ms slide inside the incoming segment, not an overlapping crossfade.
- `EXPORT_END_CARD_URL` empty (the default) means no end card. When it is set, a card of `EXPORT_END_CARD_SECONDS` (default 2, clamped to 0.5–10) is appended **after** the song. The song is not stretched. The card is silent: the song fades out at the end of the window and silence fills the card.
- The file is `outputs/<job id>/export/reel.mp4`. A repeat export is instant when the segment cache keys, timing, captions, song hash, and export settings are unchanged. Editing one row's look requeues only that row; the other plates stay cached. A caption change re-encodes the MP4 and does not regenerate plates.

ffmpeg is resolved in this order: `FFMPEG_PATH`, then `ffmpeg` on `PATH`, then the `ffmpeg-static` package. A candidate that does not answer `ffmpeg -version` is skipped. ffprobe follows `FFPROBE_PATH`, `ffprobe` on `PATH`, a sibling of the chosen ffmpeg, then `ffprobe-static`. `/api/health` reports `ffmpeg`, `ffmpegSource` (`FFMPEG_PATH`, `PATH`, or `ffmpeg-static`), and `ffmpegPath`.

Mock plates are SVG. Export rasterizes the color blocks to PNG before ffmpeg, because the bundled binary has no SVG decoder. The burned-in caption is the on-screen text.

`npm run export:mock` forces mock mode, ignores any Comfy key in the environment, and writes under `outputs/export-mock/`. **Load sample** in the Cut Sheet uses `samples/` (a synthesized 16 s song and three abstract 9:16 plates, CC0, no people). See `samples/README.md`.

Workflow audio is still stripped with the same ffmpeg binary before a segment is saved.

## Comfy deployment (serverless GPU, scale to zero)

### Recommended: dedicated deployment endpoint

The simplest working setup. Point DropCut straight at your deployment's endpoint. It serves the same v2 API (`Authorization: Bearer`, `POST /api/v2/assets`, `POST /api/v2/jobs`, `GET /api/v2/jobs/{id}`) and is not subject to the shared API's plan gate.

```
GENERATION_BACKEND=comfy-cloud
COMFY_CLOUD_API_KEY=comfyui-...
COMFY_DEPLOYMENT_ENDPOINT=https://<deployment-id>.run.comfy.app
# DEPLOY_CONTROL=manage   # optional: let DropCut start/stop COMFY_DEPLOYMENT_ID too
```

- `COMFY_DEPLOYMENT_ENDPOINT` overrides `COMFY_CLOUD_BASE_URL` and always uses API v2.
- With the endpoint set, `DEPLOY_CONTROL` defaults to `off`: DropCut never starts, stops or reconfigures the deployment, so you manage it (warm time, scale) in the Comfy dashboard. Set `DEPLOY_CONTROL=manage` together with `COMFY_DEPLOYMENT_ID` to get the start/idle-stop behaviour below.

### Managed start/stop via the control plane

When a workspace plan blocks the hosted job API, run the workflow on your own Comfy deployment (built with `comfy build` and `comfy deploy up`, min 0 / max 1). The data plane is the same v2 API, so only the base URL changes:

```
GENERATION_BACKEND=comfy-cloud
COMFY_CLOUD_API_KEY=comfyui-...
COMFY_CLOUD_BASE_URL=https://<deployment-id>.run.comfy.app
COMFY_CLOUD_API_VERSION=v2
COMFY_DEPLOYMENT_ID=<deployment-id>
DEPLOY_IDLE_STOP_MIN=10        # stop the deployment this long after the last segment; 0 disables
# COMFY_DEPLOY_URL=https://platformapi.comfy.org/deploy   (control plane, default)
```

What the server does with `COMFY_DEPLOYMENT_ID` set (`server/deploy/controller.ts`):

- Looks up status with `GET /v1/deployments/{id}` (header `X-API-Key`). `/api/health` and `GET /api/deployment` show it.
- When a Generate job starts and any segment is not cached, it calls `POST /v1/deployments/{id}/start` if the deployment is stopped or failed. It then polls until the status is `ready`. Segments are submitted only after that. The job carries a `deployment` view, and the UI shows "WARMING UP (cold start ~10 min)" with the staging step, progress and elapsed time.
- After the last running job finishes, it waits `DEPLOY_IDLE_STOP_MIN` minutes and then calls `POST /v1/deployments/{id}/stop`. A new job inside that window cancels the stop. If the server boots while the deployment is already running, it starts the same idle timer.
- `POST /api/deployment/stop` stops it right away.
- It never changes scale (min 0 / max 1 stays as deployed). Mock mode and setups without a deployment ID skip all of this.

Billing: queued, provisioning, starting, ready and unhealthy hold compute. Stopped keeps the staged models and only bills storage.

## Open TODOs

- **Real workflow.** The shipped LTX graph still has to be the operator's own Export (API) graph if the placeholder flag is set. Fill in `workflows/ltx-i2v.map.json` to match that graph.
- **License.** MIT is the license. See `LICENSE`, copyright venthewise. The bundled caption font is Archivo Black under the SIL Open Font License (`server/export/ArchivoBlack-OFL.txt`). Sample media is CC0 (`samples/README.md`).

Do not commit `.env`, `outputs/`, or API keys.

## Shipped workflow: LTX-2.5 i2v (with generated audio)

`workflows/ltx-i2v.api.json` is a real LTX-2.5 image-to-video graph and `workflows/ltx-i2v.map.json` binds it:

- Each binding may be one `{nodeId, input}` or a list (the two sampler seeds `398:339` and `398:338` both get the segment seed).
- `duration` (PrimitiveInt `398:362`) takes the segment length rounded to whole seconds and clamped to `durationMinSeconds`..`durationMaxSeconds`. The graph computes frames = seconds × fps + 1.
- `aspect` (ResolutionSelector `403`) is set to the exact option string `9:16 (Portrait Widescreen)`.
- `enhance` (`398:383`) follows `enhancePrompt` (off by default).
- `outputHasAudio: true` makes the server strip the graph's generated audio with `ffmpeg -an` before saving each segment. The preview player is muted, so the song is the only soundtrack.

`npx tsx scripts/cloud-test.ts <image.png> 2.5` runs ONE real cloud segment against a running server. It spends credits.
