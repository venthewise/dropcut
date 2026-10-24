import { sha256 } from "../jobs/store";

/**
 * Bump when the filter graph, caption layout, or encoder settings change so
 * an old MP4 is not reused after the assembly changes.
 */
export const EXPORT_GRAPH_VERSION = 1;

export interface ExportKeyRow {
  id: string;
  start: number;
  end: number;
  caption: string;
  captionStyle: string;
  transition: string;
}

export interface ExportKeyInput {
  segmentCacheKeys: string[];
  rows: ExportKeyRow[];
  songSha256: string;
  fps: number;
  width: number;
  height: number;
  endCardUrl: string;
  endCardSeconds: number;
  fadeSeconds: number;
}

/** Same inputs always hash the same. Any caption, timing, plate, song, or setting change misses. */
export function exportCacheKey(input: ExportKeyInput): string {
  return sha256(Buffer.from(JSON.stringify({ version: EXPORT_GRAPH_VERSION, ...input })));
}
