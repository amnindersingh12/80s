import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { PrepareStatus, RecommendationSeed, Track } from "../../../shared/api";
import { api, describeError, streamUrl, type UiErrorCode } from "../api";
import { useToast } from "../components/Toasts";
import { storage } from "../lib/storage";
import { EMPTY_QUEUE, currentItem, queueReducer, sanitize, upcoming, type QueueItem, type QueueState, type QueueTrack } from "./queue";

export type PlaybackStatus = "idle" | "preparing" | "buffering" | "playing" | "paused" | "error";

export interface PlaybackState {
  status: PlaybackStatus;
  prepare?: PrepareStatus;
  error?: { message: string; code: UiErrorCode; retryable: boolean };
  currentTime: number;
  duration: number;
  /** Seconds buffered ahead (end of the buffered range around the playhead). */
  bufferedEnd: number;
  volume: number;
  muted: boolean;
}

export interface PlayerApi {
  queue: QueueState;
  current?: QueueItem;
  playback: PlaybackState;
  play(track: QueueTrack): void;
  playList(tracks: QueueTrack[], start?: number): void;
  playNext(tracks: QueueTrack | QueueTrack[]): void;
  enqueue(tracks: QueueTrack | QueueTrack[]): void;
  startRadio(from: Track | RecommendationSeed, label?: string): Promise<void>;
  stopRadio(): void;
  toggle(): void;
  next(): void;
  prev(): void;
  seek(seconds: number): void;
  seekBy(delta: number): void;
  setVolume(volume: number): void;
  toggleMute(): void;
  jump(uid: string): void;
  remove(uid: string): void;
  move(uid: string, to: number): void;
  clearUpcoming(): void;
  retry(): void;
}

const PlayerCtx = createContext<PlayerApi | null>(null);

export function usePlayer(): PlayerApi {
  const ctx = useContext(PlayerCtx);
  if (!ctx) throw new Error("usePlayer must be used inside <PlayerProvider>");
  return ctx;
}

const QUEUE_KEY = "80s.queue.v1";
const VOLUME_KEY = "80s.volume.v1";
const POSITION_KEY = "80s.position.v1";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const asArray = <T,>(v: T | T[]) => (Array.isArray(v) ? v : [v]);

