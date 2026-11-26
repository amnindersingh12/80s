# 80s · lossless web player

A FLAC-first web player and streaming API for your **personal, Supabase-authenticated media
server**, with an optional OpenSubsonic/Navidrome fallback and music discovery built on
Last.fm, ListenBrainz and MusicBrainz.

It lives next to the Android app in this repo and has nothing to do with the Gradle build.

```
web/
├── server/   Fastify + TypeScript API (providers, auth, streaming proxy, recommendations)
├── client/   Vite + React player UI
└── shared/   API types shared by both (declaration-only)
```

## Quick start

```bash
cd web
npm install
cp .env.example .env        # optional: leave empty to try the built-in demo catalog
npm run dev                 # API on :8787, UI on http://localhost:5173 (proxied)
```

Production:

```bash
npm run build               # type-checks + builds client and server
npm start                   # one process on :8787 serving both the API and the UI
```

```bash
npm test                    # server + client unit tests
TEST_REDIS_URL=redis://127.0.0.1:6379 npm test -w server   # also run the Redis round-trip test
```

Requires Node.js ≥ 22.9. **Demo mode** turns on automatically when neither `MEDIA_API_BASE` nor
`SUBSONIC_URL` is set. It serves a small catalog of synthetic 16-bit/44.1 kHz WAV clips through
the same proxy, Range and job code paths, so you can try the UI without a server.

## Zero-DevTools setup (`MEDIA_FRONTEND_URL`)

Set `MEDIA_FRONTEND_URL` to the media site's normal web page (for example
`https://music.example.com`). Then you can leave `SUPABASE_URL`, `SUPABASE_ANON_KEY` and
`MEDIA_API_BASE` blank:

```bash
MEDIA_FRONTEND_URL=https://music.example.com
MEDIA_USER_EMAIL=you@example.com      # optional: omit both for guest mode
MEDIA_USER_PASSWORD=…
```

At startup the server fetches the page once, together with its same-origin `<script>` and
Next.js `/_next/static/…` chunks. It looks for the values every visitor's browser downloads
anyway:

* **Supabase project URL:** `https://<ref>.supabase.co`.
* **Public anon key:** a JWT whose payload has `"role":"anon"`, matched to the project ref. The
  `service_role` keys are ignored. `sb_publishable_…` keys also work.
* **API base URL:** an absolute URL next to keys such as `API_URL`, `NEXT_PUBLIC_API_…` or
  `baseURL`. If nothing is found, the frontend's own origin is used and marked as a guess.

The scan has limits: at most 60 files, 3 MB per file, 20 MB in total, 8 s per request and a 25 s
overall deadline (Heroku must bind `$PORT` within 60 s). It stops as soon as all three values
are found. The results are kept in memory for the lifetime of the dyno. Explicitly set variables
always override discovered ones. `npm run doctor` and the Diagnostics dialog show what was found,
with keys masked, and mark discovered values `(discovered)`. `/api/health` reports
`discovery: off | ok | partial | failed`.

## Check your configuration: `npm run doctor`

```bash
npm run doctor                  # uses web/.env (real env vars win)
npm run doctor -- "daft punk"   # pick the sample search query
```

It walks through the live setup step by step and exits with code 1 if anything fails:

1. **Environment.** Runs the server's own config validation and prints every set variable,
   with secrets masked (`abcd…(32 chars)`, `so***@example.com`). It also warns about demo mode,
   a missing `APP_ACCESS_KEY` and `HOST=127.0.0.1`.
2. **Supabase.** Tries the password grant and the refresh grant (from `MEDIA_REFRESH_TOKEN` or
   from the password grant). On failure it prints the exact HTTP status and the response body,
   with tokens scrubbed, plus a hint for common causes (400 = wrong credentials, 401 = anon key
   from another project).
3. **Sample search.** Shows the raw top-level JSON keys the media server returns, the path where
   `MEDIA_SEARCH_RESULTS_PATH` found the results array, and the keys of the first result. Next to
   those it lists every `MEDIA_FIELD_MAP` field with the path it matched, or `✗` when nothing
   matched, so you can see which mapping to change.
4. **Recommendations.** Checks the Last.fm key (`artist.getsimilar`), ListenBrainz (validates
   `LISTENBRAINZ_TOKEN` when set) and MusicBrainz (with your `MUSICBRAINZ_USER_AGENT`).

In Docker: `docker compose run --rm web node server/dist/doctor.js`.

## Deploy

