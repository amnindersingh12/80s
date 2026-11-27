import { useEffect, useRef } from "react";
import { formatDuration } from "../lib/format";
import { usePlayer } from "../player/PlayerContext";
import { upcoming, type QueueItem } from "../player/queue";
import { Cover } from "./Cover";
import { Icon, Spinner } from "./Icons";
import { TrackMenu } from "./TrackMenu";
import { trackActions } from "./TrackRow";

/** Slide-out queue: now playing, up next (reorder/remove/jump), radio status. */
export function QueueDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const player = usePlayer();
  const { queue, current } = player;
  const next = upcoming(queue);
  const panelRef = useRef<HTMLElement>(null);
  const totalSec = next.reduce((s, i) => s + (i.track.durationSec ?? 0), 0);

  useEffect(() => {
    if (open) panelRef.current?.querySelector<HTMLElement>("button")?.focus();
  }, [open]);

  const row = (item: QueueItem, i: number, isCurrent = false) => (
    <li key={item.uid} className={`queue-row${isCurrent ? " is-current" : ""}`}>
      <button className="queue-main" onClick={() => !isCurrent && player.jump(item.uid)} aria-label={`Play ${item.track.title} by ${item.track.artist}`} disabled={isCurrent}>
        <Cover src={item.track.coverUrl} title={item.track.title} size={40} />
        <span className="queue-text">
          <span className="ellipsis queue-title">{item.track.title}</span>
          <span className="ellipsis dim">
            {item.track.artist}
            {item.origin === "radio" ? " · radio" : ""}
          </span>
        </span>
        <span className="track-duration">{formatDuration(item.track.durationSec)}</span>
      </button>
      {!isCurrent ? (
        <div className="queue-actions">
          <button className="icon-btn small" aria-label={`Move ${item.track.title} up`} disabled={i === 0} onClick={() => player.move(item.uid, queue.index + i)}>
            <Icon name="up" />
          </button>
          <button className="icon-btn small" aria-label={`Move ${item.track.title} down`} disabled={i === next.length - 1} onClick={() => player.move(item.uid, queue.index + i + 2)}>
            <Icon name="down" />
          </button>
          <button className="icon-btn small" aria-label={`Remove ${item.track.title} from queue`} onClick={() => player.remove(item.uid)}>
            <Icon name="close" size={18} />
          </button>
          <TrackMenu label={`More actions for ${item.track.title}`} actions={trackActions(player, item.track)} />
        </div>
      ) : null}
    </li>
  );

  return (
    <>
      <div className={`scrim${open ? " open" : ""}`} onClick={onClose} aria-hidden="true" />
      <aside
        id="queue-drawer"
        ref={panelRef}
        className={`drawer${open ? " open" : ""}`}
        aria-label="Queue"
        aria-hidden={!open}
        inert={!open}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="drawer-header">
          <h2>Queue</h2>
          <button className="icon-btn" aria-label="Close queue" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>

        {queue.radio ? (
          <div className="radio-banner">
            <Icon name="radio" size={18} />
            <span className="ellipsis">
              Radio · <strong>{queue.radio.label}</strong>
            </span>
            {queue.radio.loading ? <Spinner size={14} label="Loading more" /> : null}
            <button className="link-btn" onClick={player.stopRadio}>
              Stop
            </button>
          </div>
        ) : null}

        <div className="drawer-body">
          <h3 className="section-title">Now playing</h3>
          {current ? <ul className="queue-list">{row(current, -1, true)}</ul> : <p className="dim small pad">Nothing yet.</p>}

          <div className="section-title-row">
            <h3 className="section-title">
              Up next <span className="dim">{next.length ? `${next.length} · ${formatDuration(totalSec)}` : ""}</span>
            </h3>
            {next.length ? (
              <button className="link-btn" onClick={player.clearUpcoming}>
                Clear
              </button>
            ) : null}
          </div>
          {next.length ? (
            <ul className="queue-list">{next.map((item, i) => row(item, i))}</ul>
          ) : (
            <div className="empty-state compact">
              <p>
                Your queue is empty. Use <strong>Add to queue</strong> or <strong>Play next</strong> on any track, or start a radio
                {current ? (
                  <>
                    {" "}
                    from{" "}
                    <button className="link-btn" onClick={() => void player.startRadio(current.track)}>
                      “{current.track.title}”
                    </button>
                  </>
                ) : null}
                .
              </p>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
