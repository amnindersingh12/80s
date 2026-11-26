# TASKS — Lossless web player, streaming API (`web/`) & Android client

Status legend: `[x]` done · `[ ]` open. The server lives in [`web/`](web/README.md), a standalone
TypeScript workspace next to the Android (Gradle) modules. The Android client lives in the pure
Kotlin `:remote` module plus thin wiring in `:preferences`, `:engine`, `:repository` and `:music`.

## 0. Discovery
- [x] Inspect repo (Android/Kotlin Felicity fork + embedded NanoHTTPD web player) and decide placement
- [x] Scaffold `web/` npm workspace (Fastify + TypeScript server, Vite + React client, shared API types)

## 1. Backend API & providers
- [x] `AudioProvider` interface (`search`, `getTrackMetadata`, `getStreamUrl`)
- [x] Env-driven config parser with defaults (`MEDIA_*`, `SUPABASE_*`, timeouts, field mappings)
- [x] Supabase password grant + refresh grant, in-memory JWT cache behind an async lock
- [x] Auto-refresh 60 s before expiry (timer + lazy check), seeded `MEDIA_REFRESH_TOKEN`, 401 → re-auth
- [x] `RemoteMediaProvider`: bearer auth, configurable paths / query param / track-id field / JSON field map
- [x] Bounded job polling (2 s interval, 45 s cap, 1 retry on transient 5xx/timeout) → clean 503/504 JSON
- [x] 15 s timeout on auth & search requests
- [x] Concurrency semaphore (max 2 simultaneous jobs) + single-flight per track
- [x] Optional fallback `SubsonicProvider` (OpenSubsonic / Navidrome), token or API-key auth
- [x] `ProviderChain`: id prefix routing, failover on timeout/unavailable, cross-provider match, circuit breaker
- [x] Cache layer: in-memory TTL/LRU, Redis when `REDIS_URL` is set; 15 min search, 6 h signed URLs
- [x] `GET /api/stream/:id` Range-aware pass-through proxy (Range / Content-Range / Accept-Ranges, HEAD, abort on disconnect, expired-URL re-resolve)
- [x] `GET /api/download/:id` with `Content-Disposition: attachment; filename="Artist - Title.flac"` (+ RFC 5987 UTF-8)
- [x] Prepare/status endpoints so the UI can show job progress
- [x] Health endpoint, optional `APP_ACCESS_KEY` cookie gate, log redaction
- [x] Demo mode (`MockAudioProvider` + synthetic WAV + SVG covers) when no media server is configured

## 2. Discovery & recommendation engine
- [x] Last.fm client (similar tracks/artists, top tracks, tag charts)
- [x] ListenBrainz client (LB Radio artist/tag + recording metadata)
- [x] MusicBrainz client (artist MBID lookup, tags) with 1 req/s rate limit + User-Agent
- [x] Seeds: track / artist / tag (e.g. Punjabi pop, indie, hip-hop) → similar artists, related tracks
- [x] Merge, dedupe, score and diversify results across sources; partial results with warnings
- [x] Match against the active provider → `playable` vs `metadata-only`
- [x] Continuous radio endpoint with exclusion list

## 3. Web player frontend
- [x] Instant search (debounced, abortable) with cover art, artist/album, duration, lossless badge
- [x] Discover / Radio panel (seed by current track, artist or genre chips)
- [x] Persistent player bar: play/pause, seek scrubber (buffered), volume/mute, next/previous
- [x] Queue drawer: Play Next, Add to Queue, Start Track Radio, reorder/remove/clear
- [x] Job-preparing status indicator (stage/progress/elapsed, retry, fallback badge)
- [x] Download button wired to `/api/download/:id`
- [x] Media Session API, keyboard shortcuts, persisted volume/queue, light/dark theme
- [x] Empty / loading / error states, mobile layout, access-key unlock screen

## 4. Quality & docs
- [x] Unit tests: JWT refresh caching, timeout/fallback failover, concurrency limiting, Range proxying
- [x] Additional tests: job polling, caches, recommendations, matcher, routes, docs coverage, end-to-end remote flow, client queue reducer
- [x] `.env.example` and `web/README.md` documenting every variable + path/field-mapping customisation
- [x] CI workflow for `web/` (tests + build)
- [x] All tests pass; `npm run build` (client + server) has zero errors
- [x] Browser smoke test of the built app in demo mode

