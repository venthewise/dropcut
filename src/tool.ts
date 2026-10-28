import type { DeploymentView, ExportResponse, HealthResponse, JobResponse } from "../shared/api-types";
import { buildCutlist, defaultWindow, segmentSeed, type CutSegment, type Cutlist } from "../shared/cutlist";
import { CAPTION_STYLES, LOOKS, MAX_CLIP_SEC, MAX_PHOTOS, TRANSITIONS, lookById, renderPrompt, type Transition } from "../shared/looks";
import { formatSeconds, formatTimecode } from "../shared/timecode";
import { cancelJob, createJob, getExport, getHealth, patchSegmentLook, retryJob, startExport as requestExport, watchJob } from "./api";
import { analyzeFile, type BeatAnalysis } from "./beats";
import { attachPlayer, type PlayerHandle, type PlayerSegment } from "./player";
import { drawWaveform } from "./wave";

interface PhotoItem {
  file: File;
  url: string;
}

const LOOK_LABEL = new Map(LOOKS.map((look) => [look.id, look.label]));

export function mountTool(root: HTMLElement): void {
  root.innerHTML = `
    <p class="backend-row">
      <span class="badge" id="backend-badge">CHECKING</span>
      <span id="backend-note"></span>
    </p>
    <ul class="problems" id="problems" hidden></ul>
    <div class="split">
      <label class="drop" id="photo-drop">
        <span class="plate-idx">PLATE A · STILLS</span>
        <strong>Photos</strong>
        <span class="hint">1 to 5. Drag them in, or use the file control. PNG, JPEG, WebP, GIF.</span>
        <input id="photo-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif" multiple>
      </label>
      <label class="drop" id="audio-drop">
        <span class="plate-idx">PLATE A · TRACK</span>
        <strong>Song</strong>
        <span class="hint">One file. mp3, wav, or m4a. Beat marks stay in the browser.</span>
        <input id="audio-input" type="file" accept="audio/mpeg,audio/wav,audio/mp4,audio/x-m4a,.mp3,.wav,.m4a">
      </label>
    </div>
    <p class="row-actions">
      <button type="button" class="btn line" id="load-sample">Load sample</button>
      <span class="hint">Bundled 16 second song and three abstract plates. No upload.</span>
    </p>
    <div class="thumbs" id="thumbs"></div>
    <p id="audio-name" class="hint"></p>
    <div class="wave-wrap">
      <canvas id="wave" width="960" height="160" aria-hidden="true"></canvas>
      <p id="wave-stats" class="hint"></p>
    </div>
    <div class="trim">
      <label>Window in (seconds)
        <input id="trim-in" type="range" min="0" max="1" step="0.01" value="0" disabled>
        <input id="trim-in-num" type="number" min="0" step="0.01" value="0" disabled>
      </label>
      <label>Window out (seconds)
        <input id="trim-out" type="range" min="0" max="1" step="0.01" value="0" disabled>
        <input id="trim-out-num" type="number" min="0" step="0.01" value="0" disabled>
      </label>
      <p id="window-label" class="hint">Default window is the first 15 seconds. Maximum 30.</p>
      <div class="row-actions">
        <button type="button" class="btn line" id="mark-drop">Mark drop at playhead</button>
        <button type="button" class="btn line" id="reset-drops">Use detected drops</button>
      </div>
    </div>
    <fieldset class="looks-field">
      <legend>Looks</legend>
      <div class="looks" id="looks"></div>
    </fieldset>
    <div class="split">
      <fieldset>
        <legend>Caption style</legend>
        <div class="choices" id="caption-styles"></div>
      </fieldset>
      <fieldset>
        <legend>Transition</legend>
        <div class="choices" id="transitions"></div>
      </fieldset>
      <label>Seed
        <input id="seed" type="number" min="0" max="999999999" step="1" value="1">
      </label>
    </div>
    <p class="hint">Same photos, window, looks, per-row looks, and seed rebuild the same cuts. Promo is the tilted price tag: write a smaller second line after " | ".</p>
    <div class="table-scroll">
      <table class="edl">
        <caption>Edit decision list</caption>
        <thead>
          <tr>
            <th scope="col">ID</th>
            <th scope="col">In</th>
            <th scope="col">Out</th>
            <th scope="col">Frames</th>
            <th scope="col">Photo</th>
            <th scope="col">Look</th>
            <th scope="col">Cut</th>
            <th scope="col">Caption</th>
          </tr>
        </thead>
        <tbody id="edl-body"></tbody>
      </table>
    </div>
    <div class="row-actions">
      <button type="button" class="btn solid" id="generate" disabled>Generate</button>
      <button type="button" class="btn line" id="cancel" hidden>Cancel</button>
      <button type="button" class="btn line" id="retry-all" hidden>Retry failed</button>
    </div>
    <div id="meter" class="meter" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" hidden>
      <span></span>
    </div>
    <p id="live" class="hint" aria-live="polite"></p>
    <div class="contact" id="sheet"></div>
    <div class="preview-grid">
      <div>
        <div class="player-frame" id="player-frame"></div>
        <div class="transport">
          <button type="button" class="btn solid" id="play" disabled aria-pressed="false">Play</button>
          <label class="scrub-label">Playhead
            <input id="scrub" type="range" min="0" max="1" step="0.01" value="0" disabled>
          </label>
          <span id="readout" class="timecode">00:00:00:00</span>
        </div>
        <audio id="song" preload="auto"></audio>
      </div>
      <div>
        <h3 class="export-title">Export</h3>
        <p class="hint">1080×1920 H.264, the song trimmed to the window, captions burned in above the platform UI. Every plate must be done.</p>
        <div class="export-box" id="export"></div>
      </div>
    </div>
  `;

  const badge = must<HTMLElement>(root, "#backend-badge");
  const backendNote = must<HTMLElement>(root, "#backend-note");
  const problems = must<HTMLElement>(root, "#problems");
  const photoInput = must<HTMLInputElement>(root, "#photo-input");
  const audioInput = must<HTMLInputElement>(root, "#audio-input");
  const photoDrop = must<HTMLElement>(root, "#photo-drop");
  const audioDrop = must<HTMLElement>(root, "#audio-drop");
  const thumbs = must<HTMLElement>(root, "#thumbs");
  const audioName = must<HTMLElement>(root, "#audio-name");
  const wave = must<HTMLCanvasElement>(root, "#wave");
  const waveStats = must<HTMLElement>(root, "#wave-stats");
  const trimIn = must<HTMLInputElement>(root, "#trim-in");
  const trimOut = must<HTMLInputElement>(root, "#trim-out");
  const trimInNum = must<HTMLInputElement>(root, "#trim-in-num");
  const trimOutNum = must<HTMLInputElement>(root, "#trim-out-num");
  const windowLabel = must<HTMLElement>(root, "#window-label");
  const looksBox = must<HTMLElement>(root, "#looks");
  const captionBox = must<HTMLElement>(root, "#caption-styles");
  const transitionBox = must<HTMLElement>(root, "#transitions");
  const seedInput = must<HTMLInputElement>(root, "#seed");
  const tbody = must<HTMLElement>(root, "#edl-body");
  const generateBtn = must<HTMLButtonElement>(root, "#generate");
  const cancelBtn = must<HTMLButtonElement>(root, "#cancel");
  const retryAllBtn = must<HTMLButtonElement>(root, "#retry-all");
  const meter = must<HTMLElement>(root, "#meter");
  const meterBar = must<HTMLElement>(meter, "span");
  const live = must<HTMLElement>(root, "#live");
  const sheet = must<HTMLElement>(root, "#sheet");
  const frame = must<HTMLElement>(root, "#player-frame");
  const playButton = must<HTMLButtonElement>(root, "#play");
  const scrub = must<HTMLInputElement>(root, "#scrub");
  const readOut = must<HTMLElement>(root, "#readout");
  const audioEl = must<HTMLAudioElement>(root, "#song");
  const exportBox = must<HTMLElement>(root, "#export");

  let photos: PhotoItem[] = [];
  let audioFile: File | null = null;
  let analysis: BeatAnalysis | null = null;
  let trimStart = 0;
  let trimEnd = 0;
  let lookIds = LOOKS.map((look) => look.id);
  let captionStyle = "block";
  let transition: Transition = "hard";
  let dropsOverride: number[] | null = null;
  const captionEdits = new Map<string, string>();
  const lookEdits = new Map<string, string>();
  let cutlist: Cutlist | null = null;
  let job: JobResponse | null = null;
  let health: HealthResponse | null = null;
  let stopWatch: (() => void) | null = null;
  let playhead: number | undefined;
  let busy = false;
  let exportState: ExportResponse | null = null;
  let exportTimer = 0;

  const player: PlayerHandle = attachPlayer({ frame, audio: audioEl, playButton, scrub, readOut });
  player.onTime((time) => {
    playhead = time;
    paintWave();
  });

  for (const look of LOOKS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "look";
    button.dataset.look = look.id;
    button.setAttribute("aria-pressed", "true");
    button.textContent = look.label;
    button.addEventListener("click", () => {
      const on = lookIds.includes(look.id);
      if (on && lookIds.length === 1) return;
      lookIds = on ? lookIds.filter((id) => id !== look.id) : [...lookIds, look.id];
      button.setAttribute("aria-pressed", lookIds.includes(look.id) ? "true" : "false");
      rebuild();
    });
    looksBox.append(button);
  }

  for (const style of CAPTION_STYLES) {
    const label = choice("caption-style", style.id, style.label, style.id === captionStyle, () => {
      captionStyle = style.id;
      rebuild();
    });
    label.title = style.note;
    captionBox.append(label);
  }
  for (const item of TRANSITIONS) {
    transitionBox.append(choice("transition", item.id, item.label, item.id === transition, () => {
      transition = item.id;
      rebuild();
    }));
  }

  seedInput.addEventListener("change", () => rebuild());
  photoInput.addEventListener("change", () => {
    takePhotos([...photoInput.files ?? []]);
    photoInput.value = "";
  });
  audioInput.addEventListener("change", () => {
    const file = audioInput.files?.[0];
    if (file) void takeAudio(file);
    audioInput.value = "";
  });
  bindDrop(photoDrop, (files) => takePhotos(files.filter(isImageFile)));
  bindDrop(audioDrop, (files) => {
    const file = files.find(isAudioFile);
    if (file) void takeAudio(file);
    else say("Drop an mp3, wav, or m4a on the song plate.");
  });
  trimIn.addEventListener("input", () => commitTrim(Number(trimIn.value), trimEnd, "start"));
  trimOut.addEventListener("input", () => commitTrim(trimStart, Number(trimOut.value), "end"));
  trimInNum.addEventListener("change", () => commitTrim(Number(trimInNum.value), trimEnd, "start"));
  trimOutNum.addEventListener("change", () => commitTrim(trimStart, Number(trimOutNum.value), "end"));
  must<HTMLButtonElement>(root, "#mark-drop").addEventListener("click", () => {
    if (!analysis) return;
    toggleDrop(Number.isFinite(audioEl.currentTime) ? audioEl.currentTime : trimStart);
  });
  must<HTMLButtonElement>(root, "#reset-drops").addEventListener("click", () => {
    dropsOverride = null;
    rebuild();
  });
  wave.addEventListener("click", (ev) => {
    if (!analysis || analysis.duration <= 0) return;
    const rect = wave.getBoundingClientRect();
    const time = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * analysis.duration;
    toggleDrop(time);
  });
  generateBtn.addEventListener("click", () => void generate());
  cancelBtn.addEventListener("click", () => void cancel());
  retryAllBtn.addEventListener("click", () => void retry());
  must<HTMLButtonElement>(root, "#load-sample").addEventListener("click", () => void loadSample());

  void loadHealth();
  renderTable();
  renderExport();
  paintWave();

  function activeDrops(): number[] {
    return dropsOverride ?? analysis?.drops ?? [];
  }

  function toggleDrop(time: number): void {
    if (!analysis) return;
    const drops = [...activeDrops()];
    const index = drops.findIndex((drop) => Math.abs(drop - time) < 0.18);
    if (index >= 0) drops.splice(index, 1);
    else drops.push(Math.min(analysis.duration, Math.max(0, time)));
    drops.sort((a, b) => a - b);
    dropsOverride = drops;
    rebuild();
  }

  function takePhotos(files: File[]): void {
    const images = files.filter(isImageFile);
    if (images.length === 0) {
      say("Choose image files.");
      return;
    }
    for (const photo of photos) URL.revokeObjectURL(photo.url);
    const next = images.slice(0, MAX_PHOTOS);
    photos = next.map((file) => ({ file, url: URL.createObjectURL(file) }));
    if (images.length > MAX_PHOTOS) say(`Using the first ${MAX_PHOTOS} photos.`);
    renderThumbs();
    clearJob();
    rebuild();
  }

  async function takeAudio(file: File): Promise<void> {
    if (!isAudioFile(file)) {
      say("Use an mp3, wav, or m4a file.");
      return;
    }
    audioFile = file;
    if (audioEl.src.startsWith("blob:")) URL.revokeObjectURL(audioEl.src);
    audioEl.src = URL.createObjectURL(file);
    audioName.textContent = file.name;
    busy = true;
    say("Reading the track…");
    syncGenerate();
    try {
      analysis = await analyzeFile(file);
      const window = defaultWindow(analysis.duration);
      trimStart = window.start;
      trimEnd = window.end;
      dropsOverride = null;
      clearJob();
      const drops = analysis.drops.length;
      say(`${analysis.bpm.toFixed(1)} BPM. ${analysis.beats.length} beats. ${drops} drop${drops === 1 ? "" : "s"}. Window ${formatSeconds(trimEnd - trimStart)}.`);
      rebuild();
    } catch (err) {
      analysis = null;
      say(err instanceof Error ? err.message : "Could not read that song.");
      rebuild();
    } finally {
      busy = false;
      syncGenerate();
    }
  }

  function commitTrim(start: number, end: number, edge: "start" | "end"): void {
    if (!analysis) return;
    const dur = analysis.duration;
    let a = clamp(start, 0, Math.max(0, dur - 0.2));
    let b = clamp(end, Math.min(dur, 0.2), dur);
    if (b < a) {
      if (edge === "start") a = Math.max(0, b - 0.2);
      else b = Math.min(dur, a + 0.2);
    }
    if (b - a > MAX_CLIP_SEC) {
      if (edge === "start") a = Math.max(0, b - MAX_CLIP_SEC);
      else b = Math.min(dur, a + MAX_CLIP_SEC);
    }
    if (b - a < 0.2) {
      if (edge === "start") a = Math.max(0, b - 0.2);
      else b = Math.min(dur, a + 0.2);
    }
    trimStart = a;
    trimEnd = b;
    rebuild();
  }

  function rebuild(): void {
    syncTrim();
    renderThumbs();
    if (!analysis || photos.length === 0 || trimEnd - trimStart < 0.2) {
      cutlist = null;
      renderTable();
      renderSheet();
      renderExport();
      pushPlayer();
      paintWave();
      syncGenerate();
      return;
    }
    const seed = Number(seedInput.value);
    try {
      const next = buildCutlist({
        clipStart: trimStart,
        clipEnd: trimEnd,
        drops: activeDrops(),
        beats: analysis.beats,
        photoCount: photos.length,
        lookIds,
        transition,
        captionStyle,
        seed: Number.isFinite(seed) ? seed : 1,
        bpm: analysis.bpm,
      });
      for (const seg of next.segments) {
        const edited = captionEdits.get(editKey(seg));
        if (edited != null) seg.caption = edited;
        const lookId = lookEdits.get(editKey(seg));
        if (lookId && lookById(lookId)) assignLook(seg, lookId, next.seed);
      }
      cutlist = next;
    } catch (err) {
      cutlist = null;
      say(err instanceof Error ? err.message : "Could not build the cut list.");
    }
    renderTable();
    renderSheet();
    renderExport();
    pushPlayer();
    paintWave();
    syncGenerate();
    const drops = activeDrops().filter((time) => time > trimStart && time < trimEnd).length;
    waveStats.textContent = analysis
      ? `${analysis.bpm.toFixed(1)} BPM · ${drops} drop marks in the window · ${cutlist?.segments.length ?? 0} segments`
      : "";
  }

  async function loadHealth(): Promise<void> {
    try {
      health = await getHealth();
      badge.textContent = health.backendLabel;
      badge.dataset.backend = health.backend;
      backendNote.textContent = health.backend === "mock"
        ? "Mock plates. No key, no network."
        : health.deployment
          ? `Comfy deployment · ${deploymentLine(health.deployment)}`
          : health.apiVersion === "v1"
            ? "Comfy Cloud API v1."
            : "Comfy Cloud API v2.";
      problems.replaceChildren();
      if (health.workflow.problems.length === 0) {
        problems.hidden = true;
      } else {
        problems.hidden = false;
        for (const problem of health.workflow.problems) {
          const li = document.createElement("li");
          li.textContent = `${problem.level.toUpperCase()} · ${problem.message}`;
          problems.append(li);
        }
      }
    } catch (err) {
      badge.textContent = "OFFLINE";
      backendNote.textContent = err instanceof Error ? err.message : "API is offline.";
    }
    syncGenerate();
  }

  async function generate(): Promise<void> {
    if (!cutlist || !audioFile || photos.length === 0) return;
    generateBtn.disabled = true;
    say("Sending the cut list…");
    try {
      stopWatch?.();
      stopWatch = null;
      exportState = null;
      window.clearInterval(exportTimer);
      job = await createJob(cutlist, photos.map((photo) => photo.file), audioFile);
      renderJob();
      stopWatch = watchJob(job.id, (next) => {
        job = next;
        renderJob();
      }, (message) => say(message));
    } catch (err) {
      say(err instanceof Error ? err.message : "Could not start generation.");
      renderJob();
      syncGenerate();
    }
  }

  async function cancel(): Promise<void> {
    if (!job) return;
    try {
      job = await cancelJob(job.id);
      renderJob();
    } catch (err) {
      say(err instanceof Error ? err.message : "Cancel failed.");
    }
  }

  async function retry(segmentIds?: string[]): Promise<void> {
    if (!job) return;
    try {
      stopWatch?.();
      job = await retryJob(job.id, segmentIds);
      renderJob();
      stopWatch = watchJob(job.id, (next) => {
        job = next;
        renderJob();
      }, (message) => say(message));
    } catch (err) {
      say(err instanceof Error ? err.message : "Retry failed.");
    }
  }

  function deploymentLine(dep: DeploymentView): string {
    const parts = [dep.message];
    if (dep.phase === "warming") {
      if (dep.warmingSince) {
        const secs = Math.max(0, Math.round((Date.now() - Date.parse(dep.warmingSince)) / 1000));
        parts.push(`${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s elapsed`);
      }
      if (typeof dep.etaSeconds === "number" && dep.etaSeconds > 0) parts.push(`~${Math.ceil(dep.etaSeconds / 60)} min left`);
      parts.push("plates submit when ready");
    }
    return parts.join(" · ");
  }

  function renderJob(): void {
    renderSheet();
    renderExport();
    pushPlayer();
    if (!job) return;
    const pct = Math.round(Math.max(0, Math.min(1, job.progress)) * 100);
    meter.hidden = false;
    meter.setAttribute("aria-valuenow", String(pct));
    meterBar.style.width = `${pct}%`;
    const done = job.segments.filter((seg) => seg.status === "done").length;
    const failed = job.segments.filter((seg) => seg.status === "failed").length;
    const running = job.status === "running" || job.status === "queued";
    cancelBtn.hidden = !running;
    retryAllBtn.hidden = failed === 0 || running;
    const dep = job.deployment;
    const warming = running && dep && dep.phase !== "ready" && !job.segments.some((seg) => seg.status !== "queued");
    let message = `${job.status.toUpperCase()} · ${pct}% · ${done} of ${job.segments.length} plates${failed ? ` · ${failed} failed` : ""}`;
    if (warming && dep) {
      const warmPct = typeof dep.stepProgress === "number" ? Math.round(dep.stepProgress * 100) : 0;
      meter.setAttribute("aria-valuenow", String(warmPct));
      meterBar.style.width = `${warmPct}%`;
      message = `WARMING UP · ${deploymentLine(dep)}`;
    } else if (!running && dep?.idleStopAt) {
      const mins = Math.max(0, Math.round((Date.parse(dep.idleStopAt) - Date.now()) / 60000));
      message += ` · GPU auto-stops in ~${mins} min`;
    }
    say(message);
    syncGenerate();
  }

  function renderThumbs(): void {
    thumbs.replaceChildren();
    photos.forEach((photo, index) => {
      const fig = document.createElement("figure");
      fig.className = "thumb";
      const img = document.createElement("img");
      img.src = photo.url;
      img.alt = `Photo ${index + 1}`;
      const cap = document.createElement("figcaption");
      cap.textContent = `${"ABC"[index] ?? index + 1} · ${photo.file.name}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        URL.revokeObjectURL(photo.url);
        photos = photos.filter((item) => item !== photo);
        clearJob();
        rebuild();
      });
      fig.append(img, cap, remove);
      thumbs.append(fig);
    });
  }

  function lookCell(seg: CutSegment): HTMLTableCellElement {
    const cell = document.createElement("td");
    const select = document.createElement("select");
    select.setAttribute("aria-label", `Look for segment ${seg.id}`);
    for (const look of LOOKS) {
      const option = document.createElement("option");
      option.value = look.id;
      option.textContent = look.label;
      select.append(option);
    }
    if (!LOOKS.some((look) => look.id === seg.look)) {
      const extra = document.createElement("option");
      extra.value = seg.look;
      extra.textContent = LOOK_LABEL.get(seg.look) ?? seg.look;
      select.append(extra);
    }
    select.value = seg.look;
    select.addEventListener("change", () => {
      void commitLook(seg, select);
    });
    cell.append(select);
    return cell;
  }

  async function commitLook(seg: CutSegment, select: HTMLSelectElement): Promise<void> {
    const lookId = select.value;
    const previous = seg.look;
    if (!lookById(lookId) || lookId === previous) {
      select.value = previous;
      return;
    }
    const base = cutlist?.seed ?? Number(seedInput.value);
    assignLook(seg, lookId, Number.isFinite(base) ? base : 1);
    lookEdits.set(editKey(seg), lookId);
    renderSheet();
    const remote = jobSegmentFor(seg);
    if (!job || !remote) return;
    select.disabled = true;
    const previousExport = exportState;
    exportState = null;
    window.clearInterval(exportTimer);
    try {
      stopWatch?.();
      stopWatch = null;
      const updated = await patchSegmentLook(job.id, seg.id, lookId);
      job = updated;
      const fromServer = updated.cutlist.segments.find((item) => item.id === seg.id);
      if (fromServer) {
        seg.look = fromServer.look;
        seg.prompt = fromServer.prompt;
        seg.negativePrompt = fromServer.negativePrompt;
        seg.seed = fromServer.seed;
        select.value = fromServer.look;
        lookEdits.set(editKey(seg), fromServer.look);
      }
      renderJob();
      if (updated.status === "running" || updated.status === "queued") {
        stopWatch = watchJob(updated.id, (next) => {
          job = next;
          const live = cutlist?.segments.find((item) => item.id === seg.id);
          const serverCut = next.cutlist.segments.find((item) => item.id === seg.id);
          if (live && serverCut) {
            live.look = serverCut.look;
            live.prompt = serverCut.prompt;
            live.negativePrompt = serverCut.negativePrompt;
            live.seed = serverCut.seed;
          }
          renderJob();
        }, (message) => say(message));
      }
    } catch (err) {
      assignLook(seg, previous, Number.isFinite(base) ? base : 1);
      lookEdits.set(editKey(seg), previous);
      select.value = previous;
      exportState = previousExport;
      renderSheet();
      renderExport();
      if (previousExport?.status === "running") pollExport();
      say(err instanceof Error ? err.message : "Could not change the look.");
    } finally {
      select.disabled = false;
    }
  }

  function jobSegmentFor(seg: CutSegment): JobResponse["segments"][number] | undefined {
    if (!job) return undefined;
    const remote = job.segments.find((item) => item.id === seg.id);
    const cut = job.cutlist.segments.find((item) => item.id === seg.id);
    if (!remote || !cut) return undefined;
    if (Math.abs(cut.start - seg.start) > 0.001 || Math.abs(cut.end - seg.end) > 0.001) return undefined;
    return remote;
  }

  function renderTable(): void {
    tbody.replaceChildren();
    if (!cutlist) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 8;
      cell.textContent = `Add 1–${MAX_PHOTOS} photos and a song. The cut list lands here.`;
      row.append(cell);
      tbody.append(row);
      return;
    }
    for (const seg of cutlist.segments) {
      const row = document.createElement("tr");
      row.append(
        td(seg.id.toUpperCase()),
        td(formatTimecode(seg.start)),
        td(formatTimecode(seg.end)),
        td(String(seg.frames)),
        td("ABC"[seg.photoIndex] ?? String(seg.photoIndex + 1)),
      );
      row.append(lookCell(seg));
      row.append(td(seg.transition));
      const input = document.createElement("input");
      input.type = "text";
      input.maxLength = 48;
      input.value = seg.caption;
      input.setAttribute("aria-label", `Caption for segment ${seg.id}`);
      input.addEventListener("input", () => {
        seg.caption = input.value;
        captionEdits.set(editKey(seg), input.value);
        player.setCaption(seg.id, input.value);
      });
      const capCell = document.createElement("td");
      capCell.append(input);
      row.append(capCell);
      tbody.append(row);
    }
  }

  function renderSheet(): void {
    const segments = cutlist?.segments ?? [];
    const keep = new Set(segments.map((seg) => seg.id));
    for (const child of [...sheet.children]) {
      const id = (child as HTMLElement).dataset.id;
      if (!id || !keep.has(id)) child.remove();
    }
    for (const seg of segments) {
      let fig = sheet.querySelector<HTMLElement>(`figure[data-id="${seg.id}"]`);
      if (!fig) {
        fig = document.createElement("figure");
        fig.dataset.id = seg.id;
        const plate = document.createElement("div");
        plate.className = "result-plate";
        const status = document.createElement("span");
        status.className = "plate-status";
        const cap = document.createElement("figcaption");
        plate.append(status);
        fig.append(plate, cap);
        sheet.append(fig);
      }
      const remote = job?.segments.find((item) => item.id === seg.id);
      const plate = fig.querySelector(".result-plate");
      const status = fig.querySelector(".plate-status");
      const cap = fig.querySelector("figcaption");
      if (!plate || !status || !cap) continue;
      const url = remote?.status === "done" && remote.fileUrl ? remote.fileUrl : photos[seg.photoIndex]?.url ?? "";
      let img = plate.querySelector("img");
      if (url) {
        if (!img) {
          img = document.createElement("img");
          plate.prepend(img);
        }
        if (img.getAttribute("src") !== url) {
          img.src = url;
          img.alt = remote?.fileUrl ? `${LOOK_LABEL.get(seg.look) ?? seg.look} result ${seg.id}` : "";
        }
      } else if (img) {
        img.remove();
      }
      const label = (remote?.status ?? "PLANNED").toUpperCase();
      if (status.textContent !== label) status.textContent = label;
      const caption = `${seg.id.toUpperCase()} · ${LOOK_LABEL.get(seg.look) ?? seg.look} · ${formatTimecode(seg.start)}`;
      if (cap.textContent !== caption) cap.textContent = caption;
      const retryBtn = plate.querySelector<HTMLButtonElement>("[data-retry]");
      const err = plate.querySelector(".plate-error");
      if (remote?.status === "failed") {
        if (!retryBtn) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "btn line";
          button.dataset.retry = seg.id;
          button.textContent = "Retry";
          button.addEventListener("click", () => void retry([seg.id]));
          plate.append(button);
        }
        if (remote.error) {
          const node = err ?? document.createElement("p");
          node.className = "plate-error";
          node.textContent = remote.error;
          if (!err) plate.append(node);
        } else {
          err?.remove();
        }
      } else {
        retryBtn?.remove();
        err?.remove();
      }
    }
  }

  function clearJob(): void {
    job = null;
    exportState = null;
    window.clearInterval(exportTimer);
    stopWatch?.();
    stopWatch = null;
  }

  async function loadSample(): Promise<void> {
    say("Loading the sample song and plates…");
    try {
      const [a, b, c, song] = await Promise.all([
        fetch("/samples/photo-a.png"),
        fetch("/samples/photo-b.png"),
        fetch("/samples/photo-c.png"),
        fetch("/samples/song.wav"),
      ]);
      if (![a, b, c, song].every((res) => res.ok)) {
        say("Sample files are missing.");
        return;
      }
      takePhotos([
        new File([await a.blob()], "photo-a.png", { type: "image/png" }),
        new File([await b.blob()], "photo-b.png", { type: "image/png" }),
        new File([await c.blob()], "photo-c.png", { type: "image/png" }),
      ]);
      await takeAudio(new File([await song.blob()], "song.wav", { type: "audio/wav" }));
    } catch (err) {
      say(err instanceof Error ? err.message : "Could not load the sample.");
    }
  }

  async function exportMp4(): Promise<void> {
    if (!job || !cutlist) return;
    const captions: Record<string, string> = {};
    for (const seg of cutlist.segments) captions[seg.id] = seg.caption;
    try {
      exportState = await requestExport(job.id, captions);
      renderExport();
      if (exportState.status === "running") {
        say(`EXPORT · ${Math.round(exportState.progress * 100)}%`);
        pollExport();
      } else if (exportState.status === "done") {
        say(exportState.cached ? "Export ready. Used the cached MP4." : "Export ready.");
      } else if (exportState.status === "failed") {
        say(exportState.error || "Export failed.");
      }
    } catch (err) {
      say(err instanceof Error ? err.message : "Export failed.");
    }
  }

  function pollExport(): void {
    window.clearInterval(exportTimer);
    exportTimer = window.setInterval(() => void refreshExport(), 400);
  }

  async function refreshExport(): Promise<void> {
    if (!job) return;
    try {
      const next = await getExport(job.id);
      exportState = next;
      renderExport();
      if (next.status === "running") {
        say(`EXPORT · ${Math.round(next.progress * 100)}%`);
        return;
      }
      window.clearInterval(exportTimer);
      if (next.status === "done") say("Export ready.");
      else if (next.status === "failed") say(next.error || "Export failed.");
    } catch (err) {
      window.clearInterval(exportTimer);
      say(err instanceof Error ? err.message : "Export failed.");
    }
  }

  function renderExport(): void {
    exportBox.replaceChildren();
    const platesDone = Boolean(job && job.segments.length > 0 && job.segments.every((seg) => seg.status === "done"));
    const rendering = exportState?.status === "running";
    const exportBtn = document.createElement("button");
    exportBtn.type = "button";
    exportBtn.className = "btn solid";
    exportBtn.textContent = rendering ? "Exporting…" : "Export MP4";
    exportBtn.disabled = !platesDone || rendering || !job;
    exportBtn.addEventListener("click", () => void exportMp4());
    exportBox.append(exportBtn);
    if (rendering && exportState) {
      const pct = Math.round(Math.max(0, Math.min(1, exportState.progress)) * 100);
      const meterEl = document.createElement("div");
      meterEl.className = "meter";
      meterEl.setAttribute("role", "progressbar");
      meterEl.setAttribute("aria-valuemin", "0");
      meterEl.setAttribute("aria-valuemax", "100");
      meterEl.setAttribute("aria-valuenow", String(pct));
      const bar = document.createElement("span");
      bar.style.width = `${pct}%`;
      meterEl.append(bar);
      const label = document.createElement("p");
      label.className = "hint";
      label.textContent = `${pct}%`;
      exportBox.append(meterEl, label);
    }
    if (exportState?.status === "done" && exportState.fileUrl) {
      const file = document.createElement("a");
      file.className = "btn line";
      file.href = exportState.fileUrl;
      file.textContent = "Download MP4";
      exportBox.append(file);
    }
    const download = document.createElement("button");
    download.type = "button";
    download.className = "btn line";
    download.textContent = "Download cut list";
    download.disabled = !cutlist;
    download.addEventListener("click", () => {
      if (!cutlist) return;
      const blob = new Blob([JSON.stringify(cutlist, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "dropcut-cutlist.json";
      link.click();
      URL.revokeObjectURL(url);
    });
    exportBox.append(download);
    if (!job) return;
    const serverLink = document.createElement("a");
    serverLink.className = "btn line";
    serverLink.href = `/api/jobs/${job.id}/cutlist.json`;
    serverLink.textContent = "Job cut list";
    exportBox.append(serverLink);
    for (const seg of job.segments) {
      if (!seg.fileUrl) continue;
      const link = document.createElement("a");
      link.href = seg.fileUrl;
      link.download = fileName(seg);
      link.textContent = `File ${seg.id}`;
      exportBox.append(link);
    }
  }

  function pushPlayer(): void {
    if (!cutlist) {
      player.update({ segments: [], beats: [], clipStart: 0, clipEnd: 0 });
      return;
    }
    const segments: PlayerSegment[] = cutlist.segments.map((seg) => {
      const remote = job?.segments.find((item) => item.id === seg.id);
      const photo = photos[seg.photoIndex];
      const useRemote = Boolean(remote?.fileUrl && remote.status === "done");
      return {
        id: seg.id,
        start: seg.start,
        end: seg.end,
        transition: seg.transition,
        caption: seg.caption,
        captionStyle: seg.captionStyle,
        url: useRemote ? remote!.fileUrl! : photo?.url ?? "",
        contentType: useRemote ? remote?.contentType : "image/jpeg",
      };
    });
    player.update({
      segments,
      beats: analysis?.beats ?? [],
      clipStart: cutlist.clipStart,
      clipEnd: cutlist.clipEnd,
    });
  }

  function paintWave(): void {
    drawWaveform(wave, {
      envelope: analysis?.envelope ?? [],
      duration: analysis?.duration ?? 0,
      beats: analysis?.beats ?? [],
      drops: activeDrops(),
      trimStart,
      trimEnd,
      playhead,
    });
  }

  function syncTrim(): void {
    const dur = analysis?.duration ?? 0;
    const on = Boolean(analysis);
    for (const input of [trimIn, trimOut, trimInNum, trimOutNum]) input.disabled = !on;
    trimIn.max = String(dur);
    trimOut.max = String(dur);
    trimInNum.max = String(dur);
    trimOutNum.max = String(dur);
    trimIn.value = String(trimStart);
    trimOut.value = String(trimEnd);
    trimInNum.value = trimStart.toFixed(2);
    trimOutNum.value = trimEnd.toFixed(2);
    windowLabel.textContent = analysis
      ? `${formatSeconds(Math.max(0, trimEnd - trimStart))} window · ${MAX_CLIP_SEC}s max · song ${formatSeconds(dur)}`
      : "Default window is the first 15 seconds. Maximum 30.";
  }

  function syncGenerate(): void {
    const blocked = Boolean(health && health.backend === "comfy-cloud" && !health.workflow.ready);
    const running = job?.status === "running" || job?.status === "queued";
    generateBtn.disabled = busy || blocked || running || !cutlist || !audioFile || photos.length === 0;
  }

  function say(message: string): void {
    if (live.textContent !== message) live.textContent = message;
  }
}

function must<T extends Element>(root: ParentNode, selector: string): T {
  const node = root.querySelector(selector);
  if (!node) throw new Error(`Missing ${selector}`);
  return node as T;
}

function assignLook(seg: CutSegment, lookId: string, baseSeed: number): void {
  const prompt = renderPrompt(lookId);
  seg.look = lookId;
  seg.prompt = prompt.positive;
  seg.negativePrompt = prompt.negative;
  seg.seed = segmentSeed(Math.round(baseSeed), seg.index, lookId, seg.photoIndex);
}

function td(text: string): HTMLTableCellElement {
  const cell = document.createElement("td");
  cell.textContent = text;
  return cell;
}

function choice(name: string, value: string, label: string, checked: boolean, onPick: () => void): HTMLLabelElement {
  const wrap = document.createElement("label");
  wrap.className = "choice";
  const input = document.createElement("input");
  input.type = "radio";
  input.name = name;
  input.value = value;
  input.checked = checked;
  input.addEventListener("change", () => {
    if (input.checked) onPick();
  });
  wrap.append(input, document.createTextNode(label));
  return wrap;
}

function bindDrop(zone: HTMLElement, onFiles: (files: File[]) => void): void {
  zone.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    zone.classList.add("hot");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("hot"));
  zone.addEventListener("drop", (ev) => {
    ev.preventDefault();
    zone.classList.remove("hot");
    onFiles([...(ev.dataTransfer?.files ?? [])]);
  });
}

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(file.name);
}

function isAudioFile(file: File): boolean {
  return file.type.startsWith("audio/") || /\.(mp3|wav|m4a)$/i.test(file.name);
}

function editKey(seg: CutSegment): string {
  return `${seg.index}:${seg.start.toFixed(3)}`;
}

function fileName(seg: { id: string; contentType?: string }): string {
  const type = seg.contentType ?? "";
  if (type.includes("svg")) return `${seg.id}.svg`;
  if (type.includes("png")) return `${seg.id}.png`;
  if (type.includes("mp4")) return `${seg.id}.mp4`;
  if (type.includes("webm")) return `${seg.id}.webm`;
  return `${seg.id}.bin`;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
