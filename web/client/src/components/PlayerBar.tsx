import { useEffect, useRef, useState, type CSSProperties } from "react";
import { formatDuration } from "../lib/format";
import { usePlayer, type PlaybackState } from "../player/PlayerContext";
import { upcoming } from "../player/queue";
import { Cover } from "./Cover";
import { Icon, Spinner } from "./Icons";
import { QualityBadge, SaveTrackButton } from "./TrackRow";

/** Human text for the upstream job stage. */
function stageText(p: PlaybackState): string {
  const pr = p.prepare;
  if (!pr) return "Preparing…";
  if (pr.stage === "finding more music") return "Finding more music for your radio…";
  const stage = pr.stage && !["queued", "pending"].includes(pr.stage) ? pr.stage : "queued";
  const pct = pr.progress !== undefined ? ` ${Math.round(pr.progress * 100)}%` : "";
  const secs = pr.elapsedMs !== undefined && pr.elapsedMs > 1500 ? ` · ${Math.round(pr.elapsedMs / 1000)}s` : "";
  return `Preparing lossless stream · ${stage}${pct}${secs}`;
}

export function StatusLine() {
  const { playback, retry, next, queue } = usePlayer();
  if (playback.status === "preparing") {
    return (
      <div className="status-line status-preparing" role="status" aria-live="polite">
        <Spinner size={12} />
        <span className="ellipsis">{stageText(playback)}</span>
        {playback.prepare?.progress !== undefined ? (
          <span className="mini-progress" aria-hidden="true">
            <span style={{ width: `${Math.round(playback.prepare.progress * 100)}%` }} />
          </span>
        ) : null}
      </div>
    );
  }
  if (playback.status === "error" && playback.error) {
    return (
      <div className="status-line status-error" role="alert">
        <Icon name="error" size={14} />
        <span className="ellipsis" title={playback.error.message}>
          {playback.error.message}
        </span>
        {playback.error.retryable ? (
          <button className="link-btn" onClick={retry}>
            Retry
          </button>
        ) : null}
        {upcoming(queue).length ? (
          <button className="link-btn" onClick={next}>
            Skip
          </button>
        ) : null}
      </div>
    );
  }
  if (playback.prepare?.fallback) {
    return (
      <div className="status-line status-fallback" title="The primary media server was unavailable">
        <Icon name="cloud" size={14} /> Streaming from fallback · {playback.prepare.servedBy}
      </div>
    );
  }
  if (playback.status === "buffering") {
    return (
      <div className="status-line" role="status">
        <Spinner size={12} /> Buffering…
      </div>
    );
  }
  return null;
}

/** Seek bar: native range input (keyboard/AT friendly) over a buffered-progress track. */
function Scrubber() {
  const { playback, seek, current } = usePlayer();
  const [drag, setDrag] = useState<number | null>(null);
  const duration = playback.duration || current?.track.durationSec || 0;
  const value = drag ?? playback.currentTime;
  const pct = duration > 0 ? Math.min(100, (value / duration) * 100) : 0;
  const buffered = duration > 0 ? Math.min(100, (playback.bufferedEnd / duration) * 100) : 0;
  const disabled = !current || playback.status === "preparing" || duration === 0;

  return (
    <div className="scrubber">
      <span className="time" aria-hidden="true">
        {formatDuration(value)}
      </span>
      <div className="range-wrap" style={{ "--pct": `${pct}%`, "--buf": `${buffered}%` } as CSSProperties}>
        <input
          type="range"
          className="range"
          min={0}
          max={duration || 1}
          step={0.1}
          value={value}
          disabled={disabled}
          aria-label="Seek"
          aria-valuetext={`${formatDuration(value)} of ${formatDuration(duration)}`}
          onChange={(e) => setDrag(Number(e.target.value))}
          onPointerUp={() => {
            if (drag !== null) seek(drag);
            setDrag(null);
          }}
          onKeyUp={() => {
            if (drag !== null) seek(drag);
            setDrag(null);
          }}
          onBlur={() => setDrag(null)}
        />
      </div>
      <span className="time" aria-hidden="true">
        {formatDuration(duration)}
      </span>
    </div>
  );
}

