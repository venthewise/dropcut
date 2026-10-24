import type { ExportResponse, HealthResponse, JobResponse } from "../shared/api-types";

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) return body.error;
  } catch {
    // The body was not JSON.
  }
  return `Request failed (${res.status}).`;
}

export async function getHealth(): Promise<HealthResponse> {
  const res = await fetch("/api/health");
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as HealthResponse;
}

export async function createJob(cutlist: unknown, photos: File[], audio: File): Promise<JobResponse> {
  const form = new FormData();
  form.append("cutlist", JSON.stringify(cutlist));
  for (const photo of photos) form.append("photos", photo, photo.name);
  form.append("audio", audio, audio.name);
  const res = await fetch("/api/jobs", { method: "POST", body: form });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as JobResponse;
}

export async function getJob(id: string): Promise<JobResponse> {
  const res = await fetch(`/api/jobs/${id}`);
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as JobResponse;
}

export async function retryJob(id: string, segmentIds?: string[]): Promise<JobResponse> {
  const res = await fetch(`/api/jobs/${id}/retry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(segmentIds ? { segmentIds } : {}),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as JobResponse;
}

export async function startExport(id: string, captions?: Record<string, string>): Promise<ExportResponse> {
  const res = await fetch(`/api/jobs/${id}/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(captions ? { captions } : {}),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as ExportResponse;
}

export async function getExport(id: string): Promise<ExportResponse> {
  const res = await fetch(`/api/jobs/${id}/export`);
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as ExportResponse;
}

export async function cancelJob(id: string): Promise<JobResponse> {
  const res = await fetch(`/api/jobs/${id}/cancel`, { method: "POST" });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as JobResponse;
}

/** SSE while the connection holds, then polling. Stops on a terminal job. */
export function watchJob(id: string, onJob: (job: JobResponse) => void, onError: (message: string) => void): () => void {
  let stopped = false;
  let es: EventSource | null = null;
  let timer = 0;
  const stop = () => {
    stopped = true;
    es?.close();
    window.clearTimeout(timer);
  };
  const poll = async () => {
    if (stopped) return;
    try {
      const job = await getJob(id);
      if (stopped) return;
      onJob(job);
      if (job.status === "done" || job.status === "failed") {
        stop();
        return;
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : "Lost the job.");
      return;
    }
    timer = window.setTimeout(() => void poll(), 500);
  };
  if (typeof EventSource !== "undefined") {
    es = new EventSource(`/api/jobs/${id}/events`);
    es.onmessage = (ev) => {
      if (stopped) return;
      try {
        const job = JSON.parse(ev.data) as JobResponse;
        onJob(job);
        if (job.status === "done" || job.status === "failed") stop();
      } catch {
        onError("Progress update was unreadable.");
      }
    };
    es.onerror = () => {
      es?.close();
      es = null;
      if (!stopped) void poll();
    };
  } else {
    void poll();
  }
  return stop;
}