## 5. Android app ↔ `web/` API
- [x] `:remote` pure Kotlin/JVM module: typed `WebApiClient` (health, search, prepare 200/202, stream, download, recommendations, radio)
- [x] `PreparePoller` state machine (200 ready / 202 preparing → backoff polling → ready / failed / timeout, idle re-post)
- [x] Access key sent as `Authorization: Bearer <APP_ACCESS_KEY>`, only to the configured origin (OkHttp interceptor + ExoPlayer data source + Media3 bitmap loader)
- [x] Server settings screen (Preferences → Library → Streaming server): URL, optional key (AES-256 encrypted prefs), Test connection on `GET /api/health` with per-provider status, download folder
- [x] Stream panel (home screens, only when a server is configured): debounced remote search, preparing banner (stage / % / cancel / retry), LOSSLESS / HI-RES badges via the local `Audio` model
- [x] Playback through the existing player: `/api/stream/:id` with HTTP `Range` seeking, artwork + metadata on lock screen / notification
- [x] Downloads: `/api/download/:id` saved into the music folder as the server's `Artist - Title.flac`, library rescan + MediaStore scan
- [x] Discover / Track Radio: genre & regional chips (incl. Punjabi Pop), similar artists, related tracks (playable vs metadata-only), Start (track) radio appending to the active queue and refilling it
- [x] No server configured → no panel, no network calls, local playback unchanged
- [x] Unit tests (`./gradlew :remote:test`): API client, 202 polling state machine, header injection, URL normalisation, Content-Disposition

## 6. Deployment & live config diagnostics
- [x] Multi-stage `web/Dockerfile` (non-root, prod deps only, `HEALTHCHECK` on `/api/health`) + `.dockerignore`
- [x] `web/docker-compose.yml` with optional `redis` profile; one-command deploy; VPS / Railway / Render / Fly.io notes
- [x] `npm run doctor`: masked env diagnostics, Supabase password + refresh grant (exact status + body), sample search with raw top-level keys vs `MEDIA_*` mappings, Last.fm / ListenBrainz / MusicBrainz reachability
- [x] CI: Docker image build + demo-mode healthcheck smoke test

## Verification log
- `npm run typecheck` — server + client, 0 errors
- `npm test` — server suite (with `TEST_REDIS_URL` for the Redis round-trip) + client queue reducer suite, all passing
- `npm run build` — client (Vite) + server (tsc), 0 errors
- Headless Chromium against the production build:
  - demo mode: search, play, 206 Range stream, keyboard seek, queue / play next, discover, radio, download, mobile (no overflow), light theme
  - fake Supabase/media server/R2: preparing indicator with live stage + %, FLAC 24/96 badge, job-failure message

- Android (2026-11-26): `./gradlew :remote:test` passed 34 of 34. `:music:compileFossDebugKotlin` and `:music:hiltJavaCompileFossDebug` (checks the Hilt graph) built with no errors. A full APK assemble (native NDK builds) was not run on the 2-core build VM.
- `web/` (2026-11-26): `npm run typecheck`, `npm test` (132 passed, 1 skipped: the Redis round-trip test) and `npm run build` all passed on Node 24.
- Docker: `docker build web` succeeded (273 MB image). Container smoke test in demo mode with `APP_ACCESS_KEY` set:
  - `/api/health` returned 200, and the `HEALTHCHECK` reported `healthy`.
  - Search returned 401 without the key and 200 with the key.
  - A Range stream request returned 206; the UI returned 200.
  - The container runs as `node`, and `node server/dist/doctor.js` passed inside it.
  - `docker compose config` was valid, including the `redis` profile.
- `npm run doctor` was run live with no `.env` (demo): ListenBrainz and MusicBrainz were reachable.

## Notes for deployment (not checklist items)
- Set `LASTFM_API_KEY` and a contactable `MUSICBRAINZ_USER_AGENT` in production for the best recommendations.
- Without them, ListenBrainz + MusicBrainz still work keylessly; the UI shows which sources answered.
