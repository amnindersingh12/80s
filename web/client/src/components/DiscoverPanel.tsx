import { useEffect, useMemo, useRef, useState } from "react";
import type { HomeResponse, RecommendationSeed, RecommendationSource, RecommendedTrack } from "../../../shared/api";
import { api, describeError } from "../api";
import { formatDuration } from "../lib/format";
import { storage } from "../lib/storage";
import { useNav } from "../nav/NavContext";
import { usePlayer } from "../player/PlayerContext";
import type { QueueTrack } from "../player/queue";
import { Cover } from "./Cover";
import { Icon, Spinner } from "./Icons";
import { QualityBadge, SaveTrackButton, TrackListSkeleton, TrackRow } from "./TrackRow";

export const GENRES = [
  "Mixed",
  "Pop",
  "Hip-Hop",
  "Rock",
  "Indie",
  "Electronic",
  "R&B",
  "Jazz",
  "Punjabi Pop",
  "Bollywood",
  "Synthwave",
  "80s",
  "Lo-fi",
];

const SOURCE_LABEL: Record<RecommendationSource, string> = { lastfm: "Last.fm", listenbrainz: "ListenBrainz", musicbrainz: "MusicBrainz" };
const SEED_KEY = "80s.discoverSeed.v1";

type Load =
  | { kind: "idle" }
  | { kind: "loading"; key: string }
  | { kind: "ready"; key: string; data: HomeResponse }
  | { kind: "error"; key: string; message: string };

function seedKey(s: RecommendationSeed): string {
  return [s.type, s.trackId ?? "", s.artist ?? "", s.title ?? "", s.tag ?? ""].join("|").toLowerCase();
}

function toQueueTrack(r: RecommendedTrack): QueueTrack | undefined {
  if (!r.track) return undefined;
  return { ...r.track, key: r.key, ...(r.reason ? { reason: r.reason } : {}) };
}