The image bundles the API server and the built web UI. It runs as the unprivileged `node`
user, listens on `0.0.0.0:8787` and has a `HEALTHCHECK` on `GET /api/health`. That endpoint is
never behind `APP_ACCESS_KEY`, so the healthcheck works with the gate on.

```bash
cd web
cp .env.example .env            # fill in; set APP_ACCESS_KEY for anything internet-facing
docker compose up -d --build    # → http://<host>:8787
docker compose --profile redis up -d --build   # + Redis cache: set REDIS_URL=redis://redis:6379/0
```

* `PUBLISH_PORT=9000 docker compose up -d` changes the host port. Inside the container the
  server always uses 8787.
* `.dockerignore` keeps `.env` and `node_modules` out of the build context. Configuration is
  only read at runtime, via `env_file` or the platform's environment settings.
* **Heroku (smallest setup: 1 Basic or Eco dyno, 512 MiB, no add-ons).** The repo root has a
  `Procfile` (`node --max-old-space-size=256 web/server/dist/index.js`), a `package.json` whose
  `heroku-postbuild` builds `web/` and prunes dev dependencies, and a `.slugignore` that leaves
  the Android sources out. The slug is about 40 MB. The server binds `0.0.0.0:$PORT` when
  `DYNO` is set. It finishes in-flight requests within 25 s of `SIGTERM`, streams audio straight
  through without buffering, and caps the in-memory cache (`MEMORY_CACHE_MAX_ENTRIES`).

  ```bash
  heroku create <app> && heroku buildpacks:set heroku/nodejs -a <app>
  heroku config:set -a <app> APP_ACCESS_KEY=$(openssl rand -hex 16) \
    MEDIA_FRONTEND_URL=https://music.example.com MEDIA_USER_EMAIL=… MEDIA_USER_PASSWORD=…
  git push heroku feature/streaming-api:main
  heroku ps:type web=basic -a <app>        # or eco (sleeps after 30 min idle)
  ```

  Open `https://<app>.herokuapp.com`, unlock with the key, then tap the wrench icon
  (**Diagnostics**) to run the doctor checks from a phone. `GET /api/doctor` with
  `Authorization: Bearer <APP_ACCESS_KEY>` returns the same report as JSON.
* **VPS.** Use the compose file above behind Caddy, nginx or Traefik for TLS, and set
  `TRUST_PROXY=true`.
* **Railway / Render.** Create a Docker service from this repo with root directory `web/`
  (Dockerfile path `web/Dockerfile`), set the variables from `.env.example` in the dashboard,
  and use `/api/health` as the health check path. Both platforms inject `PORT`, which the server
  honours. Keep `HOST=0.0.0.0`.
* **Fly.io.** From `web/`, run `fly launch --no-deploy` (it detects the Dockerfile), set
  `internal_port = 8787` and add an HTTP check on `/api/health` in `fly.toml`. Store secrets with
  `fly secrets set MEDIA_USER_PASSWORD=…`, then run `fly deploy`.

## Android app

The Felicity/80s Android app in this repo can use this server directly. Go to **Preferences →
Library → Streaming server**, enter the base URL (`https://music.example.com` or a LAN address
such as `192.168.1.20:8787`) and, if the server has one, its `APP_ACCESS_KEY`. Then tap
**Test connection**. The key is stored encrypted on the phone and is only sent to that origin,
as `Authorization: Bearer <key>`. Once a server is saved, a **Stream** panel appears on the home
screen with search, Discover/Radio and downloads. For a phone on the same Wi-Fi, run the server
with `HOST=0.0.0.0`.

## How it works

```
browser ──/api/search──────────────▶ ProviderChain ─▶ RemoteMediaProvider ─(Bearer JWT)─▶ media server
        ──/api/tracks/:id/prepare──▶ PrepareTracker   │  (Supabase password/refresh grants, cached)
        ──/api/stream/:id (Range)──▶ stream proxy ────┼─▶ signed R2/CDN URL (never sent to the browser)
        ──/api/recommendations─────▶ engine ──────────┤
                                       │              └─▶ SubsonicProvider (optional fallback)
                                       └─▶ Last.fm · ListenBrainz · MusicBrainz
```

* **Auth (`MEDIA_AUTH_MODE`).** The default is `auto`. It uses the Supabase login below when
  `MEDIA_USER_EMAIL` + `MEDIA_USER_PASSWORD` (or `MEDIA_REFRESH_TOKEN`) are set, and otherwise
  `none`. With `none`, search, job and stream requests go out with no credentials (guest/public
  endpoints), so `MEDIA_API_BASE` alone is enough for live mode. `bearer` sends a fixed
  `MEDIA_BEARER_TOKEN`. With `none` and `bearer` a `401` is final, and the error says which
  variable to set. Tokens only ever live in memory: after a dyno sleeps or restarts, the
  server simply logs in again on the first request.
