import type { Transition } from "../shared/looks";
import { formatTimecode } from "../shared/timecode";
import { prefersReduced } from "./motion";

export interface PlayerSegment {
  id: string;
  start: number;
  end: number;
  transition: Transition;
  caption: string;
  captionStyle: string;
  url: string;
  contentType?: string;
}

export interface PlayerInput {
  segments: PlayerSegment[];
  beats: number[];
  clipStart: number;
  clipEnd: number;
}

export interface PlayerHandle {
  update(input: PlayerInput): void;
  setCaption(id: string, caption: string): void;
  onTime(cb: (time: number) => void): void;
  destroy(): void;
}

export function attachPlayer(opts: {
  frame: HTMLElement;
  audio: HTMLAudioElement;
  playButton: HTMLButtonElement;
  scrub: HTMLInputElement;
  readOut: HTMLElement;
}): PlayerHandle {
  const { frame, audio, playButton, scrub, readOut } = opts;
  const img = document.createElement("img");
  img.alt = "";
  img.className = "reel-media";
  const video = document.createElement("video");
  video.className = "reel-media";
  video.muted = true;
  video.playsInline = true;
  video.hidden = true;
  const flash = document.createElement("div");
  flash.className = "reel-flash";
  flash.setAttribute("aria-hidden", "true");
  const caption = document.createElement("div");
  caption.className = "reel-caption cap-block";
  frame.replaceChildren(img, video, flash, caption);

  let segments: PlayerSegment[] = [];
  let beats: number[] = [];
  let clipStart = 0;
  let clipEnd = 0;
  let lastId = "";
  let raf = 0;
  let timeCb: (time: number) => void = () => undefined;
  const flashTimes: number[] = [];
  const ac = new AbortController();
  const listen = { signal: ac.signal };

  function segmentAt(time: number): PlayerSegment | undefined {
    return segments.find((seg) => time >= seg.start && time < seg.end) ?? (time >= clipEnd ? segments[segments.length - 1] : segments[0]);
  }

  function canFlash(now: number): boolean {
    if (prefersReduced()) return false;
    while (flashTimes.length > 0 && now - flashTimes[0]! > 1000) flashTimes.shift();
    if (flashTimes.length >= 3) return false;
    flashTimes.push(now);
    return true;
  }

  function show(seg: PlayerSegment, allowMotion: boolean): void {
    const changed = seg.id !== lastId;
    lastId = seg.id;
    const videoLike = (seg.contentType ?? "").startsWith("video/");
    if (videoLike && seg.url) {
      if (video.dataset.src !== seg.url) {
        video.dataset.src = seg.url;
        video.src = seg.url;
      }
      const local = Math.max(0, audio.currentTime - seg.start);
      if (Math.abs(video.currentTime - local) > 0.2) video.currentTime = local;
      video.hidden = false;
      img.hidden = true;
      if (!audio.paused) void video.play().catch(() => undefined);
    } else {
      video.pause();
      video.hidden = true;
      img.hidden = !seg.url;
      if (seg.url && img.getAttribute("src") !== seg.url) {
        img.src = seg.url;
        img.alt = `${seg.caption} plate`;
      }
    }
    caption.textContent = seg.caption;
    caption.className = `reel-caption cap-${seg.captionStyle}`;
    if (!changed || !allowMotion) return;
    frame.classList.remove("is-flash", "is-whip");
    if (prefersReduced() || seg.transition === "hard") return;
    if (seg.transition === "flash") {
      if (!canFlash(performance.now())) return;
      frame.classList.add("is-flash");
      window.setTimeout(() => frame.classList.remove("is-flash"), 80);
      return;
    }
    frame.classList.add("is-whip");
    window.setTimeout(() => frame.classList.remove("is-whip"), 160);
  }

  function render(allowMotion: boolean): void {
    const time = Number.isFinite(audio.currentTime) ? audio.currentTime : clipStart;
    const seg = segmentAt(time);
    if (seg) show(seg, allowMotion);
    const onBeat = beats.some((beat) => time >= beat && time - beat < 0.09);
    caption.classList.toggle("on-kick", onBeat);
    readOut.textContent = formatTimecode(time);
    if (document.activeElement !== scrub && clipEnd > clipStart) {
      scrub.value = String(Math.min(clipEnd, Math.max(clipStart, time)));
    }
    timeCb(time);
    if (!audio.paused && time >= clipEnd - 0.02) {
      audio.pause();
      video.pause();
      playButton.textContent = "Play";
      playButton.setAttribute("aria-pressed", "false");
    }
  }

  function loop(): void {
    render(true);
    if (!audio.paused) raf = window.requestAnimationFrame(loop);
  }

  function play(): void {
    if (!audio.src || segments.length === 0) return;
    if (audio.currentTime < clipStart || audio.currentTime >= clipEnd - 0.02) audio.currentTime = clipStart;
    void audio.play().then(() => {
      playButton.textContent = "Pause";
      playButton.setAttribute("aria-pressed", "true");
      loop();
    }).catch(() => {
      playButton.textContent = "Play";
    });
  }

  function pause(): void {
    audio.pause();
    video.pause();
    window.cancelAnimationFrame(raf);
    playButton.textContent = "Play";
    playButton.setAttribute("aria-pressed", "false");
    render(false);
  }

  playButton.addEventListener("click", () => {
    if (audio.paused) play();
    else pause();
  }, listen);

  scrub.addEventListener("input", () => {
    const next = Number(scrub.value);
    if (!Number.isFinite(next)) return;
    audio.currentTime = next;
    render(false);
  }, listen);

  audio.addEventListener("pause", () => {
    video.pause();
    playButton.textContent = "Play";
    playButton.setAttribute("aria-pressed", "false");
  }, listen);

  audio.addEventListener("ended", () => pause(), listen);

  return {
    update(input) {
      segments = input.segments;
      beats = input.beats;
      clipStart = input.clipStart;
      clipEnd = input.clipEnd;
      scrub.min = String(clipStart);
      scrub.max = String(Math.max(clipStart + 0.01, clipEnd));
      scrub.disabled = segments.length === 0;
      playButton.disabled = segments.length === 0 || !audio.src;
      if (audio.currentTime < clipStart || audio.currentTime > clipEnd) {
        try {
          audio.currentTime = clipStart;
        } catch {
          // The media element is not ready yet.
        }
      }
      lastId = "";
      render(false);
    },
    setCaption(id, text) {
      const seg = segments.find((item) => item.id === id);
      if (!seg) return;
      seg.caption = text;
      if (lastId === id) caption.textContent = text;
    },
    onTime(cb) {
      timeCb = cb;
    },
    destroy() {
      window.cancelAnimationFrame(raf);
      ac.abort();
    },
  };
}
