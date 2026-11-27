import { useEffect, useState } from "react";
import type { ArtistDetailResponse } from "../../../shared/api";
import { api, describeError } from "../api";
import { useNav } from "../nav/NavContext";
import { usePlayer } from "../player/PlayerContext";
import { Cover } from "./Cover";
import { Icon, Spinner } from "./Icons";
import { TrackListSkeleton, TrackRow } from "./TrackRow";

export function ArtistView({ id, name }: { id: string; name: string }) {
  const player = usePlayer();
  const nav = useNav();
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; data: ArtistDetailResponse }
    | { kind: "error"; message: string }
  >({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    api
      .artist(id, name, controller.signal)
      .then((data) => setState({ kind: "ready", data }))
      .catch((err) => {
        if ((err as Error).name === "AbortError") return;
        setState({ kind: "error", message: describeError(err).message });
      });
    return () => controller.abort();
  }, [id, name]);

  return (
    <section className="panel detail-panel" aria-label={`Artist ${name}`}>
      <header className="panel-header">
        <button className="btn btn-small btn-ghost" onClick={nav.back}>
          ← Back
        </button>
        <h2 className="ellipsis">{state.kind === "ready" ? state.data.name : name}</h2>
      </header>

      {state.kind === "loading" ? (
        <div style={{ padding: "8px 10px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
            <Spinner size={18} /> <span className="dim">Loading artist…</span>
          </div>
          <TrackListSkeleton rows={6} />
        </div>
      ) : state.kind === "error" ? (
        <div className="empty-state error-state" role="alert">
          <Icon name="error" size={32} className="empty-icon" />
          <h3>Could not load artist</h3>
          <p>{state.message}</p>
        </div>
      ) : (
        <>
          <div className="detail-hero">
            <Cover src={state.data.imageUrl} title={state.data.name} size={112} className="round" />
            <div className="detail-hero-meta">
              <h1 className="detail-title">{state.data.name}</h1>
              {state.data.genres.length ? (
                <div className="chip-row" style={{ padding: 0 }}>
                  {state.data.genres.slice(0, 5).map((g) => (
                    <span key={g} className="pill">
                      {g}
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="search-hero-actions">
                {state.data.topTracks.length ? (
                  <button className="btn btn-primary btn-small" onClick={() => player.playList(state.data.topTracks)}>
                    <Icon name="play" size={16} /> Play Top Tracks
                  </button>
                ) : null}
                <button
                  className="btn btn-small"
                  onClick={() => void player.startRadio({ type: "artist", artist: state.data.name }, `${state.data.name} Radio`)}
                >
                  <Icon name="radio" size={16} /> Artist Radio
                </button>
              </div>
            </div>
          </div>

          {state.data.topTracks.length ? (
            <div className="search-section">
              <h3 className="section-title">Popular Tracks</h3>
              <ul className="track-list">
                {state.data.topTracks.map((t, i) => (
                  <TrackRow key={t.id} track={t} index={i} />
                ))}
              </ul>
            </div>
          ) : null}

          {state.data.albums.length ? (
            <div className="search-section">
              <h3 className="section-title">Albums</h3>
              <div className="h-scroll" role="list">
                {state.data.albums.map((al) => (
                  <button
                    key={al.id}
                    type="button"
                    role="listitem"
                    className="album-card"
                    onClick={() => nav.openAlbum({ id: al.id, title: al.title, artist: al.artist })}
                  >
                    <Cover src={al.coverUrl} title={al.title} size={112} />
                    <span className="album-card-title ellipsis">{al.title}</span>
                    <span className="album-card-sub ellipsis">
                      {al.year ?? al.artist}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {state.data.similarArtists.length ? (
            <div className="search-section">
              <h3 className="section-title">Similar Artists</h3>
              <div className="h-scroll" role="list">
                {state.data.similarArtists.map((a) => (
                  <button
                    key={a.name}
                    type="button"
                    role="listitem"
                    className="artist-card"
                    onClick={() => nav.openArtist({ name: a.name })}
                  >
                    <Cover src={a.imageUrl} title={a.name} size={76} className="round" />
                    <span className="artist-card-name ellipsis">{a.name}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