* **Supabase auth.** `SupabaseAuth` signs in with `POST {SUPABASE_URL}/auth/v1/token?grant_type=password`,
  sending the `apikey` header. It keeps the JWT in memory behind an async lock, so 25 concurrent
  requests cause one grant. It refreshes with `grant_type=refresh_token` 60 s before expiry, both
  on a timer and lazily on each request, and keeps Supabase's rotated refresh tokens. A `401`
  from the media API triggers a refresh and a single replay. If a refresh token is rejected, it
  falls back to the password grant. `MEDIA_REFRESH_TOKEN` seeds the session without needing a
  password.
* **Jobs.** Streaming a track calls `POST {MEDIA_JOB_CREATE_PATH}` with `{"trackId": …}`, then
  polls `{MEDIA_JOB_STATUS_PATH}` every 2 s until the job reports a signed URL:
  * Each request has a 15 s timeout and one retry on a transient 5xx or timeout.
  * Each job has a 45 s cap.
  * At most 2 jobs run at once; the rest queue for up to 30 s.
  * Concurrent plays of the same track share one job.

  Failures come back as clean JSON (`{"error":{"code","message","retryable"}}`):

  | Status | Code | Meaning |
  |---|---|---|
  | 504 | `UPSTREAM_TIMEOUT` / `JOB_TIMEOUT` | the media server or the job ran out of time |
  | 503 | `UPSTREAM_UNAVAILABLE` / `PROVIDER_BUSY` / `UPSTREAM_AUTH_FAILED` | the provider is down, overloaded or rejecting our session |
  | 502 | `JOB_FAILED` / `STREAM_UNAVAILABLE` | the job failed, or the audio host refused the file |
* **Failover.** If the primary times out or is unavailable, search goes to the fallback provider.
  Streams of primary tracks are matched by artist and title against the fallback's library. A
  circuit breaker then routes around the primary for `FALLBACK_COOLDOWN_MS`.
* **Streaming.** `GET /api/stream/:id` is a pass-through proxy:
  * It forwards `Range`/`If-Range` upstream and returns `206`, `Content-Range`, `Accept-Ranges`,
    `Content-Length`, `ETag` and `Last-Modified`, so `<audio>` can seek.
  * It answers `HEAD` with a 1-byte ranged GET, because presigned URLs are GET-only.
  * It aborts the CDN transfer when the browser hangs up.
  * If a cached signed URL has expired (401/403/404/410 from the CDN), it re-resolves once.
  * It rewrites `application/octet-stream` to `audio/flac`.
* **Downloads.** `GET /api/download/:id` streams the same file with
  `Content-Disposition: attachment; filename="Artist - Title.flac"` plus an RFC 5987 `filename*`
  for non-ASCII titles such as Gurmukhi.
* **Caching.** Results are cached in memory, or in Redis when `REDIS_URL` is set:
  * search results: 15 min
  * resolved signed URLs: 6 h, always capped at the URL's own expiry minus 60 s (read from
    `X-Amz-Date`/`X-Amz-Expires`, `Expires` or a job `expiresAt` field)
  * track metadata: 6 h
  * recommendation pools: 1 h

  A Redis outage is treated as a cache miss.
* **Recommendations.** Seeds can be a track, an artist or a genre/regional tag (aliases such as
  `punjabi pop → punjabi, bhangra`). The engine merges and de-duplicates Last.fm similar tracks,
  artists and tag charts with ListenBrainz LB Radio and similarity data. MusicBrainz resolves
  artist MBIDs and tags, rate-limited to 1 request per second. Results are capped at two per
  artist, then each one is searched in your library and marked `playable` or `metadata-only`.
  `POST /api/radio` returns only playable tracks. When exact matches run out, it fills the station
  with library tracks by the recommended artists. It accepts an `exclude` list so the UI can keep a
  station going.
* **Security.** All `SUPABASE_*`, `MEDIA_*`, Subsonic and metadata credentials stay on the server.
  The browser only sees `/api/...` URLs, and logs redact `authorization` and cookie headers. Set
  `APP_ACCESS_KEY` to lock the UI and API behind an HttpOnly, SameSite=Strict cookie. The server
  binds to `127.0.0.1` by default, and the UI ships with a strict CSP.

