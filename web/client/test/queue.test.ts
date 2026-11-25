import { describe, expect, it } from "vitest";
import type { Track } from "../../shared/api";
import { EMPTY_QUEUE, currentItem, queueReducer, sanitize, upcoming, type QueueAction, type QueueState } from "../src/player/queue";

const t = (n: number): Track => ({ id: `demo:${n}`, provider: "demo", title: `Song ${n}`, artist: `Artist ${n}`, lossless: true });
const run = (actions: QueueAction[], start: QueueState = EMPTY_QUEUE) => actions.reduce(queueReducer, start);
const ids = (s: QueueState) => s.items.map((i) => i.track.id);

describe("queue reducer", () => {
  it("playNow inserts after the current track and jumps to it, keeping what was upcoming", () => {
    const s = run([{ type: "playList", tracks: [t(1), t(2), t(3)] }, { type: "playNow", track: t(9) }]);
    expect(ids(s)).toEqual(["demo:1", "demo:9", "demo:2", "demo:3"]);
    expect(currentItem(s)?.track.id).toBe("demo:9");
  });

  it("playNext puts tracks right after the current one without changing it", () => {
    const s = run([{ type: "playList", tracks: [t(1), t(2)] }, { type: "playNext", tracks: [t(7), t(8)] }]);
    expect(ids(s)).toEqual(["demo:1", "demo:7", "demo:8", "demo:2"]);
    expect(s.index).toBe(0);
  });

  it("enqueue appends and lets the same track be queued twice with distinct uids", () => {
    const s = run([{ type: "playNow", track: t(1) }, { type: "enqueue", tracks: [t(2)] }, { type: "enqueue", tracks: [t(2)] }]);
    expect(ids(s)).toEqual(["demo:1", "demo:2", "demo:2"]);
    expect(new Set(s.items.map((i) => i.uid)).size).toBe(3);
  });

  it("enqueue on an empty queue does not auto-select anything", () => {
    const s = run([{ type: "enqueue", tracks: [t(1)] }]);
    expect(s.index).toBe(-1);
    expect(run([{ type: "next" }], s).index).toBe(0);
  });

  it("next / prev stay in bounds", () => {
    let s = run([{ type: "playList", tracks: [t(1), t(2)] }]);
    s = run([{ type: "prev" }], s);
    expect(s.index).toBe(0);
    s = run([{ type: "next" }, { type: "next" }, { type: "next" }], s);
    expect(s.index).toBe(1);
  });

  it("remove keeps the current track stable", () => {
    const base = run([{ type: "playList", tracks: [t(1), t(2), t(3)], start: 1 }]);
    const before = run([{ type: "remove", uid: base.items[0]!.uid }], base);
    expect(currentItem(before)?.track.id).toBe("demo:2");
    const removedCurrent = run([{ type: "remove", uid: base.items[1]!.uid }], base);
    expect(currentItem(removedCurrent)?.track.id).toBe("demo:3");
    const last = run([{ type: "playList", tracks: [t(1)] }]);
    expect(run([{ type: "remove", uid: last.items[0]!.uid }], last)).toMatchObject({ items: [], index: -1 });
  });

  it("move reorders and keeps tracking the current item", () => {
    const base = run([{ type: "playList", tracks: [t(1), t(2), t(3), t(4)], start: 1 }]);
    const s = run([{ type: "move", uid: base.items[3]!.uid, to: 0 }], base);
    expect(ids(s)).toEqual(["demo:4", "demo:1", "demo:2", "demo:3"]);
    expect(currentItem(s)?.track.id).toBe("demo:2");
  });

  it("clearUpcoming keeps history and the current track, and stops radio", () => {
    const base = run([
      { type: "playList", tracks: [t(1), t(2), t(3)], start: 1 },
      { type: "startRadio", seed: { type: "artist", artist: "X" }, label: "X", tracks: [t(5)] },
    ]);
    const s = run([{ type: "clearUpcoming" }], base);
    expect(ids(s)).toEqual(["demo:1", "demo:2"]);
    expect(s.radio).toBeNull();
  });

  it("startRadio replaces upcoming tracks with the station and radioLoaded dedupes", () => {
    let s = run([
      { type: "playList", tracks: [t(1), t(2)] },
      { type: "startRadio", seed: { type: "track", trackId: "demo:1" }, label: "Song 1", tracks: [t(1), t(5), t(6)] },
    ]);
    expect(ids(s)).toEqual(["demo:1", "demo:5", "demo:6"]);
    expect(s.items.slice(1).every((i) => i.origin === "radio")).toBe(true);
    s = run([{ type: "radioLoading" }, { type: "radioLoaded", tracks: [t(6), t(7)] }], s);
    expect(ids(s)).toEqual(["demo:1", "demo:5", "demo:6", "demo:7"]);
    expect(s.radio).toMatchObject({ loading: false, emptyRefills: 0 });
    s = run([{ type: "radioLoaded", tracks: [t(7)] }], s);
    expect(s.radio?.emptyRefills).toBe(1);
    s = run([{ type: "radioFailed" }], s);
    expect(s.radio?.failures).toBe(1);
    expect(upcoming(s)).toHaveLength(3);
  });

  it("caps persisted history", () => {
    const many = Array.from({ length: 150 }, (_, i) => t(i));
    let s = run([{ type: "playList", tracks: many }]);
    for (let i = 0; i < 140; i++) s = queueReducer(s, { type: "next" });
    expect(s.index).toBeLessThanOrEqual(100);
    expect(currentItem(s)?.track.id).toBe("demo:140");
  });

  it("sanitize survives corrupt persisted state", () => {
    expect(sanitize(null)).toEqual(EMPTY_QUEUE);
    expect(sanitize({ items: [{ uid: "a" }, { uid: "b", track: t(1) }], index: 9, radio: { seed: { type: "tag", tag: "x" }, loading: true } })).toMatchObject({
      items: [{ uid: "b" }],
      index: 0,
      radio: { loading: false },
    });
  });
});
