import { useEffect, useState } from "react";
import type { AlbumDetailResponse } from "../../../shared/api";
import { api, describeError } from "../api";
import { startFlacDownload } from "../lib/download";
import { formatDuration } from "../lib/format";
import { useNav } from "../nav/NavContext";
import { usePlayer } from "../player/PlayerContext";
import { Cover } from "./Cover";
import { Icon, Spinner } from "./Icons";
import { QualityBadge, TrackListSkeleton, TrackRow } from "./TrackRow";

export function AlbumView({ id, title, artist }: { id: string; title: string; artist: string }) {
  const player = usePlayer();
  const nav = useNav();
  const [downloadingAll, setDownloadingAll] = useState(false);
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; data: AlbumDetailResponse }
    | { kind: "error"; message: string }
  >({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    api
      .album(id, { title, artist }, controller.signal)
      .then((data) => setState({ kind: "ready", data }))
      .catch((err) => {
        if ((err as Error).name === "AbortError") return;
        setState({ kind: "error", message: describeError(err).message });
      });
    return () => controller.abort();
  }, [id, title, artist]);

  const downloadAlbum = async (album: AlbumDetailResponse) => {
    if (downloadingAll) return;
    setDownloadingAll(true);
    try {
      for (const tr of album.tracks) {
        await startFlacDownload(tr);
      }
    } finally {
      setDownloadingAll(false);
    }
  };

  return (
    <section className="panel detail-panel" aria-label={`Album ${title}`}>
      <header className="panel-header">
        <button className="btn btn-small btn-ghost" onClick={nav.back}>
          ← Back
        </button>
        <h2 className="ellipsis">{state.kind === "ready" ? state.data.title : title}</h2>
      </header>

      {state.kind === "loading" ? (
        <div style={{ padding: "8px 10px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
            <Spinner size={18} /> <span className="dim">Loading album…</span>
          </div>
          <TrackListSkeleton rows={8} />
        </div>
      ) : state.kind === "error" ? (
        <div className="empty-state error-state" role="alert">
          <Icon name="error" size={32} className="empty-icon" />
          <h3>Could not load album</h3>
          <p>{state.message}</p>
        </div>
      ) : (
        <>
          <div className="detail-hero">
            <Cover src={state.data.coverUrl} title={state.data.title} size={120} />
            <div className="detail-hero-meta">
              <div className="search-hero-badges">
                <QualityBadge
                  track={{
                    format: state.data.codec.toLowerCase(),
                    lossless: true,
                    bitDepth: state.data.bitDepth,
                    sampleRate: state.data.sampleRate,
                  }}
                />
                {state.data.year ? <span className="pill">{state.data.year}</span> : null}
                <span className="pill">
                  {state.data.trackCount} tracks · {formatDuration(Math.round(state.data.totalDurationMs / 1000))}
                </span>
              </div>
              <h1 className="detail-title">{state.data.title}</h1>
              <button
                type="button"
                className="link-btn"
                style={{ alignSelf: "flex-start" }}
                onClick={() => nav.openArtist({ id: state.data.artistId, name: state.data.artist })}
              >
                {state.data.artist}
              </button>
              <div className="search-hero-actions">
                <button className="btn btn-primary btn-small" onClick={() => player.playList(state.data.tracks)}>
                  <Icon name="play" size={16} /> Play Album
                </button>
                <button className="btn btn-small btn-ghost" onClick={() => player.enqueue(state.data.tracks)}>
                  <Icon name="addQueue" size={16} /> Queue
                </button>
                <button className="btn btn-small btn-save" disabled={downloadingAll} onClick={() => void downloadAlbum(state.data)}>
                  <Icon name="download" size={16} /> {downloadingAll ? "Saving…" : "Download Album (FLAC)"}
                </button>
              </div>
            </div>
          </div>

          <ul className="track-list" aria-label={state.data.title}>
            {state.data.tracks.map((t, i) => (
              <TrackRow key={t.id} track={t} index={t.trackNumber ? t.trackNumber - 1 : i} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
