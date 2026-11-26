import { useCallback, useEffect, useRef, useState } from "react";
import type { HealthResponse } from "../../shared/api";
import { api, onAccessRequired } from "./api";
import { DiscoverPanel } from "./components/DiscoverPanel";
import { Icon, Spinner } from "./components/Icons";
import { PlayerBar } from "./components/PlayerBar";
import { QueueDrawer } from "./components/QueueDrawer";
import { SearchPanel } from "./components/SearchPanel";
import { DiagnosticsDialog } from "./components/DiagnosticsDialog";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { UnlockScreen } from "./components/UnlockScreen";
import { storage } from "./lib/storage";
import { PlayerProvider, usePlayer } from "./player/PlayerContext";

type Theme = "auto" | "light" | "dark";
const THEME_KEY = "80s.theme.v1";

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => storage.get(THEME_KEY, "auto"));
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "auto") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    storage.set(THEME_KEY, theme);
  }, [theme]);
  const cycle = () => setTheme((t) => (t === "auto" ? "dark" : t === "dark" ? "light" : "auto"));
  return [theme, cycle];
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

function ProviderStatus({ health }: { health: HealthResponse | null }) {
  if (!health) return <span className="conn conn-unknown"><Spinner size={10} /> Connecting…</span>;
  if (health.configErrors?.length) {
    return (
      <span className="conn conn-warn" title={`Media config ignored, running demo mode:\n${health.configErrors.join("\n")}\nOpen Diagnostics for details.`}>
        <span className="dot" /> Config error
      </span>
    );
  }
  if (health.demo) {
    return (
      <span className="conn conn-demo" title="No media server configured — set MEDIA_API_BASE on the server">
        <span className="dot" /> Demo mode
      </span>
    );
  }
  const primary = health.providers.find((p) => p.role === "primary");
  const fallback = health.providers.find((p) => p.role === "fallback");
  if (primary?.circuit === "open") {
    return (
      <span className="conn conn-warn" title={primary.lastError ?? "Primary provider unavailable"}>
        <span className="dot" /> {fallback ? `Fallback: ${fallback.name}` : "Server degraded"}
      </span>
    );
  }
  return (
    <span className="conn conn-ok" title={`Primary: ${primary?.name}${fallback ? ` · fallback: ${fallback.name}` : ""} · cache: ${health.cache}`}>
      <span className="dot" /> {primary?.name ?? "online"}
      {fallback ? <span className="dim"> + {fallback.name}</span> : null}
    </span>
  );
}

