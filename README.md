# 80s

**80s** is a self-hosted **Hi-Res Lossless (FLAC / ALAC) streaming server** paired with a lightweight **Android Poweramp Track Provider plugin** (`poweramp-bridge/`) and a responsive web player (`web/`). It lets **Poweramp** handle 100% of 32-bit Hi-Res decoding, DSP, LDAC/USB DAC output, and playback while sourcing lossless audio and multi-genre recommendations dynamically from your server.

---

## Architecture

| Component | Purpose | Tech |
|---|---|---|
| [`poweramp-bridge/`](poweramp-bridge/) | Lightweight Poweramp Track Provider (`DocumentsProvider`) + Search Launcher + 4×1 Home Screen Search Widget (no built-in audio engine, no NDK) | Pure Kotlin, OkHttp, Coroutines, SQLite, Material 3 |
| [`web/`](web/) | Self-hosted lossless proxy, strict FLAC/ALAC verification, short-lived signed stream URLs (`?st=`), multi-genre discovery, LRCLIB synced lyrics | Fastify (Node 24), TypeScript, React/Vite, Redis |
| Legacy Felicity modules (`music/`, `engine/`, `remote/`, etc.) | Upstream full Android player & Felicity DSP/audio engine codebase | Kotlin, Media3, Hilt, C++/Oboe |

---

## Key Features

### 1. Strict Lossless-Only Backend (`web/`)
- **FLAC / ALAC Only**: Inspects upstream `Content-Type` headers, FLAC `STREAMINFO` headers (extracting real bit depth & sample rate), and magic bytes (`fLaC` / `ftyp` ALAC). Rejects lossy MP3/AAC/Opus/Ogg streams automatically and fails over across `PROVIDER_ORDER` (`hifi,remote`).
- **Poweramp-Ready Signed Stream URLs**: `POST /api/tracks/:id/prepare` and `POST /api/tracks/resolve` return short-lived HMAC-SHA256 `?st=<exp>.<sig>` stream URLs (1h TTL) scoped strictly to `GET`/`HEAD /api/stream/:id`, passing raw lossless bytes with `206 Partial Content`, `Accept-Ranges: bytes`, exact `Content-Length`, and concurrent pre-buffering for Poweramp crossfade/gapless transitions.
- **Global & Multi-Genre Discovery**: Supports `mixed` (default), `pop`, `hip-hop`, `rock`, `indie`, `electronic`, `rnb`, `jazz`, `punjabi`, `bollywood`, custom tags, and artist/track seeds via Last.fm, ListenBrainz, and MusicBrainz.
- **Synced & Plain Lyrics**: `GET /api/lyrics` queries LRCLIB (`/api/get` with `/api/search` fallback) with an in-memory cache.

### 2. Poweramp Bridge Plugin (`poweramp-bridge/`)
- **Native Poweramp Track Provider (`DocumentsProvider`)**: Exposes virtual SQLite-cached folders inside Poweramp (`For You (Mixed)`, `Western/{Pop, Hip-Hop & Rap, Rock & Indie, Electronic, R&B & Soul}`, `Punjabi & Desi`, `Radio (Based on Now Playing)`, and `Recent Searches`) using Poweramp Dynamic URL tracks (`__dynamic_url` / `CALL_GET_URL`) and empty `track_wave` bytes so remote FLACs are never pre-downloaded during scans.
- **Auto-Updating Now Playing Radio**: Listens to Poweramp `TRACK_CHANGED` broadcasts and automatically refreshes `Radio (Based on Now Playing)` with similar lossless tracks.
- **2-Tab Search & Download Companion + 4×1 Widget**: Search worldwide, filter by genre, tap to stream lossless FLAC straight into Poweramp (`OPEN_TO_PLAY`), or download FLACs directly into `Music/80s FLAC` (or a chosen SAF folder) for offline Poweramp playback.

---

## Quick Setup (Poweramp + Server)

### A. Deploy `web/` to Heroku
```bash
heroku create your-80s-server
heroku addons:create heroku-redis:mini -a your-80s-server
heroku config:set APP_ACCESS_KEY="$(openssl rand -hex 16)" PROVIDER_ORDER="hifi,remote" HIFI_API_INSTANCES="https://tracks.monochrome.st" -a your-80s-server
git push heroku main
```

### B. Connect `80s for Poweramp` APK
1. Download **`80s-poweramp-bridge.apk`** from the repository's **GitHub Actions** (`80s Poweramp Bridge APK` workflow).
2. Open **80s for Poweramp → Settings**, enter your **Server URL** and **APP_ACCESS_KEY**, tap **Test Connection**, and pick your preferred genres.
3. Tap **Refresh Poweramp**, then **Open Poweramp Music Folders** (or go to Poweramp **Settings → Library → Music Folders → `+`**) and add **80s Hi-Res Lossless**.

---

## Development & Tests

```bash
# Web server & client typecheck, tests, build
npm --prefix web run typecheck
npm --prefix web test
npm --prefix web run build

# Poweramp bridge unit tests & APK build
./gradlew -p poweramp-bridge testDebugUnitTest assembleDebug
```

---

## Credits & License
- Built atop and includes legacy Android modules from **[Felicity](https://github.com/Hamza417/Felicity)** by Hamza417 (GPL/AGPL-3.0).
- Poweramp integration uses the official **[PowerampAPI](https://github.com/maxmpz/powerampapi)** Track Provider (`DocumentsProvider`) specification by Max Petrov.
