import type { RecommendationSeed, Track } from "../../../shared/api";

export type QueueTrack = Track & { reason?: string; key?: string };

export interface QueueItem {
  /** Unique per insertion, so the same track can be queued twice. */
  uid: string;
  track: QueueTrack;
  origin: "user" | "radio";
}

export interface RadioState {
  seed: RecommendationSeed;
  label: string;
  loading: boolean;
  /** Consecutive empty refills; the player re-seeds from the last radio track, then gives up. */
  emptyRefills: number;
  failures: number;
}

export interface QueueState {
  items: QueueItem[];
  /** Index of the current item, -1 when nothing is selected. */
  index: number;
  radio: RadioState | null;
}

export type QueueAction =
  | { type: "playNow"; track: QueueTrack }
  | { type: "playList"; tracks: QueueTrack[]; start?: number }
  | { type: "playNext"; tracks: QueueTrack[] }
  | { type: "enqueue"; tracks: QueueTrack[]; origin?: QueueItem["origin"] }
  | { type: "jump"; uid: string }
  | { type: "next" }
  | { type: "prev" }
  | { type: "remove"; uid: string }
  | { type: "move"; uid: string; to: number }
  | { type: "clearUpcoming" }
  | { type: "clearAll" }
  | { type: "startRadio"; seed: RecommendationSeed; label: string; tracks: QueueTrack[] }
  | { type: "radioLoading" }
  | { type: "radioLoaded"; tracks: QueueTrack[] }
  | { type: "radioFailed" }
  | { type: "stopRadio" }
  | { type: "hydrate"; state: QueueState };

export const EMPTY_QUEUE: QueueState = { items: [], index: -1, radio: null };
const MAX_HISTORY = 100;

let seq = 0;
export function makeUid(): string {
  seq = (seq + 1) % 1e9;
  return `q${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

const toItems = (tracks: QueueTrack[], origin: QueueItem["origin"] = "user"): QueueItem[] =>
  tracks.map((track) => ({ uid: makeUid(), track, origin }));

export function upcoming(state: QueueState): QueueItem[] {
  return state.items.slice(state.index + 1);
}

export function currentItem(state: QueueState): QueueItem | undefined {
  return state.index >= 0 ? state.items[state.index] : undefined;
}

/** Drop old history so the persisted queue stays small. */
function trimHistory(state: QueueState): QueueState {
  const extra = state.index - MAX_HISTORY;
  if (extra <= 0) return state;
  return { ...state, items: state.items.slice(extra), index: state.index - extra };
}

function insertAfterCurrent(state: QueueState, items: QueueItem[]): QueueItem[] {
  const at = state.index + 1;
  return [...state.items.slice(0, at), ...items, ...state.items.slice(at)];
}

export function queueReducer(state: QueueState, action: QueueAction): QueueState {
  switch (action.type) {
    case "playNow": {
      const items = insertAfterCurrent(state, toItems([action.track]));
      return trimHistory({ ...state, items, index: state.index + 1 });
    }
    case "playList": {
      if (!action.tracks.length) return state;
      const start = Math.max(0, Math.min(action.start ?? 0, action.tracks.length - 1));
      return { items: toItems(action.tracks), index: start, radio: null };
    }
    case "playNext": {
      if (!action.tracks.length) return state;
      return { ...state, items: insertAfterCurrent(state, toItems(action.tracks)) };
    }
    case "enqueue": {
      if (!action.tracks.length) return state;
      const items = [...state.items, ...toItems(action.tracks, action.origin)];
      return { ...state, items, index: state.index === -1 && state.items.length === 0 ? -1 : state.index };
    }
    case "jump": {
      const i = state.items.findIndex((x) => x.uid === action.uid);
      return i < 0 ? state : trimHistory({ ...state, index: i });
    }
    case "next":
      return state.index < state.items.length - 1 ? trimHistory({ ...state, index: state.index + 1 }) : state;
    case "prev":
      return state.index > 0 ? { ...state, index: state.index - 1 } : state;
    case "remove": {
      const i = state.items.findIndex((x) => x.uid === action.uid);
      if (i < 0) return state;
      const items = state.items.filter((_, j) => j !== i);
      let index = state.index;
      if (i < state.index) index--;
      if (index >= items.length) index = items.length - 1;
      return { ...state, items, index };
    }
    case "move": {
      const from = state.items.findIndex((x) => x.uid === action.uid);
      if (from < 0) return state;
      const to = Math.max(0, Math.min(action.to, state.items.length - 1));
      if (from === to) return state;
      const currentUid = state.items[state.index]?.uid;
      const items = [...state.items];
      const [moved] = items.splice(from, 1);
      items.splice(to, 0, moved as QueueItem);
      const index = currentUid ? items.findIndex((x) => x.uid === currentUid) : state.index;
      return { ...state, items, index };
    }
    case "clearUpcoming":
      return { ...state, items: state.items.slice(0, state.index + 1), radio: null };
    case "clearAll":
      return EMPTY_QUEUE;
    case "startRadio": {
      // Keep history + current, replace whatever was upcoming with the station.
      const kept = state.items.slice(0, state.index + 1);
      const keptIds = new Set(kept.slice(-1).map((x) => x.track.id));
      const fresh = toItems(action.tracks.filter((t) => !keptIds.has(t.id)), "radio");
      return {
        items: [...kept, ...fresh],
        index: state.index,
        radio: { seed: action.seed, label: action.label, loading: false, emptyRefills: 0, failures: 0 },
      };
    }
    case "radioLoading":
      return state.radio ? { ...state, radio: { ...state.radio, loading: true } } : state;
    case "radioLoaded": {
      if (!state.radio) return state;
      const known = new Set(state.items.map((x) => x.track.id));
      const fresh = action.tracks.filter((t) => !known.has(t.id));
      return {
        ...state,
        items: [...state.items, ...toItems(fresh, "radio")],
        radio: {
          ...state.radio,
          loading: false,
          failures: 0,
          emptyRefills: fresh.length ? 0 : state.radio.emptyRefills + 1,
        },
      };
    }
    case "radioFailed":
      return state.radio ? { ...state, radio: { ...state.radio, loading: false, failures: state.radio.failures + 1 } } : state;
    case "stopRadio":
      return { ...state, radio: null };
    case "hydrate":
      return sanitize(action.state);
  }
}

/** Defensive parse of a persisted queue (old versions, manual edits, corrupt storage). */
export function sanitize(raw: unknown): QueueState {
  if (!raw || typeof raw !== "object") return EMPTY_QUEUE;
  const r = raw as Partial<QueueState>;
  const items = Array.isArray(r.items)
    ? r.items.filter(
        (x): x is QueueItem =>
          Boolean(x && typeof x.uid === "string" && x.track && typeof x.track.id === "string" && typeof x.track.title === "string"),
      )
    : [];
  const index = typeof r.index === "number" && r.index >= -1 && r.index < items.length ? r.index : items.length ? 0 : -1;
  const radio = r.radio && typeof r.radio === "object" && r.radio.seed ? { ...r.radio, loading: false } : null;
  return { items, index, radio };
}