function Volume() {
  const { playback, setVolume, toggleMute } = usePlayer();
  const level = playback.muted ? 0 : playback.volume;
  return (
    <div className="volume">
      <button className="icon-btn" aria-label={playback.muted ? "Unmute" : "Mute"} title="Mute (M)" onClick={toggleMute}>
        <Icon name={level === 0 ? "mute" : level < 0.5 ? "volumeLow" : "volume"} />
      </button>
      <div className="range-wrap small" style={{ "--pct": `${level * 100}%`, "--buf": "0%" } as CSSProperties}>
        <input
          type="range"
          className="range"
          min={0}
          max={1}
          step={0.01}
          value={level}
          aria-label="Volume"
          aria-valuetext={`${Math.round(level * 100)}%`}
          onChange={(e) => setVolume(Number(e.target.value))}
        />
      </div>
    </div>
  );
}

export function PlayerBar({
  onToggleQueue,
  queueOpen,
  onToggleLyrics,
  lyricsOpen,
}: {
  onToggleQueue: () => void;
  queueOpen: boolean;
  onToggleLyrics: () => void;
  lyricsOpen: boolean;
}) {
  const player = usePlayer();
  const { current, playback, queue } = player;
  const t = current?.track;
  const busy = playback.status === "preparing" || playback.status === "buffering";
  const playing = playback.status === "playing" || playback.status === "buffering";
  const canNext = upcoming(queue).length > 0;
  const announceRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (announceRef.current && t) announceRef.current.textContent = `Now playing ${t.title} by ${t.artist}`;
  }, [t?.id]);

  return (
    <footer className={`player-bar${t ? "" : " is-empty"}`} aria-label="Player">
      <span ref={announceRef} className="sr-only" aria-live="polite" />
      <div className="pb-left">
        {t ? (
          <>
            <Cover src={t.coverUrl} title={t.title} size={56} className="pb-cover" />
            <div className="pb-meta">
              <div className="pb-title ellipsis" title={t.title}>
                {t.title}
              </div>
              <div className="pb-artist ellipsis" title={t.artist}>
                {t.artist}
                {t.album ? <span className="dim"> · {t.album}</span> : null}
              </div>
              <div className="pb-badges">
                <QualityBadge track={t} />
                {queue.radio ? (
                  <span className="pill pill-radio" title={`Radio: ${queue.radio.label}`}>
                    <Icon name="radio" size={12} /> {queue.radio.label}
                  </span>
                ) : null}
              </div>
            </div>
          </>
        ) : (
          <div className="pb-meta">
            <div className="pb-title dim">Nothing playing</div>
            <div className="pb-artist dim">Search or pick a genre to start a radio</div>
          </div>
        )}
      </div>

      <div className="pb-center">
        <div className="pb-controls">
          <button className="icon-btn" aria-label="Previous track" title="Previous (P)" onClick={player.prev} disabled={!t}>
            <Icon name="prev" size={24} />
          </button>
          <button
            className="play-btn"
            aria-label={playing ? "Pause" : "Play"}
            title="Play / pause (Space)"
            onClick={player.toggle}
            disabled={!t && queue.items.length === 0}
          >
            {busy ? <Spinner size={22} /> : <Icon name={playing ? "pause" : "play"} size={28} />}
          </button>
          <button className="icon-btn" aria-label="Next track" title="Next (N)" onClick={player.next} disabled={!canNext}>
            <Icon name="next" size={24} />
          </button>
        </div>
        <Scrubber />
        <StatusLine />
      </div>

      <div className="pb-right">
        <Volume />
        <button
          className={`icon-btn${lyricsOpen ? " is-active" : ""}`}
          aria-label="Lyrics"
          aria-expanded={lyricsOpen}
          title="Synced Lyrics (Y)"
          onClick={onToggleLyrics}
          disabled={!t}
        >
          <Icon name="lyrics" />
        </button>
        {t ? (
          <SaveTrackButton track={t} />
        ) : (
          <button className="icon-btn" disabled aria-label="Download">
            <Icon name="download" />
          </button>
        )}
        <button className={`icon-btn${queueOpen ? " is-active" : ""}`} aria-label="Queue" aria-expanded={queueOpen} aria-controls="queue-drawer" title="Queue (Q)" onClick={onToggleQueue}>
          <Icon name="queue" />
          {upcoming(queue).length ? <span className="count-badge">{Math.min(99, upcoming(queue).length)}</span> : null}
        </button>
      </div>
    </footer>
  );
}
