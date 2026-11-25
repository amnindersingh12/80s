import { useEffect, useRef, useState, type ReactNode } from "react";
import type { SearchResponse } from "../../../shared/api";
import { api, describeError } from "../api";
import { storage } from "../lib/storage";
import { usePlayer } from "../player/PlayerContext";
import { Icon, Spinner } from "./Icons";
import { TrackListSkeleton, TrackRow } from "./TrackRow";

const RECENT_KEY = "80s.recentSearches.v1";

type State =
  | { kind: "empty" }
  | { kind: "loading"; query: string }
  | { kind: "results"; data: SearchResponse }
  | { kind: "error"; query: string; message: string };

/** Debounced, abortable instant search. `query` is owned by the header search box. */
export function SearchPanel({ query, onQuery }: { query: string; onQuery: (q: string) => void }) {
  const player = usePlayer();
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
    const hit = cache.current.get(q.toLowerCase());
    if (hit) {
      setState({ kind: "results", data: hit });
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setState({ kind: "loading", query: q });
      try {
        const data = await api.search(q, controller.signal);
        cache.current.set(q.toLowerCase(), data);
        if (cache.current.size > 50) cache.current.delete(cache.current.keys().next().value as string);
        setState({ kind: "results", data });
        if (data.tracks.length) {
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
    }, 250);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, attempt]);

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

  if (state.kind === "loading") {
    return (
      <section className="panel search-panel" aria-label="Search results" aria-busy="true">
        {header(undefined, <Spinner size={16} label="Searching" />)}
        <TrackListSkeleton />
      </section>
    );
  }

  if (state.kind === "error") {
    return (
      <section className="panel search-panel" aria-label="Search results">
        {header()}
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
  return (
    <section className="panel search-panel" aria-label="Search results">
      {header(
        data.tracks.length,
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
      {data.tracks.length === 0 ? (
        <div className="empty-state">
          <Icon name="note" size={36} className="empty-icon" />
          <h2>No matches</h2>
          <p>Nothing on your server matches “{data.query}”. Try fewer words or just the artist.</p>
        </div>
      ) : (
        <ul className="track-list" aria-label={`${data.tracks.length} tracks`}>
          {data.tracks.map((t) => (
            <TrackRow key={t.id} track={t} />
          ))}
        </ul>
      )}
    </section>
  );
}
