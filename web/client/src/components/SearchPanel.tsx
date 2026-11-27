import { useEffect, useRef, useState, type ReactNode } from "react";
import type { SearchFilterType, SearchResponse } from "../../../shared/api";
import { api, describeError } from "../api";
import { formatDuration } from "../lib/format";
import { storage } from "../lib/storage";
import { useNav } from "../nav/NavContext";
import { usePlayer } from "../player/PlayerContext";
import { Cover } from "./Cover";
import { Icon, Spinner } from "./Icons";
import { QualityBadge, SaveTrackButton, TrackListSkeleton, TrackRow } from "./TrackRow";

const RECENT_KEY = "80s.recentSearches.v1";

const FILTERS: Array<{ id: SearchFilterType; label: string }> = [
  { id: "all", label: "All" },
  { id: "tracks", label: "Tracks" },
  { id: "artists", label: "Artists" },
  { id: "albums", label: "Albums" },
];

type State =
  | { kind: "empty" }
  | { kind: "loading"; query: string }
  | { kind: "results"; data: SearchResponse }
  | { kind: "error"; query: string; message: string };

/** Debounced, abortable instant search with filter pills, Top Result, Songs, Artists, Albums. */
export function SearchPanel({ query, onQuery }: { query: string; onQuery: (q: string) => void }) {
  const player = usePlayer();
  const nav = useNav();
  const [filter, setFilter] = useState<SearchFilterType>("all");
  const [state, setState] = useState<State>({ kind: "empty" });
  const [recent, setRecent] = useState<string[]>(() => storage.get(RECENT_KEY, []));
  const [attempt, setAttempt] = useState(0);
  const cache = useRef(new Map<string, SearchResponse>());

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setState({ kind: "empty" });
      return;
    }
    const cacheKey = `${filter}:${q.toLowerCase()}`;
    const hit = cache.current.get(cacheKey);
    if (hit) {
      setState({ kind: "results", data: hit });
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setState({ kind: "loading", query: q });
      try {
        const data = await api.search(q, filter, controller.signal);
        cache.current.set(cacheKey, data);
        if (cache.current.size > 60) cache.current.delete(cache.current.keys().next().value as string);
        setState({ kind: "results", data });
        if (data.tracks.length || (data.artists?.length ?? 0) > 0 || (data.albums?.length ?? 0) > 0) {
          setRecent((r) => {
            const next = [q, ...r.filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 8);
            storage.set(RECENT_KEY, next);
            return next;
          });
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setState({ kind: "error", query: q, message: describeError(err).message });
      }
    }, 500);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, filter, attempt]);

  if (state.kind === "empty") {
    return (
      <section className="panel search-panel" aria-label="Search">
        <div className="empty-state">
          <Icon name="search" size={40} className="empty-icon" />
          <h2>Find something lossless</h2>
          <p>Search your media server by track, artist or album. Press <kbd>/</kbd> to jump to the search box.</p>
          {recent.length ? (
            <div className="chip-row" aria-label="Recent searches">
              {recent.map((r) => (
                <button key={r} className="chip" onClick={() => onQuery(r)}>
                  {r}
                </button>
              ))}
              <button
                className="chip chip-ghost"
                onClick={() => {
                  setRecent([]);
                  storage.remove(RECENT_KEY);
                }}
              >
                Clear
              </button>
            </div>
          ) : null}
        </div>
      </section>
    );
  }

  const header = (count?: number, extra?: ReactNode) => (
    <header className="panel-header">
      <h2>
        Results {state.kind !== "error" ? <span className="dim">for “{state.kind === "results" ? state.data.query : state.query}”</span> : null}
      </h2>
      {count !== undefined ? <span className="count">{count}</span> : null}
      {extra}
    </header>
  );

  const filterBar = (
    <div className="chip-row" role="group" aria-label="Filter results">
      {FILTERS.map((f) => (
        <button
          key={f.id}
          type="button"
          className={`chip chip-small${filter === f.id ? " chip-active" : ""}`}
          aria-pressed={filter === f.id}
          onClick={() => setFilter(f.id)}
        >
          {f.label}
        </button>
      ))}
    </div>
  );

  if (state.kind === "loading") {
    return (
      <section className="panel search-panel" aria-label="Search results" aria-busy="true">
        {header(undefined, <Spinner size={16} label="Searching" />)}
        {filterBar}
        <TrackListSkeleton />
      </section>
    );
  }

  if (state.kind === "error") {
    return (
      <section className="panel search-panel" aria-label="Search results">
        {header()}
        {filterBar}
        <div className="empty-state error-state" role="alert">
          <Icon name="error" size={36} className="empty-icon" />
          <h2>Search failed</h2>
          <p>{state.message}</p>
          <button className="btn" onClick={() => setAttempt((a) => a + 1)}>
            <Icon name="retry" size={18} /> Try again
          </button>
        </div>
      </section>
    );
  }

  const { data } = state;
  const artists = data.artists ?? [];
  const albums = data.albums ?? [];
  const visibleTracks = filter === "all" ? data.tracks.slice(0, 5) : data.tracks;
  const totalCount = data.tracks.length + artists.length + albums.length;
  const top = data.topResult ?? (data.tracks[0] ? { kind: "track" as const, item: data.tracks[0] } : undefined);

  return (
    <section className="panel search-panel" aria-label="Search results">
      {header(
        totalCount,
        <div className="panel-header-actions">
          {data.fallback ? <span className="pill pill-warn" title="Primary media server is unavailable">via {data.provider}</span> : null}
          {data.tracks.length > 1 ? (
            <>
              <button className="btn btn-small" onClick={() => player.playList(data.tracks)}>
                <Icon name="play" size={16} /> Play all
              </button>
              <button className="btn btn-small btn-ghost" onClick={() => player.enqueue(data.tracks)}>
                <Icon name="addQueue" size={16} /> Queue all
              </button>
            </>
          ) : null}
        </div>,
      )}
      {filterBar}

      {totalCount === 0 ? (
        <div className="empty-state">
          <Icon name="note" size={36} className="empty-icon" />
          <h2>No matches</h2>
          <p>Nothing on your server matches “{data.query}”. Try fewer words or switch tabs above.</p>
        </div>
      ) : (
        <>
          {filter === "all" && top ? (
            <div className="search-section">
              <h3 className="section-title">Top Result</h3>
              {top.kind === "track" ? (
                <div className="search-hero">
                  <Cover src={top.item.coverUrl} title={top.item.title} size={96} />
                  <div className="search-hero-body">
                    <div className="search-hero-badges">
                      <QualityBadge track={top.item} />
                      {top.item.year ? <span className="pill">{top.item.year}</span> : null}
                      <span className="pill">{formatDuration(top.item.durationSec)}</span>
                    </div>
                    <div className="search-hero-title ellipsis">{top.item.title}</div>
                    <div className="search-hero-sub ellipsis">
                      <button type="button" className="link-inline" onClick={() => nav.openArtist({ id: top.item.artistId, name: top.item.artist })}>
                        {top.item.artist}
                      </button>
                      {top.item.album ? (
                        <>
                          {" · "}
                          <button type="button" className="link-inline" onClick={() => nav.openAlbum({ id: top.item.albumId, title: top.item.album!, artist: top.item.artist })}>
                            {top.item.album}
                          </button>
                        </>
                      ) : null}
                    </div>
                    <div className="search-hero-actions">
                      <button className="btn btn-primary btn-small" onClick={() => player.play(top.item)}>
                        <Icon name="play" size={16} /> Play
                      </button>
                      <button className="btn btn-small btn-ghost" onClick={() => player.enqueue(top.item)}>
                        <Icon name="addQueue" size={16} /> Queue
                      </button>
                      <SaveTrackButton track={top.item} label="Save FLAC" className="btn btn-small btn-save" />
                    </div>
                  </div>
                </div>
              ) : top.kind === "artist" ? (
                <div className="search-hero">
                  <Cover src={top.item.imageUrl} title={top.item.name} size={96} className="round" />
                  <div className="search-hero-body">
                    <span className="pill">Artist</span>
                    <div className="search-hero-title ellipsis">{top.item.name}</div>
                    <div className="search-hero-actions">
                      <button className="btn btn-primary btn-small" onClick={() => nav.openArtist({ id: top.item.id, name: top.item.name })}>
                        View Artist
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="search-hero">
                  <Cover src={top.item.coverUrl} title={top.item.title} size={96} />
                  <div className="search-hero-body">
                    <span className="pill">Album</span>
                    <div className="search-hero-title ellipsis">{top.item.title}</div>
                    <div className="search-hero-sub ellipsis">{top.item.artist}</div>
                    <div className="search-hero-actions">
                      <button className="btn btn-primary btn-small" onClick={() => nav.openAlbum({ id: top.item.id, title: top.item.title, artist: top.item.artist })}>
                        Open Album
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : null}

          {visibleTracks.length > 0 ? (
            <div className="search-section">
              <div className="section-title-row">
                <h3 className="section-title">Songs</h3>
                {filter === "all" && data.tracks.length > 5 ? (
                  <button type="button" className="link-btn" onClick={() => setFilter("tracks")}>
                    See all ({data.tracks.length})
                  </button>
                ) : null}
              </div>
              <ul className="track-list" aria-label={`${visibleTracks.length} tracks`}>
                {visibleTracks.map((t, i) => (
                  <TrackRow key={t.id} track={t} index={i} />
                ))}
              </ul>
            </div>
          ) : null}

          {artists.length > 0 ? (
            <div className="search-section">
              <h3 className="section-title">Artists</h3>
              <div className="h-scroll" role="list">
                {artists.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    role="listitem"
                    className="artist-card"
                    onClick={() => nav.openArtist({ id: a.id, name: a.name })}
                  >
                    <Cover src={a.imageUrl} title={a.name} size={76} className="round" />
                    <span className="artist-card-name ellipsis">{a.name}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {albums.length > 0 ? (
            <div className="search-section">
              <h3 className="section-title">Albums</h3>
              <div className="h-scroll" role="list">
                {albums.map((al) => (
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
                      {al.artist}
                      {al.year ? ` · ${al.year}` : ""}
                    </span>
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