## API

| Method & path | Purpose |
|---|---|
| `GET /api/health` | providers, circuit state, cache type, enabled recommendation sources |
| `GET /api/search?q=&limit=` | search; track ids look like `remote:123` / `subsonic:abc` |
| `GET /api/tracks/:id` | track metadata |
| `POST /api/tracks/:id/prepare` | start (or join) the upstream job; `202 preparing` or `200 ready` |
| `GET /api/tracks/:id/prepare` | job status: `stage`, `progress`, `elapsedMs`, `servedBy`, `fallback`, `error` |
| `GET, HEAD /api/stream/:id` | Range-aware audio proxy |
| `GET /api/download/:id` | file download with `Content-Disposition` |
| `GET /api/cover/:id` | cover-art proxy for providers whose image URLs carry credentials (Subsonic) |
| `GET /api/recommendations?type=track\|artist\|tag&trackId=&artist=&title=&tag=&limit=` | similar artists, related tracks, tags, source states, warnings |
| `POST /api/radio` `{seed, exclude?, limit?}` | playable radio queue |
| `POST /api/session` `{key}` / `DELETE /api/session` | unlock / lock when `APP_ACCESS_KEY` is set |

## Adapting to your media server

The adapter expects REST endpoints shaped roughly like this, and every part is configurable:

```http
GET  /api/search?q=diljit            → {"results":[{"id":"t1","title":"Lover","artist":{"name":"Diljit Dosanjh"},"durationMs":182000,"format":"FLAC","bitDepth":24,"sampleRate":96000}]}
POST /api/download {"trackId":"t1"}  → {"jobId":"j9","status":"queued"}     (or {"status":"completed","url":"…"} on a cache hit)
GET  /api/jobs/j9                    → {"status":"processing","stage":"uploading","progress":40}
GET  /api/jobs/j9                    → {"status":"completed","url":"https://…r2.cloudflarestorage.com/…&X-Amz-Expires=3600"}
```

**Paths and parameters.**
* Set `MEDIA_SEARCH_PATH`, `MEDIA_SEARCH_PARAM`, `MEDIA_SEARCH_LIMIT_PARAM` and
  `MEDIA_SEARCH_EXTRA_PARAMS` (a query string) for search.
* Set `MEDIA_JOB_CREATE_PATH`, `MEDIA_JOB_CREATE_METHOD`, `MEDIA_TRACK_ID_FIELD` and
  `MEDIA_JOB_EXTRA_BODY` (JSON merged into the body) for job creation.
* `MEDIA_JOB_STATUS_PATH` accepts the placeholders `:jobId`, `:id` and `:trackId`.
* `MEDIA_TRACK_PATH` (`:id`) enables metadata lookups. Without it, metadata comes from cached
  search results.

**JSON field mappings.** A mapping value is a dot path. Array indexes are plain segments, and
`|` separates fallbacks, so the first non-empty one wins:

```bash
MEDIA_SEARCH_RESULTS_PATH='payload.hits'
MEDIA_FIELD_MAP='{"id":"uuid","title":"name","artist":"performer.name|artists","durationSec":"secs","coverUrl":"album.images.0.url"}'
MEDIA_JOB_FIELD_MAP='{"jobId":"task.id","status":"task.state","url":"task.result.signedUrl","expiresAt":"task.result.expiresAt"}'
MEDIA_JOB_SUCCESS_STATES='done,uploaded'
MEDIA_JOB_FAILURE_STATES='failed,cancelled'
```

* **Track fields:** `id`, `title`, `artist`, `album`, `durationSec`, `durationMs`, `coverUrl`,
  `format`, `quality`, `bitDepth`, `sampleRate`, `bitrateKbps`, `year`, `trackNumber`, `isrc`.
  An `artists` array of `{name}` objects is joined as "A, B".
* **Job fields:** `jobId`, `status`, `url`, `progress` (0–1 or 0–100), `stage`, `error`,
  `expiresAt` (ISO, epoch seconds or epoch ms).

Unknown keys are rejected at startup with a clear message. Relative URLs are resolved against
`MEDIA_API_BASE`. With `MEDIA_STREAM_AUTH=auto`, the bearer token is attached only to files
served from that same origin, never to R2 or a CDN.

## Environment variables

`.env.example` lists every variable with its default. The server reads `web/.env`,
`web/server/.env` or `.env` in the working directory; real environment variables take precedence.

### Server

