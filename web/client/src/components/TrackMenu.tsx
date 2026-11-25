import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icons";

export interface MenuAction {
  label: string;
  icon: IconName;
  run: () => void;
  href?: string;
  disabled?: boolean;
}

/** "⋯" button + accessible popover menu (arrow keys, Home/End, Esc, click-outside). */
export function TrackMenu({ actions, label }: { actions: MenuAction[]; label: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const r = buttonRef.current.getBoundingClientRect();
    const menuH = actions.length * 40 + 12;
    const top = r.bottom + menuH > window.innerHeight - 8 ? Math.max(8, r.top - menuH) : r.bottom + 4;
    const left = Math.min(Math.max(8, r.right - 220), window.innerWidth - 228);
    setPos({ top, left });
  }, [open, actions.length]);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>("[role=menuitem]:not([aria-disabled=true])")?.focus();
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node) && !buttonRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onScroll = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", onScroll);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", onScroll);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not([aria-disabled=true])") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") items[(i + 1) % items.length]?.focus();
    else if (e.key === "ArrowUp") items[(i - 1 + items.length) % items.length]?.focus();
    else if (e.key === "Home") items[0]?.focus();
    else if (e.key === "End") items.at(-1)?.focus();
    else if (e.key === "Escape" || e.key === "Tab") close(e.key === "Escape");
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <>
      <button
        ref={buttonRef}
        className="icon-btn"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <Icon name="more" />
      </button>
      {open
        ? createPortal(
            <div ref={menuRef} id={menuId} className="menu" role="menu" aria-label={label} style={pos} onKeyDown={onKey}>
              {actions.map((a) =>
                a.href ? (
                  <a key={a.label} role="menuitem" className="menu-item" href={a.href} download tabIndex={-1} onClick={() => close(false)}>
                    <Icon name={a.icon} size={18} />
                    {a.label}
                  </a>
                ) : (
                  <button
                    key={a.label}
                    role="menuitem"
                    className="menu-item"
                    tabIndex={-1}
                    aria-disabled={a.disabled || undefined}
                    onClick={() => {
                      if (a.disabled) return;
                      close();
                      a.run();
                    }}
                  >
                    <Icon name={a.icon} size={18} />
                    {a.label}
                  </button>
                ),
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
