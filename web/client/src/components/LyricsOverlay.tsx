import { useEffect, useMemo, useRef, useState } from "react";
import type { LyricsResponse } from "../../../shared/api";
import { api, describeError } from "../api";
import { activeLrcIndex, parseLrc } from "../lib/lrc";
import { usePlayer } from "../player/PlayerContext";
import { Cover } from "./Cover";
import { Icon, Spinner } from "./Icons";
import { QualityBadge } from "./TrackRow";

const lyricsCache = new Map<string, LyricsResponse>();

export function LyricsOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const player = usePlayer();
  const track = player.current?.track;
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ready"; data: LyricsResponse }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [manualScroll, setManualScroll] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  const resumeTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!open || !track) return;
    const hit = lyricsCache.get(track.id);
    if (hit) {
      setState({ kind: "ready", data: hit });
      return;
    }
    const controller = new AbortController();
    setState({ kind: "loading" });
    api
      .lyrics(
        { track: track.title, artist: track.artist, album: track.album, duration: track.durationSec },
        controller.signal,
      )
      .then((data) => {
        lyricsCache.set(track.id, data);
        if (lyricsCache.size > 60) lyricsCache.delete(lyricsCache.keys().next().value as string);
        setState({ kind: "ready", data });
      })
      .catch((err) => {
        if ((err as Error).name === "AbortError") return;
        setState({ kind: "error", message: describeError(err).message });
      });
    return () => controller.abort();
  }, [open, track?.id]);

  const syncedLines = useMemo(
    () => (state.kind === "ready" ? parseLrc(state.data.syncedLyrics) : []),
    [state],
  );
  const activeIdx = useMemo(
    () => activeLrcIndex(syncedLines, player.playback.currentTime),
    [syncedLines, player.playback.currentTime],
  );

  useEffect(() => {
    setManualScroll(false);
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [track?.id, open]);

  useEffect(() => {
    if (!open || manualScroll || activeIdx < 0) return;
    activeRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [open, manualScroll, activeIdx]);

  useEffect(() => {
    return () => {
      if (resumeTimer.current) window.clearTimeout(resumeTimer.current);
    };
  }, []);

  if (!open || !track) return null;

  const markManualScroll = () => {
    setManualScroll(true);
    if (resumeTimer.current) window.clearTimeout(resumeTimer.current);
    resumeTimer.current = window.setTimeout(() => setManualScroll(false), 4000);
  };

  const resync = () => {
    if (resumeTimer.current) window.clearTimeout(resumeTimer.current);
    setManualScroll(false);
    activeRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const playing = player.playback.status === "playing" || player.playback.status === "buffering";

  return (
    <div className="lyrics-overlay" role="dialog" aria-modal="true" aria-label={`Lyrics for ${track.title}`}>
      {track.coverUrl ? (
        <div className="lyrics-backdrop" style={{ backgroundImage: `url(${track.coverUrl})` }} aria-hidden="true" />
      ) : null}
      <div className="lyrics-scrim" aria-hidden="true" />

      <div className="lyrics-shell">
        <header className="lyrics-head">
          <div className="lyrics-track">
            <Cover src={track.coverUrl} title={track.title} size={52} />
            <div className="lyrics-meta">
              <div className="lyrics-title ellipsis">{track.title}</div>
              <div className="lyrics-artist ellipsis">
                {track.artist}
                {track.album ? ` · ${track.album}` : ""}
              </div>
            </div>
          </div>
          <div className="lyrics-head-actions">
            <QualityBadge track={track} compact />
            {state.kind === "ready" && state.data.syncedLyrics ? (
              <span className="pill pill-radio">Synced</span>
            ) : null}
            <button className="icon-btn" aria-label="Close lyrics" title="Close (Esc)" onClick={onClose}>
              <Icon name="close" size={20} />
            </button>
          </div>
        </header>

        <div
          ref={listRef}
          className="lyrics-body"
          onWheel={markManualScroll}
          onTouchStart={markManualScroll}
        >
          {state.kind === "loading" ? (
            <div className="lyrics-empty">
              <Spinner size={28} label="Fetching lyrics" />
              <p>Looking up synced lyrics…</p>
            </div>
          ) : state.kind === "error" ? (
            <div className="lyrics-empty">
              <Icon name="error" size={32} />
              <p>{state.message}</p>
            </div>
          ) : state.kind === "ready" && syncedLines.length > 0 ? (
            <div className="lyrics-lines">
              {syncedLines.map((line, i) => {
                const active = i === activeIdx;
                const past = activeIdx >= 0 && i < activeIdx;
                return (
                  <button
                    key={`${line.timeSec}-${i}`}
                    ref={active ? activeRef : undefined}
                    type="button"
                    className={`lyrics-line${active ? " is-active" : ""}${past ? " is-past" : ""}`}
                    onClick={() => {
                      setManualScroll(false);
                      player.seek(line.timeSec);
                    }}
                  >
                    {line.text}
                  </button>
                );
              })}
            </div>
          ) : state.kind === "ready" && state.data.plainLyrics ? (
            <div className="lyrics-plain">
              {state.data.plainLyrics.split(/\n{2,}/).map((para, idx) => (
                <p key={idx}>{para}</p>
              ))}
            </div>
          ) : state.kind === "ready" && state.data.instrumental ? (
            <div className="lyrics-empty">
              <Icon name="note" size={36} />
              <p>Instrumental track — no lyrics</p>
            </div>
          ) : (
            <div className="lyrics-empty">
              <Icon name="lyrics" size={36} />
              <p>No lyrics available for this track yet.</p>
            </div>
          )}
        </div>

        <footer className="lyrics-foot">
          <div className="pb-controls">
            <button className="icon-btn" aria-label="Previous track" onClick={player.prev}>
              <Icon name="prev" size={22} />
            </button>
            <button className="play-btn" aria-label={playing ? "Pause" : "Play"} onClick={player.toggle}>
              <Icon name={playing ? "pause" : "play"} size={24} />
            </button>
            <button className="icon-btn" aria-label="Next track" onClick={player.next}>
              <Icon name="next" size={22} />
            </button>
          </div>
          {manualScroll && syncedLines.length > 0 ? (
            <button className="btn btn-small" onClick={resync}>
              Sync
            </button>
          ) : null}
        </footer>
      </div>
    </div>
  );
}