export function DiscoverPanel({ onSearch }: { onSearch: (q: string) => void }) {
  const player = usePlayer();
  const nav = useNav();
  const current = player.current?.track;
  const [follow, setFollow] = useState(() => storage.get(`${SEED_KEY}.follow`, true));
  const [manual, setManual] = useState<RecommendationSeed>(() => storage.get(SEED_KEY, { type: "tag", tag: "mixed" }));
  const [load, setLoad] = useState<Load>({ kind: "idle" });
  const [attempt, setAttempt] = useState(0);
  const cache = useRef(new Map<string, HomeResponse>());

  const seed: RecommendationSeed = useMemo(
    () => (follow && current ? { type: "track", trackId: current.id, artist: current.artist, title: current.title } : manual),
    // Keyed on the track id: artist/title never change for a given id.
    [follow, current?.id, manual],
  );
  const key = `${seedKey(seed)}|${current?.id ?? ""}`;

  useEffect(() => {
    storage.set(SEED_KEY, manual);
  }, [manual]);
  useEffect(() => {
    storage.set(`${SEED_KEY}.follow`, follow);
  }, [follow]);

  useEffect(() => {
    const hit = cache.current.get(key);
    if (hit) {
      setLoad({ kind: "ready", key, data: hit });
      return;
    }
    const controller = new AbortController();
    // Debounce so skipping through tracks doesn't fire a burst of lookups.
    const timer = window.setTimeout(async () => {
      setLoad({ kind: "loading", key });
      try {
        const data =
          seed.type === "tag"
            ? await api.home(
                {
                  genre: seed.tag ?? "mixed",
                  ...(current ? { nowPlayingArtist: current.artist, nowPlayingTrack: current.title } : {}),
                  limit: 24,
                },
                controller.signal,
              )
            : ({
                genre: seed.tag ?? "mixed",
                ...(await api.recommendations(seed, controller.signal)),
              } satisfies HomeResponse);
        cache.current.set(key, data);
        setLoad({ kind: "ready", key, data });
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setLoad({ kind: "error", key, message: describeError(err).message });
      }
    }, follow && current ? 600 : 150);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [key, attempt]); // `seed` is fully described by `key`

  const pickTag = (tag: string) => {
    setFollow(false);
    setManual({ type: "tag", tag: tag.toLowerCase() });
  };

  const data = load.kind === "ready" ? load.data : undefined;
  const playable = (data?.relatedTracks ?? []).map(toQueueTrack).filter((t): t is QueueTrack => Boolean(t));
  const activeTag = seed.type === "tag" ? seed.tag : undefined;

  return (
    <section className="panel discover-panel" aria-label="Discover and radio">
      <header className="panel-header">
        <h2>
          <Icon name="sparkle" size={18} /> Discover
        </h2>
        <label className="switch" title="Base recommendations on the track that is playing">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} disabled={!current} />
          <span className="switch-track" aria-hidden="true" />
          <span className="switch-label">Follow now playing</span>
        </label>
      </header>

      <div className="chip-row genre-row" role="group" aria-label="Genres and scenes">
        {GENRES.map((g) => (
          <button key={g} className={`chip${activeTag === g.toLowerCase() ? " chip-active" : ""}`} aria-pressed={activeTag === g.toLowerCase()} onClick={() => pickTag(g)}>
            {g}
          </button>
        ))}
      </div>

      <div className="seed-card">
        <div className="seed-text">
          <span className="eyebrow">{seed.type === "track" ? "Because you're playing" : seed.type === "artist" ? "Artist radio" : "Genre radio"}</span>
          <strong className="ellipsis">{data?.seed.label ?? (seed.type === "track" ? `${seed.title} — ${seed.artist}` : seed.type === "artist" ? seed.artist : seed.tag)}</strong>
        </div>
        <button className="btn" onClick={() => void player.startRadio(seed, data?.seed.label)} disabled={load.kind === "loading"}>
          <Icon name="radio" size={18} /> Start radio
        </button>
      </div>

      {load.kind === "loading" || load.kind === "idle" ? (
        <div aria-busy="true">
          <div className="artist-strip">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="artist-chip skeleton-chip">
                <div className="skeleton" style={{ width: 52, height: 52, borderRadius: "50%" }} />
                <div className="skeleton" style={{ width: 56, height: 10, marginTop: 8 }} />
              </div>
            ))}
          </div>
          <TrackListSkeleton rows={5} />
        </div>
      ) : null}

      {load.kind === "error" ? (
        <div className="empty-state error-state" role="alert">
          <Icon name="error" size={32} className="empty-icon" />
          <h3>Recommendations unavailable</h3>
          <p>{load.message}</p>
          <button className="btn" onClick={() => setAttempt((a) => a + 1)}>
            <Icon name="retry" size={18} /> Retry
          </button>
        </div>
      ) : null}

      {data ? (
        <>
          {data.featuredTrack ? (
            <div className="search-hero" style={{ margin: "10px 6px 14px" }}>
              <Cover src={data.featuredTrack.coverUrl} title={data.featuredTrack.title} size={90} />
              <div className="search-hero-body">
                <div className="search-hero-badges">
                  <QualityBadge track={data.featuredTrack} />
                  <span className="pill">Featured</span>
                </div>
                <div className="search-hero-title ellipsis">{data.featuredTrack.title}</div>
                <div className="search-hero-sub ellipsis">{data.featuredTrack.artist}</div>
                <div className="search-hero-actions">
                  <button className="btn btn-primary btn-small" onClick={() => player.play(data.featuredTrack!)}>
                    <Icon name="play" size={16} /> Play
                  </button>
                  <SaveTrackButton track={data.featuredTrack} label="Save" className="btn btn-small btn-save" />
                </div>
              </div>
            </div>
          ) : null}

          {data.albums && data.albums.length > 0 ? (
            <section aria-label="Recommended albums" className="search-section">
              <h3 className="section-title">Recommended albums</h3>
              <div className="h-scroll" role="list">
                {data.albums.map((al) => (
                  <button
                    key={al.id}
                    type="button"
                    role="listitem"
                    className="album-card"
                    onClick={() => nav.openAlbum({ id: al.id, title: al.title, artist: al.artist })}
                  >
                    <Cover src={al.coverUrl} title={al.title} size={108} />
                    <span className="album-card-title ellipsis">{al.title}</span>
                    <span className="album-card-sub ellipsis">{al.artist}</span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {data.similarArtists.length ? (
            <section aria-label="Similar artists">
              <h3 className="section-title">Artists to explore</h3>
              <ul className="artist-strip">
                {data.similarArtists.map((a) => (
                  <li key={a.name}>
                    <button className="artist-chip" onClick={() => nav.openArtist({ name: a.name })} title={a.playable ? `${a.name} — in your library` : `${a.name} — explore`}>
                      <span className="artist-avatar">
                        <Cover src={a.imageUrl} title={a.name} size={52} className="round" />
                        {a.playable ? <span className="dot-playable" aria-label="playable" /> : null}
                      </span>
                      <span className="artist-name ellipsis">{a.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section aria-label="Related tracks">
            <div className="section-title-row">
              <h3 className="section-title">
                Related tracks <span className="dim">{playable.length}/{data.relatedTracks.length} playable</span>
              </h3>
              {playable.length > 1 ? (
                <button className="btn btn-small btn-ghost" onClick={() => player.enqueue(playable)}>
                  <Icon name="addQueue" size={16} /> Queue playable
                </button>
              ) : null}
            </div>
            {data.relatedTracks.length === 0 ? (
              <div className="empty-state compact">
                <p>No related tracks yet for this seed. Try a genre chip above.</p>
              </div>
            ) : (
              <ul className="track-list">
                {data.relatedTracks.map((r) => {
                  const qt = toQueueTrack(r);
                  return qt ? (
                    <TrackRow key={r.key} track={qt} />
                  ) : (
                    <li key={r.key} className="track-row metadata-only">
                      <Cover src={r.coverUrl} title={r.title} size={44} />
                      <div className="track-main">
                        <div className="track-title ellipsis">{r.title}</div>
                        <div className="track-sub ellipsis">
                          {r.artist}
                          {r.album ? <span className="dim"> · {r.album}</span> : null}
                        </div>
                      </div>
                      <span className="badge badge-meta" title="Found by metadata services but not on your media server">
                        Not in library
                      </span>
                      <span className="track-duration">{formatDuration(r.durationSec)}</span>
                      <div className="track-actions">
                        <button className="icon-btn" aria-label={`Search for ${r.title}`} title="Search your server" onClick={() => onSearch(`${r.artist} ${r.title}`)}>
                          <Icon name="search" />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {data.tags.length ? (
            <section aria-label="Related tags">
              <h3 className="section-title">Tags</h3>
              <div className="chip-row">
                {data.tags.map((t) => (
                  <button key={t} className="chip chip-small" onClick={() => pickTag(t)}>
                    #{t}
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          <footer className="sources">
            {(Object.keys(data.sources) as RecommendationSource[]).map((s) => (
              <span key={s} className={`source source-${data.sources[s]}`} title={data.sources[s]}>
                {data.sources[s] === "ok" ? <Icon name="check" size={14} /> : data.sources[s] === "error" ? <Icon name="error" size={14} /> : null}
                {SOURCE_LABEL[s]}
              </span>
            ))}
            {data.warnings.map((w) => (
              <p key={w} className="warning">
                {w}
              </p>
            ))}
          </footer>
        </>
      ) : null}
      {load.kind === "ready" && player.queue.radio?.loading ? (
        <p className="dim small">
          <Spinner size={12} /> Topping up radio…
        </p>
      ) : null}
    </section>
  );
}
