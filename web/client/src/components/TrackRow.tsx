import type { KeyboardEvent, ReactNode } from "react";
import type { Track } from "../../../shared/api";
import { downloadUrl } from "../api";
import { formatDuration, isHiRes, qualityLabel } from "../lib/format";
import { usePlayer } from "../player/PlayerContext";
import type { QueueTrack } from "../player/queue";
import { Cover } from "./Cover";
import { Icon } from "./Icons";
import { TrackMenu, type MenuAction } from "./TrackMenu";

export function QualityBadge({ track, compact = false }: { track: Pick<Track, "format" | "lossless" | "bitDepth" | "sampleRate" | "bitrateKbps">; compact?: boolean }) {
  if (!track.lossless) return <span className="badge badge-lossy">{compact ? (track.format ?? "lossy").toUpperCase() : qualityLabel(track)}</span>;
  return (
    <span className={`badge badge-lossless${isHiRes(track) ? " badge-hires" : ""}`} title="Lossless">
      {compact ? (isHiRes(track) ? "HI-RES" : "LOSSLESS") : qualityLabel(track)}
    </span>
  );
}

export function trackActions(player: ReturnType<typeof usePlayer>, track: QueueTrack): MenuAction[] {
  return [
    { label: "Play now", icon: "play", run: () => player.play(track) },
    { label: "Play next", icon: "playNext", run: () => player.playNext(track) },
    { label: "Add to queue", icon: "addQueue", run: () => player.enqueue(track) },
    { label: "Start track radio", icon: "radio", run: () => void player.startRadio(track) },
    { label: "Download FLAC", icon: "download", run: () => undefined, href: downloadUrl(track) },
  ];
}

/**
 * One track in a list. Enter plays, Shift+Enter queues, Alt+Enter plays next,
 * ↑/↓ move between rows. The whole row is a single tab stop.
 */
export function TrackRow({ track, index, extra }: { track: QueueTrack; index?: number; extra?: ReactNode }) {
  const player = usePlayer();
  const isCurrent = player.current?.track.id === track.id;
  const playing = isCurrent && player.playback.status === "playing";

  const onKey = (e: KeyboardEvent<HTMLLIElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) player.enqueue(track);
      else if (e.altKey) player.playNext(track);
      else player.play(track);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const sib = e.key === "ArrowDown" ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling;
      (sib as HTMLElement | null)?.focus();
    }
  };

  return (
    <li
      className={`track-row${isCurrent ? " is-current" : ""}`}
      tabIndex={0}
      aria-label={`${track.title} by ${track.artist}`}
      aria-current={isCurrent ? "true" : undefined}
      onKeyDown={onKey}
      onDoubleClick={() => player.play(track)}
    >
      <div className="track-cover-wrap">
        <Cover src={track.coverUrl} title={track.title} size={44} />
        <button
          className={`cover-play${playing ? " visible" : ""}`}
          aria-label={playing ? `Pause ${track.title}` : `Play ${track.title}`}
          onClick={() => (isCurrent ? player.toggle() : player.play(track))}
          tabIndex={-1}
        >
          {playing ? <span className="eq" aria-hidden="true"><i /><i /><i /></span> : <Icon name="play" size={22} />}
        </button>
      </div>
      <div className="track-main">
        <div className="track-title">
          {index !== undefined ? <span className="track-index">{index + 1}</span> : null}
          <span className="ellipsis">{track.title}</span>
        </div>
        <div className="track-sub ellipsis">
          {track.artist}
          {track.album ? <span className="dim"> · {track.album}</span> : null}
          {track.reason ? <span className="dim"> · {track.reason}</span> : null}
        </div>
      </div>
      {extra}
      <QualityBadge track={track} compact />
      <span className="track-duration">{formatDuration(track.durationSec)}</span>
      <div className="track-actions">
        <button className="icon-btn hide-sm" aria-label={`Add ${track.title} to queue`} title="Add to queue" onClick={() => player.enqueue(track)}>
          <Icon name="addQueue" />
        </button>
        <TrackMenu label={`More actions for ${track.title}`} actions={trackActions(player, track)} />
      </div>
    </li>
  );
}

export function TrackListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <ul className="track-list" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="track-row skeleton-row">
          <div className="skeleton" style={{ width: 44, height: 44, borderRadius: 8 }} />
          <div className="track-main">
            <div className="skeleton" style={{ width: `${50 + ((i * 17) % 35)}%`, height: 12 }} />
            <div className="skeleton" style={{ width: `${30 + ((i * 11) % 30)}%`, height: 10, marginTop: 8 }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