function isTrack(x: Track | RecommendationSeed): x is Track {
  return "id" in x && "provider" in x;
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [queue, dispatch] = useReducer(queueReducer, EMPTY_QUEUE, () => sanitize(storage.get(QUEUE_KEY, null)));
  const savedVolume = storage.get(VOLUME_KEY, { volume: 0.9, muted: false });
  const [playback, setPlayback] = useState<PlaybackState>({
    status: "idle",
    currentTime: storage.get<{ id?: string; t?: number }>(POSITION_KEY, {}).t ?? 0,
    duration: 0,
    bufferedEnd: 0,
    volume: savedVolume.volume,
    muted: savedVolume.muted,
  });

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const playbackRef = useRef(playback);
  playbackRef.current = playback;

  /** Bumped on every load; stale async work compares against it and bails. */
  const generation = useRef(0);
  /** Track id currently attached to the <audio> element. */
  const loadedId = useRef<string | null>(null);
  const pendingSeek = useRef<number | null>(null);
  const wantPlay = useRef(false);
  const autoRetried = useRef<string | null>(null);
  const prefetched = useRef(new Set<string>());
  const lastPositionSave = useRef(0);

  const current = currentItem(queue);

  // ------------------------------------------------------------ loading ---

  const load = useCallback(async (item: QueueItem, autoplay: boolean, startAt = 0) => {
    const audio = audioRef.current;
    if (!audio) return;
    const gen = ++generation.current;
    const id = item.track.id;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    loadedId.current = null;
    setPlayback((p) => ({
      ...p,
      status: "preparing",
      error: undefined,
      prepare: { id, state: "preparing", stage: "queued" },
      currentTime: startAt,
      duration: item.track.durationSec ?? 0,
      bufferedEnd: 0,
    }));

    try {
      let status = await api.prepare(id);
      let delay = 600;
      while (status.state === "preparing" || status.state === "idle") {
        if (gen !== generation.current) return;
        const snapshot = status;
        setPlayback((p) => ({ ...p, prepare: snapshot }));
        await sleep(delay);
        delay = Math.min(Math.round(delay * 1.35), 2000);
        if (gen !== generation.current) return;
        // "idle" means the server forgot the job (restart) — kick it again.
        status = status.state === "idle" ? await api.prepare(id) : await api.prepareStatus(id);
      }
      if (gen !== generation.current) return;
      if (status.state === "error") {
        const e = status.error;
        setPlayback((p) => ({
          ...p,
          status: "error",
          prepare: status,
          error: { message: e?.message ?? "The track could not be prepared", code: e?.code ?? "INTERNAL", retryable: e?.retryable ?? true },
        }));
        return;
      }
      const ready = status;
      setPlayback((p) => ({ ...p, prepare: ready, status: autoplay ? "buffering" : "paused" }));
      loadedId.current = id;
      pendingSeek.current = startAt > 0 ? startAt : null;
      audio.src = streamUrl(id);
      if (autoplay) {
        await audio.play().catch((err: unknown) => {
          if (gen !== generation.current) return;
          // Autoplay policies: wait for a user gesture instead of failing.
          if ((err as DOMException).name === "NotAllowedError") setPlayback((p) => ({ ...p, status: "paused" }));
          else if ((err as DOMException).name !== "AbortError") throw err;
        });
      }
    } catch (err) {
      if (gen !== generation.current) return;
      setPlayback((p) => ({ ...p, status: "error", error: describeError(err) }));
    }
  }, []);

  // Load whenever the current queue entry changes (but not on first paint after a reload).
  const currentUid = current?.uid;
  useEffect(() => {
    if (!current) {
      generation.current++;
      const audio = audioRef.current;
      if (audio) {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      }
      loadedId.current = null;
      setPlayback((p) => ({ ...p, status: "idle", prepare: undefined, error: undefined, currentTime: 0, duration: 0, bufferedEnd: 0 }));
      return;
    }
    if (!wantPlay.current) {
      setPlayback((p) => ({ ...p, duration: current.track.durationSec ?? p.duration }));
      return;
    }
    autoRetried.current = null;
    void load(current, true);
  }, [currentUid, load]);

  // ------------------------------------------------------- audio events ---

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = playbackRef.current.volume;
    audio.muted = playbackRef.current.muted;

    const onPlaying = () => setPlayback((p) => ({ ...p, status: "playing", error: undefined }));
    const onPause = () => setPlayback((p) => (p.status === "playing" || p.status === "buffering" ? { ...p, status: "paused" } : p));
    const onWaiting = () => setPlayback((p) => (p.status === "playing" ? { ...p, status: "buffering" } : p));
    const onTime = () => {
      const t = audio.currentTime;
      setPlayback((p) => (Math.abs(p.currentTime - t) >= 0.25 ? { ...p, currentTime: t } : p));
      const now = Date.now();
      if (now - lastPositionSave.current > 5000 && loadedId.current) {
        lastPositionSave.current = now;
        storage.set(POSITION_KEY, { id: loadedId.current, t });
      }
    };
    const onMeta = () => {
      if (pendingSeek.current !== null && Number.isFinite(audio.duration)) {
        audio.currentTime = Math.min(pendingSeek.current, Math.max(0, audio.duration - 1));
        pendingSeek.current = null;
      }
      setPlayback((p) => ({ ...p, duration: Number.isFinite(audio.duration) ? audio.duration : p.duration }));
    };
    const onProgress = () => {
      const t = audio.currentTime;
      let end = 0;
      for (let i = 0; i < audio.buffered.length; i++) {
        if (audio.buffered.start(i) <= t + 0.5) end = Math.max(end, audio.buffered.end(i));
      }
      setPlayback((p) => (Math.abs(p.bufferedEnd - end) > 0.5 ? { ...p, bufferedEnd: end } : p));
    };
    const onVolume = () => {
      setPlayback((p) => ({ ...p, volume: audio.volume, muted: audio.muted }));
      storage.set(VOLUME_KEY, { volume: audio.volume, muted: audio.muted });
    };
    const onEnded = () => {
      storage.remove(POSITION_KEY);
      const q = queueRef.current;
      if (q.index < q.items.length - 1) {
        wantPlay.current = true;
        dispatch({ type: "next" });
      } else if (q.radio) {
        // Radio is topping up; the next item will start as soon as it lands.
        wantPlay.current = true;
        setPlayback((p) => ({ ...p, status: "preparing", prepare: { id: "", state: "preparing", stage: "finding more music" } }));
      } else {
        setPlayback((p) => ({ ...p, status: "paused", currentTime: 0 }));
        audio.currentTime = 0;
      }
    };
    const onError = () => {
      const id = loadedId.current;
      if (!id || !audio.error) return;
      const gen = generation.current;
      void api.probeStream(id).then((problem) => {
        if (gen !== generation.current) return;
        const item = currentItem(queueRef.current);
        // One silent retry for transient failures (expired URL, network blip) from the same position.
        if (item && autoRetried.current !== item.uid && (!problem || problem.retryable)) {
          autoRetried.current = item.uid;
          void load(item, true, audio.currentTime || playbackRef.current.currentTime);
          return;
        }
        setPlayback((p) => ({
          ...p,
          status: "error",
          error: problem
            ? { message: problem.message, code: problem.code, retryable: problem.retryable }
            : { message: "Your browser could not decode this stream.", code: "STREAM_UNAVAILABLE", retryable: true },
        }));
      });
    };

    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("waiting", onWaiting);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("durationchange", onMeta);
    audio.addEventListener("progress", onProgress);
    audio.addEventListener("volumechange", onVolume);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);
    return () => {
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("waiting", onWaiting);
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("durationchange", onMeta);
      audio.removeEventListener("progress", onProgress);
      audio.removeEventListener("volumechange", onVolume);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
    };
  }, [load]);

  // --------------------------------------------------------- persistence ---

  useEffect(() => {
    const handle = window.setTimeout(() => storage.set(QUEUE_KEY, queue), 300);
    return () => window.clearTimeout(handle);
  }, [queue]);

  // ------------------------------------------------- prefetch next track ---

  const nextId = upcoming(queue)[0]?.track.id;
  useEffect(() => {
    if (playback.status !== "playing" || !nextId || prefetched.current.has(nextId)) return;
    prefetched.current.add(nextId);
    // Warm the upstream job so the next track starts instantly (server limits concurrency).
    api.prepare(nextId).catch(() => prefetched.current.delete(nextId));
  }, [playback.status, nextId]);

  // ------------------------------------------------------ radio top-up ---

  const radio = queue.radio;
  const upcomingCount = queue.items.length - queue.index - 1;
  useEffect(() => {
    if (!radio || radio.loading || upcomingCount >= 3) return;
    if (radio.failures >= 3 || radio.emptyRefills >= 3) {
      dispatch({ type: "stopRadio" });
      toast.show(radio.failures >= 3 ? "Radio stopped: recommendations are unavailable." : "Radio ran out of new tracks.", {
        tone: radio.failures >= 3 ? "error" : "info",
      });
      return;
    }
    const q = queueRef.current;
    const radioItems = q.items.filter((i) => i.origin === "radio");
    const drift = radioItems.at(-1)?.track;
    // After an empty refill, drift: seed from the most recent radio track to keep the station going.
    const seed: RecommendationSeed =
      radio.emptyRefills > 0 && drift ? { type: "track", trackId: drift.id, artist: drift.artist, title: drift.title } : radio.seed;
    const exclude = [...new Set(q.items.flatMap((i) => [i.track.id, i.track.key ?? ""]).filter(Boolean))].slice(-900);

    dispatch({ type: "radioLoading" });
    api
      .radio({ seed, exclude, limit: 10 })
      .then((res) => dispatch({ type: "radioLoaded", tracks: res.tracks }))
      .catch(() => dispatch({ type: "radioFailed" }));
  }, [radio, upcomingCount, toast]);

  // When radio delivers while we were waiting at the end of the queue, continue.
  useEffect(() => {
    const q = queueRef.current;
    const p = playbackRef.current;
    if (p.prepare?.stage === "finding more music" && q.index < q.items.length - 1) {
      wantPlay.current = true;
      dispatch({ type: "next" });
    }
  }, [queue.items.length]);

  // ------------------------------------------------------ media session ---

  useEffect(() => {
    if (!("mediaSession" in navigator) || !current) return;
    const t = current.track;
    const artwork = t.coverUrl ? [{ src: new URL(t.coverUrl, window.location.href).toString(), sizes: "300x300" }] : [];
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album ?? "", artwork });
    } catch {
      /* unsupported */
    }
    document.title = `${t.title} — ${t.artist} · 80s`;
    return () => {
      document.title = "80s · Lossless Player";
    };
  }, [current]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.playbackState = playback.status === "playing" ? "playing" : playback.status === "idle" ? "none" : "paused";
    const audio = audioRef.current;
    if (audio && Number.isFinite(audio.duration) && audio.duration > 0 && "setPositionState" in navigator.mediaSession) {
      try {
        navigator.mediaSession.setPositionState({ duration: audio.duration, position: Math.min(audio.currentTime, audio.duration), playbackRate: audio.playbackRate });
      } catch {
        /* ignore */
      }
    }
  }, [playback.status, Math.floor(playback.currentTime / 5)]);

  // ----------------------------------------------------------- commands ---

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    const item = currentItem(queueRef.current);
    if (!audio) return;
    if (!item) {
      if (queueRef.current.items.length) {
        wantPlay.current = true;
        dispatch({ type: "next" });
      }
      return;
    }
    const p = playbackRef.current;
    if (p.status === "error") {
      wantPlay.current = true;
      void load(item, true, p.currentTime);
      return;
    }
    if (p.status === "preparing") return;
    if (loadedId.current !== item.track.id) {
      // Restored from a previous session: resume where we left off.
      wantPlay.current = true;
      const saved = storage.get<{ id?: string; t?: number }>(POSITION_KEY, {});
      void load(item, true, saved.id === item.track.id ? (saved.t ?? 0) : 0);
      return;
    }
    if (audio.paused) {
      wantPlay.current = true;
      audio.play().catch(() => undefined);
    } else {
      audio.pause();
    }
  }, [load]);

  const commands = useMemo(() => {
    const go = (action: Parameters<typeof dispatch>[0]) => {
      wantPlay.current = true;
      dispatch(action);
    };
    return {
      play: (track: QueueTrack) => go({ type: "playNow", track }),
      playList: (tracks: QueueTrack[], start = 0) => go({ type: "playList", tracks, start }),
      playNext: (tracks: QueueTrack | QueueTrack[]) => {
        dispatch({ type: "playNext", tracks: asArray(tracks) });
        toast.show(asArray(tracks).length > 1 ? `${asArray(tracks).length} tracks will play next` : `“${asArray(tracks)[0]?.title}” plays next`);
      },
      enqueue: (tracks: QueueTrack | QueueTrack[]) => {
        dispatch({ type: "enqueue", tracks: asArray(tracks) });
        toast.show(asArray(tracks).length > 1 ? `Added ${asArray(tracks).length} tracks to the queue` : `Added “${asArray(tracks)[0]?.title}” to the queue`);
      },
      next: () => {
        const q = queueRef.current;
        if (q.index < q.items.length - 1) go({ type: "next" });
      },
      prev: () => {
        const audio = audioRef.current;
        if (audio && audio.currentTime > 3) {
          audio.currentTime = 0;
          return;
        }
        if (queueRef.current.index > 0) go({ type: "prev" });
        else if (audio) audio.currentTime = 0;
      },
      seek: (seconds: number) => {
        const audio = audioRef.current;
        if (!audio || !loadedId.current) return;
        const d = Number.isFinite(audio.duration) ? audio.duration : playbackRef.current.duration;
        audio.currentTime = Math.max(0, Math.min(seconds, d || seconds));
        setPlayback((p) => ({ ...p, currentTime: audio.currentTime }));
      },
      seekBy: (delta: number) => {
        const audio = audioRef.current;
        if (!audio || !loadedId.current) return;
        audio.currentTime = Math.max(0, audio.currentTime + delta);
      },
      setVolume: (volume: number) => {
        const audio = audioRef.current;
        if (!audio) return;
        audio.volume = Math.max(0, Math.min(1, volume));
        if (audio.muted && volume > 0) audio.muted = false;
      },
      toggleMute: () => {
        const audio = audioRef.current;
        if (audio) audio.muted = !audio.muted;
      },
      jump: (uid: string) => go({ type: "jump", uid }),
      remove: (uid: string) => {
        if (currentItem(queueRef.current)?.uid === uid) wantPlay.current = playbackRef.current.status === "playing";
        dispatch({ type: "remove", uid });
      },
      move: (uid: string, to: number) => dispatch({ type: "move", uid, to }),
      clearUpcoming: () => dispatch({ type: "clearUpcoming" }),
      stopRadio: () => dispatch({ type: "stopRadio" }),
      retry: () => {
        const item = currentItem(queueRef.current);
        if (!item) return;
        wantPlay.current = true;
        autoRetried.current = null;
        void load(item, true, playbackRef.current.currentTime);
      },
      startRadio: async (from: Track | RecommendationSeed, label?: string) => {
        const seed: RecommendationSeed = isTrack(from)
          ? { type: "track", trackId: from.id, artist: from.artist, title: from.title }
          : from;
        const name = label ?? (isTrack(from) ? `${from.title} radio` : seed.type === "tag" ? `${seed.tag} radio` : `${seed.artist} radio`);
        if (isTrack(from) && currentItem(queueRef.current)?.track.id !== from.id) go({ type: "playNow", track: from });
        try {
          const res = await api.radio({ seed, limit: 12 });
          if (!res.tracks.length) {
            const outage = res.warnings.some((w) => !w.startsWith("Tip:"));
            toast.show(
              `No playable tracks found for “${res.seed.label || name}” on your server${outage ? " (some recommendation sources are unavailable)" : ""}.`,
              { tone: "error" },
            );
            return;
          }
          const startPlaying = !currentItem(queueRef.current);
          dispatch({ type: "startRadio", seed, label: res.seed.label || name, tracks: res.tracks });
          if (startPlaying) go({ type: "next" });
          toast.show(`Radio started: ${res.seed.label || name}`);
        } catch (err) {
          toast.show(`Couldn't start radio — ${describeError(err).message}`, { tone: "error" });
        }
      },
    };
  }, [load, toast]);

  const value = useMemo<PlayerApi>(
    () => ({ queue, current, playback, toggle, ...commands }),
    [queue, current, playback, toggle, commands],
  );

  return (
    <PlayerCtx.Provider value={value}>
      {children}
      {/* preload="none": nothing is fetched until a track is prepared and played. */}
      <audio ref={audioRef} preload="none" />
    </PlayerCtx.Provider>
  );
}