| Variable | Default | Description |
|---|---|---|
| `HOST` | `127.0.0.1` (`0.0.0.0` on Heroku) | bind address (`0.0.0.0` for LAN/Docker) |
| `PORT` | `8787` | HTTP port |
| `LOG_LEVEL` | `info` | pino log level |
| `TRUST_PROXY` | `false` | trust `X-Forwarded-*` from a reverse proxy (Secure cookie over HTTPS) |
| `APP_ACCESS_KEY` | – | lock the player behind this key (≥ 12 chars) |
| `CLIENT_DIST_DIR` | `../client/dist` | built UI to serve |
| `DEMO_MODE` | auto | `true` forces the demo catalog; auto-on when no provider is configured |

### Cache

| Variable | Default | Description |
|---|---|---|
| `REDIS_URL` | – | use Redis instead of the in-memory LRU |
| `MEMORY_CACHE_MAX_ENTRIES` | `1000` | entry cap of the in-memory LRU (keeps a 512 MiB dyno safe) |
| `CACHE_PREFIX` | `80s:` | Redis key prefix |
| `SEARCH_CACHE_TTL_MS` | `900000` | search results (15 min) |
| `STREAM_URL_CACHE_TTL_MS` | `21600000` (`1200000` when auth resolves to `none`) | resolved signed URLs (6 h, or 20 min for short-lived guest links; always capped by URL expiry) |
| `TRACK_CACHE_TTL_MS` | `21600000` | track metadata (6 h) |

### Primary provider and auth

| Variable | Default | Description |
|---|---|---|
| `MEDIA_API_BASE` | – | media server base URL (enables the primary provider, live mode) |
| `MEDIA_FRONTEND_URL` | – | the media site's web page; blank `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `MEDIA_API_BASE` are discovered from its public JS at startup ([details](#zero-devtools-setup-media_frontend_url)) |
| `MEDIA_AUTH_MODE` | `auto` | `auto`: `supabase` when `MEDIA_USER_EMAIL` + `MEDIA_USER_PASSWORD` (or `MEDIA_REFRESH_TOKEN`) are set, else `none` · `supabase`: password/refresh grants · `bearer`: `Authorization: Bearer MEDIA_BEARER_TOKEN` · `none`: no auth header (guest/public API) |
| `MEDIA_BEARER_TOKEN` | – | static token for `MEDIA_AUTH_MODE=bearer` |
| `MEDIA_SEARCH_PATH` | `/api/search` | search endpoint |
| `MEDIA_SEARCH_PARAM` | `q` | query parameter name |
| `MEDIA_SEARCH_LIMIT_PARAM` | – | page-size parameter name |
| `MEDIA_SEARCH_EXTRA_PARAMS` | – | extra query string for search |
| `MEDIA_SEARCH_RESULTS_PATH` | `results\|tracks\|items\|data.results\|data.tracks\|data.items\|data` | where the result array lives |
| `MEDIA_FIELD_MAP` | – | JSON track-field overrides |
| `MEDIA_TRACK_PATH` | – | metadata endpoint (`:id`) |
| `MEDIA_JOB_CREATE_PATH` | `/api/download` | job creation endpoint |
| `MEDIA_JOB_CREATE_METHOD` | `POST` | `POST`, `PUT` or `GET` |
| `MEDIA_TRACK_ID_FIELD` | `trackId` | body/query field for the track id |
| `MEDIA_JOB_EXTRA_BODY` | – | JSON merged into the job body |
| `MEDIA_JOB_STATUS_PATH` | `/api/jobs/:jobId` | job status endpoint |
| `MEDIA_JOB_FIELD_MAP` | – | JSON job-field overrides |
| `MEDIA_JOB_SUCCESS_STATES` | `completed,complete,done,ready,success,succeeded,finished,uploaded` | terminal success states |
| `MEDIA_JOB_FAILURE_STATES` | `failed,failure,error,errored,cancelled,canceled,expired` | terminal failure states |
| `MEDIA_STREAM_AUTH` | `auto` | when to send the bearer token to audio URLs |
| `MEDIA_REQUEST_TIMEOUT_MS` | `15000` | timeout for auth, search and job requests |
| `MEDIA_JOB_POLL_INTERVAL_MS` | `2000` | job poll interval |
| `MEDIA_JOB_MAX_WAIT_MS` | `45000` | job cap → 504 |
| `MEDIA_JOB_RETRIES` | `1` | retries on transient 5xx/timeout |
| `MEDIA_JOB_CONCURRENCY` | `2` | simultaneous jobs |
| `MEDIA_JOB_QUEUE_TIMEOUT_MS` | `30000` | wait for a job slot → 503 |
| `SUPABASE_URL` | – (discovered) | Supabase project URL (Supabase login only) |
| `SUPABASE_ANON_KEY` | – (discovered) | anon key, sent as `apikey` (Supabase login only) |
| `MEDIA_USER_EMAIL` / `MEDIA_USER_PASSWORD` | – | password-grant credentials |
| `MEDIA_REFRESH_TOKEN` | – | seed an existing session |
| `MEDIA_TOKEN_REFRESH_MARGIN_MS` | `60000` | refresh this long before expiry |

