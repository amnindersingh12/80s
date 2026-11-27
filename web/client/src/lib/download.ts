import { useSyncExternalStore } from "react";
import type { Track } from "../../../shared/api";
import { downloadUrl } from "../api";

export interface DownloadProgress {
  state: "downloading" | "done" | "error";
  pct?: number;
}

const map = new Map<string, DownloadProgress>();
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export async function startFlacDownload(track: Pick<Track, "id" | "artist" | "title" | "format">): Promise<void> {
  if (map.get(track.id)?.state === "downloading") return;
  map.set(track.id, { state: "downloading", pct: 0 });
  emit();

  try {
    const res = await fetch(downloadUrl(track), { credentials: "same-origin" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get("content-length") ?? "0");
    const ext = track.format?.toLowerCase() === "alac" ? "m4a" : "flac";
    const filename = parseFilename(res.headers.get("content-disposition")) ?? `${track.artist} - ${track.title}.${ext}`;

    let blob: Blob;
    if (res.body && total > 0) {
      const reader = res.body.getReader();
      const chunks: BlobPart[] = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(new Uint8Array(value));
          received += value.byteLength;
          map.set(track.id, { state: "downloading", pct: Math.min(99, Math.round((received / total) * 100)) });
          emit();
        }
      }
      blob = new Blob(chunks, { type: res.headers.get("content-type") ?? "audio/flac" });
    } else {
      blob = await res.blob();
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);

    map.set(track.id, { state: "done", pct: 100 });
    emit();
  } catch {
    map.set(track.id, { state: "error" });
    emit();
  }
}

export function useTrackDownloadState(trackId: string): DownloadProgress | undefined {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => map.get(trackId),
  );
}

function parseFilename(cd: string | null): string | undefined {
  if (!cd) return undefined;
  const star = cd.match(/filename\*=UTF-8''([^;]+)/i);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* ignore */
    }
  }
  const quoted = cd.match(/filename="([^"]+)"/i);
  return quoted?.[1];
}