function Shell({ health, refreshHealth }: { health: HealthResponse | null; refreshHealth: () => void }) {
  const player = usePlayer();
  const [query, setQuery] = useState("");
  const [queueOpen, setQueueOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);
  const [tab, setTab] = useState<"search" | "discover">("search");
  const [theme, cycleTheme] = useTheme();
  const searchRef = useRef<HTMLInputElement>(null);

  const search = useCallback((q: string) => {
    setQuery(q);
    setTab("search");
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    const id = window.setInterval(refreshHealth, 60_000);
    return () => window.clearInterval(id);
  }, [refreshHealth]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey) {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
          e.preventDefault();
          searchRef.current?.focus();
          searchRef.current?.select();
        }
        return;
      }
      if (isTyping(e.target)) return;
      const onControl = (e.target as HTMLElement | null)?.closest("button, a, [role=menuitem], input, li[tabindex]");
      switch (e.key) {
        case " ":
          if (onControl) return; // let buttons / rows handle Space themselves
          e.preventDefault();
          player.toggle();
          break;
        case "k":
          player.toggle();
          break;
        case "ArrowLeft":
          if (onControl && (e.target as HTMLElement).tagName === "INPUT") return;
          e.preventDefault();
          player.seekBy(-5);
          break;
        case "ArrowRight":
          if (onControl && (e.target as HTMLElement).tagName === "INPUT") return;
          e.preventDefault();
          player.seekBy(5);
          break;
        case "j":
          player.seekBy(-10);
          break;
        case "l":
          player.seekBy(10);
          break;
        case "n":
        case "N":
          player.next();
          break;
        case "p":
        case "P":
          player.prev();
          break;
        case "m":
          player.toggleMute();
          break;
        case "q":
          setQueueOpen((o) => !o);
          break;
        case "/":
          e.preventDefault();
          searchRef.current?.focus();
          searchRef.current?.select();
          break;
        case "?":
          setHelpOpen(true);
          break;
        case "Escape":
          setQueueOpen(false);
          break;
        default:
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [player]);

  // Media keys / OS controls.
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      ["play", () => player.toggle()],
      ["pause", () => player.toggle()],
      ["nexttrack", () => player.next()],
      ["previoustrack", () => player.prev()],
      ["seekbackward", (d) => player.seekBy(-(d.seekOffset ?? 10))],
      ["seekforward", (d) => player.seekBy(d.seekOffset ?? 10)],
      ["seekto", (d) => d.seekTime !== undefined && player.seek(d.seekTime)],
    ];
    for (const [action, fn] of handlers) {
      try {
        ms.setActionHandler(action, fn);
      } catch {
        /* unsupported action */
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          ms.setActionHandler(action, null);
        } catch {
          /* ignore */
        }
      }
    };
  }, [player]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src="/favicon.svg" alt="" width={28} height={28} />
          <span className="brand-name">80s</span>
          <span className="brand-sub">lossless</span>
        </div>
        <form className="search-box" role="search" onSubmit={(e) => e.preventDefault()}>
          <Icon name="search" size={18} />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setTab("search");
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                if (query) setQuery("");
                else searchRef.current?.blur();
              } else if (e.key === "ArrowDown") {
                const first = document.querySelector<HTMLElement>(".search-panel .track-row");
                if (first) {
                  e.preventDefault();
                  first.focus();
                }
              }
            }}
            placeholder="Search tracks, artists, albums…"
            aria-label="Search your media server"
            autoComplete="off"
            spellCheck={false}
          />
          {query ? (
            <button type="button" className="icon-btn small" aria-label="Clear search" onClick={() => setQuery("")}>
              <Icon name="close" size={16} />
            </button>
          ) : (
            <kbd className="hide-sm">/</kbd>
          )}
        </form>
        <div className="topbar-right">
          <ProviderStatus health={health} />
          {health?.accessRequired && (
            <button className="icon-btn" aria-label="Diagnostics" title="Diagnostics" onClick={() => setDiagOpen(true)}>
              <Icon name="wrench" />
            </button>
          )}
          <button className="icon-btn hide-sm" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={() => setHelpOpen(true)}>
            <Icon name="keyboard" />
          </button>
          <button className="icon-btn" aria-label={`Theme: ${theme}`} title={`Theme: ${theme} (click to change)`} onClick={cycleTheme}>
            <Icon name={theme === "dark" ? "moon" : theme === "light" ? "sun" : "auto"} />
          </button>
        </div>
      </header>

      <nav className="tabs" aria-label="Sections">
        <button className={`tab${tab === "search" ? " active" : ""}`} aria-pressed={tab === "search"} onClick={() => setTab("search")}>
          <Icon name="search" size={18} /> Search
        </button>
        <button className={`tab${tab === "discover" ? " active" : ""}`} aria-pressed={tab === "discover"} onClick={() => setTab("discover")}>
          <Icon name="sparkle" size={18} /> Discover
        </button>
      </nav>

      <main className={`content tab-${tab}`}>
        <SearchPanel query={query} onQuery={search} />
        <DiscoverPanel onSearch={search} />
      </main>

      <PlayerBar onToggleQueue={() => setQueueOpen((o) => !o)} queueOpen={queueOpen} />
      <QueueDrawer open={queueOpen} onClose={() => setQueueOpen(false)} />
      <ShortcutsDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
      <DiagnosticsDialog open={diagOpen} onClose={() => setDiagOpen(false)} />
    </div>
  );
}

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [locked, setLocked] = useState(false);
  const [offline, setOffline] = useState(false);

  const refreshHealth = useCallback(() => {
    api
      .health()
      .then((h) => {
        setHealth(h);
        setOffline(false);
        setLocked(h.accessRequired && !h.authenticated);
      })
      .catch(() => setOffline(true));
  }, []);

  useEffect(() => {
    refreshHealth();
    return onAccessRequired(() => setLocked(true));
  }, [refreshHealth]);

  if (locked) {
    return (
      <UnlockScreen
        onUnlocked={() => {
          setLocked(false);
          refreshHealth();
        }}
      />
    );
  }

  return (
    <PlayerProvider>
      {offline ? (
        <div className="offline-banner" role="alert">
          <Icon name="error" size={16} /> Can't reach the player server.{" "}
          <button className="link-btn" onClick={refreshHealth}>
            Retry
          </button>
        </div>
      ) : null}
      <Shell health={health} refreshHealth={refreshHealth} />
    </PlayerProvider>
  );
}