### Fallback provider (OpenSubsonic: Navidrome, Gonic, Airsonic…)

| Variable | Default | Description |
|---|---|---|
| `SUBSONIC_URL` | – | server URL (enables the fallback, or the primary when `MEDIA_API_BASE` is unset) |
| `SUBSONIC_API_KEY` | – | OpenSubsonic API key … |
| `SUBSONIC_USER` / `SUBSONIC_PASSWORD` | – | … or salted-token credentials |
| `SUBSONIC_CLIENT` | `80s-web` | client name sent to the server |
| `SUBSONIC_TIMEOUT_MS` | `15000` | request timeout |
| `FALLBACK_COOLDOWN_MS` | `30000` | route around a failed primary for this long |

Streams use `format=raw`, so FLAC stays bit-perfect.

### Recommendations

| Variable | Default | Description |
|---|---|---|
| `LASTFM_API_KEY` | – | enables Last.fm (best similar-track data) |
| `LASTFM_API_BASE` | `https://ws.audioscrobbler.com/2.0` | |
| `LISTENBRAINZ_ENABLED` | `true` | LB Radio and similar artists (works without a token) |
| `LISTENBRAINZ_TOKEN` | – | optional user token (`Authorization: Token …`) |
| `LISTENBRAINZ_API_BASE` | `https://api.listenbrainz.org` | |
| `LISTENBRAINZ_LABS_BASE` | `https://labs.api.listenbrainz.org` | similar-artists dataset |
| `LISTENBRAINZ_SIMILAR_ARTISTS_ALGORITHM` | listenbrainz.org's dataset | override if LB renames it |
| `MUSICBRAINZ_ENABLED` | `true` | MBID and tag lookups (1 req/s) |
| `MUSICBRAINZ_API_BASE` | `https://musicbrainz.org/ws/2` | |
| `MUSICBRAINZ_USER_AGENT` | generic | set `AppName/version ( your-contact )` as MusicBrainz requests |
| `RECOMMENDATION_TIMEOUT_MS` | `8000` | per external request |
| `RECOMMENDATION_MATCH_CONCURRENCY` | `3` | parallel library searches for playable matching |
| `RECOMMENDATION_CACHE_TTL_MS` | `3600000` | candidate-pool cache |

### Development only

| Variable | Description |
|---|---|
| `API_ORIGIN` | API origin the Vite dev server proxies to (default `http://127.0.0.1:8787`) |
| `TEST_REDIS_URL` | run the real-Redis cache test |

## The player

* **Search.** Debounced and abortable instant search shows cover art, artist and album,
  duration, and `LOSSLESS`/`HI-RES` badges. Results support Play all and Queue all.
* **Discover / Radio.** Seed from the current track ("Follow now playing"), any similar artist,
  or the genre chips (Punjabi Pop, Bhangra, Hip-Hop, Indie, Synthwave, 80s…). Related tracks are
  marked playable or *Not in library*; a metadata-only track can be searched for with one click.
* **Player bar.**
  * Play/pause, previous/next, a seek bar with buffered range, volume and mute.
  * A download button and the quality badge (`FLAC 24/96`).
  * A status line for the upstream job ("Preparing lossless stream · uploading 42% · 12s"), with
    Retry and Skip on errors and a badge when the fallback is serving.
* **Queue drawer.** Now playing and Up next, with Play next, Add to queue, Start track radio,
  move up/down, remove and clear. Radio refills itself continuously.
* **Persistence.** Queue, volume, theme and resume position survive reloads. The next track is
  prepared ahead of time.
* **System integration.** The Media Session API supports hardware keys and OS controls.
* **Keyboard shortcuts** (press `?` for the list): `Space`/`K` play, `←`/`→` seek 5 s, `J`/`L` seek
  10 s, `N`/`P` next/previous, `M` mute, `Q` queue, `/` search. On a focused track, `Enter` plays it,
  `Shift+Enter` queues it and `Alt+Enter` plays it next.
