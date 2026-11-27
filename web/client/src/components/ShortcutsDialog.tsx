import { useEffect, useRef } from "react";
import { Icon } from "./Icons";

const SHORTCUTS: Array<[string, string]> = [
  ["Space / K", "Play / pause"],
  ["← / →", "Seek 5 s"],
  ["J / L", "Seek 10 s"],
  ["N / P", "Next / previous track"],
  ["M", "Mute"],
  ["Q", "Toggle queue"],
  ["/", "Focus search"],
  ["Enter", "Play focused track"],
  ["Shift + Enter", "Add focused track to queue"],
  ["Alt + Enter", "Play focused track next"],
  ["?", "Show this help"],
];

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog ref={ref} className="dialog" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()} aria-labelledby="shortcuts-title">
      <header className="dialog-header">
        <h2 id="shortcuts-title">
          <Icon name="keyboard" /> Keyboard shortcuts
        </h2>
        <button className="icon-btn" aria-label="Close" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      <dl className="shortcuts">
        {SHORTCUTS.map(([k, v]) => (
          <div key={k}>
            <dt>
              {k.split(" / ").map((part, i) => (
                <span key={part}>
                  {i ? " / " : ""}
                  <kbd>{part}</kbd>
                </span>
              ))}
            </dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </dialog>
  );
}
