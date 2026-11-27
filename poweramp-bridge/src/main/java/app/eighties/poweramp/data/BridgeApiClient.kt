package app.eighties.poweramp.data

import com.google.gson.Gson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

class BridgeApiException(message: String, val statusCode: Int = 0) : IOException(message)

/**
 * Pure-Kotlin HTTP client talking to the `web/` Fastify backend.
 * Enforces strict lossless filtering and handles concurrent stream URL preparation safely.
 */
class BridgeApiClient(
    private val serverUrlProvider: () -> String,
    private val accessKeyProvider: () -> String,
    private val client: OkHttpClient = defaultClient(),
    private val gson: Gson = Gson(),
) {
    private data class CachedPrepared(val value: PreparedStream, val expiresAtMs: Long)

    private val trackLocks = ConcurrentHashMap<String, Any>()
    private val preparedCache = ConcurrentHashMap<String, CachedPrepared>()

    fun resolveAbsoluteUrl(pathOrUrl: String?): String? {
        if (pathOrUrl.isNullOrBlank()) return null
        if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) return pathOrUrl
        val base = serverUrlProvider().trim().trimEnd('/')
        if (base.isEmpty()) return null
        val path = if (pathOrUrl.startsWith("/")) pathOrUrl else "/$pathOrUrl"
        return "$base$path"
    }

    suspend fun health(): HealthStatus = withContext(Dispatchers.IO) {
        val url = endpoint("api", "health")
        val dto = getJson(url, HealthDto::class.java)
        HealthStatus(
            ok = dto.ok == true,
            demo = dto.demo == true,
            cache = dto.cache,
            providers = dto.providers.orEmpty().mapNotNull { p ->
                p.name?.let { "${p.role ?: "provider"}:$it (${p.circuit ?: "unknown"})" }
            },
            accessRequired = dto.accessRequired == true,
            authenticated = dto.authenticated ?: true,
        )
    }

    suspend fun search(query: String, limit: Int = 30): List<LosslessTrack> =
        searchCatalog(query, type = "tracks", limit = limit).tracks

    suspend fun searchCatalog(
        query: String,
        type: String = "all",
        limit: Int = 30,
    ): SearchCatalogResult = withContext(Dispatchers.IO) {
        val httpUrl = endpoint("api", "search").toHttpUrlOrNull()
            ?.newBuilder()
            ?.addQueryParameter("q", query)
            ?.addQueryParameter("type", type)
            ?.addQueryParameter("limit", limit.coerceIn(1, 50).toString())
            ?.build()
            ?: throw BridgeApiException("Invalid server URL")
        val dto = getJson(httpUrl.toString(), SearchDto::class.java)
        val tracks = dto.tracks.orEmpty().mapNotNull { it.toLosslessTrack() }
        val artists = dto.artists.orEmpty().mapNotNull { it.toSummary() }
        val albums = dto.albums.orEmpty().mapNotNull { it.toSummary() }
        val top = dto.topResult?.toTopResult() ?: tracks.firstOrNull()?.let { SearchTopResult.TrackHit(it) }
        SearchCatalogResult(
            query = dto.query ?: query,
            topResult = top,
            tracks = tracks,
            artists = artists,
            albums = albums,
        )
    }

    suspend fun artistDetail(id: String, name: String? = null): ArtistDetail = withContext(Dispatchers.IO) {
        val builder = endpoint("api", "artists", id).toHttpUrlOrNull()?.newBuilder()
            ?: throw BridgeApiException("Invalid server URL")
        name?.takeIf { it.isNotBlank() }?.let { builder.addQueryParameter("name", it) }
        val dto = getJson(builder.build().toString(), ArtistDetailDto::class.java)
        ArtistDetail(
            id = dto.id ?: id,
            name = dto.name ?: name ?: "Unknown Artist",
            imageUrl = resolveAbsoluteUrl(dto.imageUrl),
            bio = dto.bio,
            genres = dto.genres.orEmpty(),
            topTracks = dto.topTracks.orEmpty().mapNotNull { it.toLosslessTrack() },
            albums = dto.albums.orEmpty().mapNotNull { it.toSummary() },
            similarArtists = dto.similarArtists.orEmpty().mapNotNull { s ->
                s.name?.let { ArtistSummary(id = "name:${java.net.URLEncoder.encode(it, "UTF-8")}", name = it, imageUrl = resolveAbsoluteUrl(s.imageUrl)) }
            },
        )
    }

    suspend fun albumDetail(id: String, title: String? = null, artist: String? = null): AlbumDetail = withContext(Dispatchers.IO) {
        val builder = endpoint("api", "albums", id).toHttpUrlOrNull()?.newBuilder()
            ?: throw BridgeApiException("Invalid server URL")
        title?.takeIf { it.isNotBlank() }?.let { builder.addQueryParameter("title", it) }
        artist?.takeIf { it.isNotBlank() }?.let { builder.addQueryParameter("artist", it) }
        val dto = getJson(builder.build().toString(), AlbumDetailDto::class.java)
        val tracks = dto.tracks.orEmpty().mapNotNull { it.toLosslessTrack() }
        AlbumDetail(
            id = dto.id ?: id,
            title = dto.title ?: title ?: "Album",
            artist = dto.artist ?: artist ?: "Unknown Artist",
            artistId = dto.artistId,
            coverUrl = resolveAbsoluteUrl(dto.coverUrl) ?: tracks.firstOrNull()?.artworkUrl,
            year = dto.year,
            trackCount = dto.trackCount ?: tracks.size,
            totalDurationMs = dto.totalDurationMs ?: tracks.sumOf { it.effectiveDurationMs },
            codec = dto.codec ?: "FLAC",
            bitDepth = dto.bitDepth,
            sampleRate = dto.sampleRate,
            qualityTier = dto.qualityTier ?: "LOSSLESS",
            tracks = tracks,
        )
    }

    suspend fun homeFeed(
        genre: String? = null,
        nowPlayingArtist: String? = null,
        nowPlayingTrack: String? = null,
        limit: Int = 24,
    ): HomeFeed = withContext(Dispatchers.IO) {
        val builder = endpoint("api", "home").toHttpUrlOrNull()?.newBuilder()
            ?: throw BridgeApiException("Invalid server URL")
        builder.addQueryParameter("limit", limit.coerceIn(1, 50).toString())
        genre?.takeIf { it.isNotBlank() }?.let { builder.addQueryParameter("genre", it) }
        nowPlayingArtist?.takeIf { it.isNotBlank() }?.let { builder.addQueryParameter("nowPlayingArtist", it) }
        nowPlayingTrack?.takeIf { it.isNotBlank() }?.let { builder.addQueryParameter("nowPlayingTrack", it) }
        val dto = getJson(builder.build().toString(), HomeDto::class.java)
        val tracks = mapHomeRecommendations(dto.relatedTracks.orEmpty(), limit)
        val becauseTracks = mapHomeRecommendations(dto.becauseYouPlayed?.tracks.orEmpty(), 12)
        val featured = dto.featuredTrack?.toLosslessTrack() ?: tracks.firstOrNull { !it.id.startsWith(LosslessTrack.RESOLVE_PREFIX) }
        val albums = dto.albums.orEmpty().mapNotNull { it.toSummary() }
        val artists = dto.similarArtists.orEmpty().mapNotNull { s ->
            s.name?.let {
                ArtistSummary(
                    id = "name:${java.net.URLEncoder.encode(it, "UTF-8")}",
                    name = it,
                    imageUrl = resolveAbsoluteUrl(s.imageUrl),
                )
            }
        }
        HomeFeed(
            genre = dto.genre ?: genre ?: "mixed",
            featuredTrack = featured,
            tracks = tracks,
            becauseYouPlayedLabel = dto.becauseYouPlayed?.label,
            becauseYouPlayed = becauseTracks,
            albums = albums,
            artists = artists,
        )
    }

    suspend fun home(
        genre: String? = null,
        seedArtist: String? = null,
        seedTrack: String? = null,
        limit: Int = 20,
    ): List<LosslessTrack> = withContext(Dispatchers.IO) {
        val builder = endpoint("api", "home").toHttpUrlOrNull()?.newBuilder()
            ?: throw BridgeApiException("Invalid server URL")
        builder.addQueryParameter("limit", limit.coerceIn(1, 50).toString())
        genre?.takeIf { it.isNotBlank() }?.let { builder.addQueryParameter("genre", it) }
        seedArtist?.takeIf { it.isNotBlank() }?.let { builder.addQueryParameter("seedArtist", it) }
        seedTrack?.takeIf { it.isNotBlank() }?.let { builder.addQueryParameter("seedTrack", it) }
        val dto = getJson(builder.build().toString(), HomeDto::class.java)
        mapHomeRecommendations(dto.relatedTracks.orEmpty(), limit)
    }

    private fun mapHomeRecommendations(recs: List<RecTrackDto>, limit: Int): List<LosslessTrack> {
        val playable = mutableListOf<LosslessTrack>()
        val unresolved = mutableListOf<LosslessTrack>()
        for (rec in recs) {
            val t = rec.track?.toLosslessTrack(rec.reason, rec.album, rec.coverUrl ?: rec.artworkUrl)
            if (t != null) {
                playable.add(t)
            } else {
                val title = rec.title?.takeIf { it.isNotBlank() } ?: continue
                val artist = rec.artist?.takeIf { it.isNotBlank() } ?: continue
                unresolved.add(
                    LosslessTrack(
                        id = LosslessTrack.resolveSeedId(artist, title, rec.album),
                        provider = "rec",
                        title = title,
                        artist = artist,
                        album = rec.album,
                        durationSec = rec.durationSec?.toInt(),
                        durationMs = rec.durationMs ?: rec.durationSec?.times(1000.0)?.toLong(),
                        artworkUrl = resolveAbsoluteUrl(rec.artworkUrl ?: rec.coverUrl),
                        codec = "FLAC",
                        qualityTier = "LOSSLESS",
                        reason = rec.reason,
                    ),
                )
            }
        }
        return (playable + unresolved).take(limit)
    }

    suspend fun prepareOrResolve(track: LosslessTrack): PreparedStream = withContext(Dispatchers.IO) {
        prepareOrResolveBlocking(track)
    }

    /**
     * Thread-safe blocking resolution for Poweramp `CALL_GET_URL`.
     * Uses per-track lock + short cache so 2 concurrent crossfade streams work cleanly.
     */
    fun prepareOrResolveBlocking(track: LosslessTrack): PreparedStream {
        val now = System.currentTimeMillis()
        preparedCache[track.id]?.let { cached ->
            if (cached.expiresAtMs > now) return cached.value
        }

        val lock = trackLocks.computeIfAbsent(track.id) { Any() }
        synchronized(lock) {
            val freshNow = System.currentTimeMillis()
            preparedCache[track.id]?.let { cached ->
                if (cached.expiresAtMs > freshNow) return cached.value
            }

            val result = if (track.id.startsWith(LosslessTrack.RESOLVE_PREFIX)) {
                val parts = track.id.removePrefix(LosslessTrack.RESOLVE_PREFIX).split("|")
                val artist = parts.getOrNull(0)?.ifBlank { track.artist } ?: track.artist
                val title = parts.getOrNull(1)?.ifBlank { track.title } ?: track.title
                val album = parts.getOrNull(2)?.takeIf { it.isNotBlank() } ?: track.album
                resolveSync(title, artist, album)
            } else {
                prepareSync(track)
            }

            preparedCache[track.id] = CachedPrepared(result, System.currentTimeMillis() + 45 * 60_000L)
            return result
        }
    }

    fun fetchLyricsBlocking(title: String, artist: String, album: String?, durationSec: Int?): LyricsData? {
        if (title.isBlank() || artist.isBlank()) return null
        val builder = endpoint("api", "lyrics").toHttpUrlOrNull()?.newBuilder() ?: return null
        builder.addQueryParameter("track", title)
        builder.addQueryParameter("artist", artist)
        album?.takeIf { it.isNotBlank() }?.let { builder.addQueryParameter("album", it) }
        durationSec?.takeIf { it > 0 }?.let { builder.addQueryParameter("duration", it.toString()) }
        return runCatching {
            val dto = getJson(builder.build().toString(), LyricsDto::class.java)
            LyricsData(
                syncedLyrics = dto.syncedLyrics?.takeIf { it.isNotBlank() },
                plainLyrics = dto.plainLyrics?.takeIf { it.isNotBlank() },
                instrumental = dto.instrumental == true,
                source = dto.source ?: "none",
            )
        }.getOrNull()
    }

    fun downloadCoverBlocking(coverUrl: String, destFile: File): Boolean {
        val url = resolveAbsoluteUrl(coverUrl) ?: return false
        val reqBuilder = Request.Builder().url(url).get()
        attachAuth(reqBuilder, url)
        return runCatching {
            client.newCall(reqBuilder.build()).execute().use { res ->
                if (!res.isSuccessful) return@use false
                val bytes = res.body.bytes()
                if (bytes.isEmpty()) return@use false
                destFile.parentFile?.mkdirs()
                val tmp = File(destFile.parentFile, "${destFile.name}.tmp")
                tmp.writeBytes(bytes)
                tmp.renameTo(destFile)
                true
            }
        }.getOrDefault(false)
    }

    suspend fun <T> downloadAudioStream(track: LosslessTrack, block: suspend (contentType: String?, contentLength: Long, stream: InputStream) -> T): T =
        withContext(Dispatchers.IO) {
            val prepared = prepareOrResolveBlocking(track)
            val resolvedTrack = prepared.track
            val builder = endpoint("api", "download", resolvedTrack.id).toHttpUrlOrNull()?.newBuilder()
                ?: throw BridgeApiException("Invalid server URL")
            builder.addQueryParameter("artist", resolvedTrack.artist)
            builder.addQueryParameter("title", resolvedTrack.title)
            val url = builder.build().toString()
            val req = Request.Builder().url(url).get().also { attachAuth(it, url) }.build()
            val downloadHttp = client.newBuilder().readTimeout(120, TimeUnit.SECONDS).callTimeout(0, TimeUnit.MILLISECONDS).build()
            downloadHttp.newCall(req).execute().use { res ->
                if (!res.isSuccessful) throw BridgeApiException(extractErrorMessage(res.body.string(), res.code), res.code)
                val ct = res.header("content-type")?.substringBefore(';')?.trim()?.lowercase()
                if (ct != null && ct.contains(Regex("mpeg|mp3|aac|ogg|opus"))) {
                    throw BridgeApiException("Rejected lossy upstream stream ($ct)")
                }
                val len = res.body.contentLength()
                block(res.header("content-type"), len, res.body.byteStream())
            }
        }

    // ------------------------------------------------------------- internals ---

    private fun prepareSync(track: LosslessTrack): PreparedStream {
        val url = endpoint("api", "tracks", track.id, "prepare")
        var dto = postJson(url, emptyMap<String, Any>(), PrepareDto::class.java)
        val deadline = System.currentTimeMillis() + 24_000L
        while (dto.state == "preparing" && System.currentTimeMillis() < deadline) {
            Thread.sleep(600L)
            dto = getJson(url, PrepareDto::class.java)
        }
        if (dto.state == "error") {
            throw BridgeApiException(dto.error?.message ?: "Prepare failed")
        }
        val relOrAbs = dto.signedStreamUrl ?: "/api/stream/${java.net.URLEncoder.encode(track.id, "UTF-8")}"
        val streamUrl = resolveAbsoluteUrl(relOrAbs) ?: throw BridgeApiException("Server URL not configured")
        val enriched = track.copy(
            codec = dto.codec?.uppercase() ?: track.codec,
            bitDepth = dto.bitDepth ?: track.bitDepth,
            sampleRate = dto.sampleRate ?: track.sampleRate,
            bitrateKbps = dto.bitrateKbps ?: track.bitrateKbps,
            fileSize = dto.fileSize ?: track.fileSize,
        )
        return PreparedStream(
            track = enriched,
            signedStreamUrl = streamUrl,
            servedBy = dto.servedBy,
            fallback = dto.fallback == true,
        )
    }

    private fun resolveSync(title: String, artist: String, album: String?): PreparedStream {
        val body = buildMap<String, Any> {
            put("title", title)
            put("artist", artist)
            album?.takeIf { it.isNotBlank() }?.let { put("album", it) }
        }
        val url = endpoint("api", "tracks", "resolve")
        var dto = postJson(url, body, ResolveDto::class.java)
        var resolvedTrack = dto.track?.toLosslessTrack()
            ?: throw BridgeApiException("No lossless FLAC/ALAC stream available for \"$artist - $title\"")

        var prep = dto.prepare
        if (prep?.state == "preparing") {
            return prepareSync(resolvedTrack)
        }
        val rawUrl = dto.signedStreamUrl ?: prep?.signedStreamUrl ?: "/api/stream/${java.net.URLEncoder.encode(resolvedTrack.id, "UTF-8")}"
        val streamUrl = resolveAbsoluteUrl(rawUrl) ?: throw BridgeApiException("Server URL not configured")
        return PreparedStream(
            track = resolvedTrack,
            signedStreamUrl = streamUrl,
            servedBy = prep?.servedBy,
            fallback = prep?.fallback == true,
        )
    }

    private fun endpoint(vararg segments: String): String {
        val base = serverUrlProvider().trim().trimEnd('/')
        if (base.isEmpty()) throw BridgeApiException("Configure Server URL in Settings first")
        val parsed = base.toHttpUrlOrNull() ?: throw BridgeApiException("Invalid server URL: $base")
        val b = parsed.newBuilder()
        for (s in segments) b.addPathSegment(s)
        return b.build().toString()
    }

    private fun attachAuth(builder: Request.Builder, url: String) {
        val key = accessKeyProvider().trim()
        if (key.isEmpty()) return
        val baseOrigin = serverUrlProvider().toHttpUrlOrNull()?.let { "${it.scheme}://${it.host}:${it.port}" }
        val targetOrigin = url.toHttpUrlOrNull()?.let { "${it.scheme}://${it.host}:${it.port}" }
        if (baseOrigin == null || baseOrigin == targetOrigin) {
            builder.header("X-Access-Key", key)
        }
    }

    private fun <T> getJson(url: String, clazz: Class<T>): T {
        val req = Request.Builder().url(url).get().also { attachAuth(it, url) }.build()
        return executeJson(req, clazz)
    }

    private fun <T> postJson(url: String, payload: Any, clazz: Class<T>): T {
        val body = gson.toJson(payload).toRequestBody("application/json; charset=utf-8".toMediaType())
        val req = Request.Builder().url(url).post(body).also { attachAuth(it, url) }.build()
        return executeJson(req, clazz)
    }

    private fun <T> executeJson(req: Request, clazz: Class<T>): T {
        client.newCall(req).execute().use { res ->
            val raw = res.body.string()
            if (!res.isSuccessful) {
                throw BridgeApiException(extractErrorMessage(raw, res.code), res.code)
            }
            return gson.fromJson(raw, clazz)
                ?: throw BridgeApiException("Empty JSON response (${res.code})", res.code)
        }
    }

    private fun extractErrorMessage(raw: String, code: Int): String {
        return runCatching {
            gson.fromJson(raw, ErrorBodyDto::class.java)?.error?.message
        }.getOrNull()?.takeIf { it.isNotBlank() } ?: "HTTP $code"
    }

    private fun TrackDto.toLosslessTrack(
        fallbackReason: String? = null,
        fallbackAlbum: String? = null,
        fallbackCover: String? = null,
    ): LosslessTrack? {
        val trackId = id?.takeIf { it.isNotBlank() } ?: return null
        val fmt = format?.lowercase()
        val c = (codec ?: if (fmt == "alac" || fmt == "m4a") "ALAC" else "FLAC").uppercase()
        if (lossless == false || c !in setOf("FLAC", "ALAC", "WAV")) return null
        if (fmt != null && fmt !in setOf("flac", "alac", "wav", "wave", "aiff", "aif", "m4a")) return null
        val durMs = durationMs ?: durationSec?.let { Math.round(it * 1000.0) }
        val durSec = durationSec?.toInt() ?: durMs?.let { (it / 1000L).toInt() }
        return LosslessTrack(
            id = trackId,
            provider = provider ?: trackId.substringBefore(':', "remote"),
            title = title?.takeIf { it.isNotBlank() } ?: "Untitled",
            artist = artist?.takeIf { it.isNotBlank() } ?: "Unknown Artist",
            artistId = artistId?.takeIf { it.isNotBlank() },
            albumArtist = albumArtist?.takeIf { it.isNotBlank() },
            album = album ?: fallbackAlbum,
            albumId = albumId?.takeIf { it.isNotBlank() },
            year = year,
            trackNumber = trackNumber,
            durationSec = durSec,
            durationMs = durMs,
            artworkUrl = resolveAbsoluteUrl(artworkUrl ?: coverUrl ?: fallbackCover),
            codec = c,
            bitDepth = bitDepth,
            sampleRate = sampleRate,
            bitrateKbps = bitrateKbps,
            fileSize = fileSize,
            qualityTier = qualityTier ?: if ((bitDepth ?: 0) > 16 || (sampleRate ?: 0) > 48_000) "HI-RES LOSSLESS" else "LOSSLESS",
            reason = reason ?: fallbackReason,
        )
    }

        private fun ArtistDto.toSummary(): ArtistSummary? {
        val rawName = name?.takeIf { it.isNotBlank() } ?: return null
        val rawId = id?.takeIf { it.isNotBlank() } ?: "name:${java.net.URLEncoder.encode(rawName, "UTF-8")}"
        return ArtistSummary(
            id = rawId,
            name = rawName,
            imageUrl = resolveAbsoluteUrl(imageUrl),
            genres = genres.orEmpty(),
        )
    }

    private fun AlbumDto.toSummary(): AlbumSummary? {
        val rawTitle = title?.takeIf { it.isNotBlank() } ?: return null
        val rawId = id?.takeIf { it.isNotBlank() } ?: return null
        return AlbumSummary(
            id = rawId,
            title = rawTitle,
            artist = artist ?: "Unknown Artist",
            artistId = artistId,
            coverUrl = resolveAbsoluteUrl(coverUrl),
            year = year,
            trackCount = trackCount,
            qualityTier = qualityTier ?: "LOSSLESS",
        )
    }

    private fun TopResultDto.toTopResult(): SearchTopResult? {
        val rawItem = item ?: return null
        return when (kind?.lowercase()) {
            "artist" -> gson.fromJson(gson.toJsonTree(rawItem), ArtistDto::class.java)?.toSummary()?.let { SearchTopResult.ArtistHit(it) }
            "album" -> gson.fromJson(gson.toJsonTree(rawItem), AlbumDto::class.java)?.toSummary()?.let { SearchTopResult.AlbumHit(it) }
            else -> gson.fromJson(gson.toJsonTree(rawItem), TrackDto::class.java)?.toLosslessTrack()?.let { SearchTopResult.TrackHit(it) }
        }
    }

    companion object {
        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(25, TimeUnit.SECONDS)
            .writeTimeout(15, TimeUnit.SECONDS)
            .build()
    }
}

// ------------------------------------------------------------------ DTOs ---

internal class TrackDto(
    val id: String? = null,
    val provider: String? = null,
    val title: String? = null,
    val artist: String? = null,
    val artistId: String? = null,
    val albumArtist: String? = null,
    val album: String? = null,
    val albumId: String? = null,
    val durationSec: Double? = null,
    val durationMs: Long? = null,
    val coverUrl: String? = null,
    val artworkUrl: String? = null,
    val format: String? = null,
    val codec: String? = null,
    val lossless: Boolean? = null,
    val qualityTier: String? = null,
    val bitDepth: Int? = null,
    val sampleRate: Int? = null,
    val bitrateKbps: Int? = null,
    val fileSize: Long? = null,
    val year: Int? = null,
    val trackNumber: Int? = null,
    val reason: String? = null,
)

internal class ArtistDto(
    val id: String? = null,
    val name: String? = null,
    val imageUrl: String? = null,
    val genres: List<String>? = null,
)

internal class AlbumDto(
    val id: String? = null,
    val title: String? = null,
    val artist: String? = null,
    val artistId: String? = null,
    val coverUrl: String? = null,
    val year: Int? = null,
    val trackCount: Int? = null,
    val qualityTier: String? = null,
)

internal class TopResultDto(
    val kind: String? = null,
    val item: Map<String, Any?>? = null,
)

internal class SearchDto(
    val query: String? = null,
    val topResult: TopResultDto? = null,
    val tracks: List<TrackDto>? = null,
    val artists: List<ArtistDto>? = null,
    val albums: List<AlbumDto>? = null,
)

internal class SimilarArtistDto(val name: String? = null, val imageUrl: String? = null)

internal class ArtistDetailDto(
    val id: String? = null,
    val name: String? = null,
    val imageUrl: String? = null,
    val bio: String? = null,
    val genres: List<String>? = null,
    val topTracks: List<TrackDto>? = null,
    val albums: List<AlbumDto>? = null,
    val similarArtists: List<SimilarArtistDto>? = null,
)

internal class AlbumDetailDto(
    val id: String? = null,
    val title: String? = null,
    val artist: String? = null,
    val artistId: String? = null,
    val coverUrl: String? = null,
    val year: Int? = null,
    val trackCount: Int? = null,
    val totalDurationMs: Long? = null,
    val codec: String? = null,
    val bitDepth: Int? = null,
    val sampleRate: Int? = null,
    val qualityTier: String? = null,
    val tracks: List<TrackDto>? = null,
)

internal class BecauseYouPlayedDto(
    val label: String? = null,
    val tracks: List<RecTrackDto>? = null,
)

internal class RecTrackDto(
    val title: String? = null,
    val artist: String? = null,
    val album: String? = null,
    val durationSec: Double? = null,
    val durationMs: Long? = null,
    val coverUrl: String? = null,
    val artworkUrl: String? = null,
    val track: TrackDto? = null,
    val reason: String? = null,
)

internal class HomeDto(
    val genre: String? = null,
    val featuredTrack: TrackDto? = null,
    val relatedTracks: List<RecTrackDto>? = null,
    val becauseYouPlayed: BecauseYouPlayedDto? = null,
    val albums: List<AlbumDto>? = null,
    val similarArtists: List<SimilarArtistDto>? = null,
)

internal class ErrorDto(val message: String? = null)
internal class ErrorBodyDto(val error: ErrorDto? = null)

internal class PrepareDto(
    val id: String? = null,
    val state: String? = null,
    val servedBy: String? = null,
    val fallback: Boolean? = null,
    val signedStreamUrl: String? = null,
    val fileSize: Long? = null,
    val codec: String? = null,
    val bitDepth: Int? = null,
    val sampleRate: Int? = null,
    val bitrateKbps: Int? = null,
    val error: ErrorDto? = null,
)

internal class ResolveDto(
    val track: TrackDto? = null,
    val prepare: PrepareDto? = null,
    val signedStreamUrl: String? = null,
)

internal class LyricsDto(
    val syncedLyrics: String? = null,
    val plainLyrics: String? = null,
    val instrumental: Boolean? = null,
    val source: String? = null,
)

internal class ProviderHealthDto(val name: String? = null, val role: String? = null, val circuit: String? = null)
internal class HealthDto(
    val ok: Boolean? = null,
    val demo: Boolean? = null,
    val cache: String? = null,
    val providers: List<ProviderHealthDto>? = null,
    val accessRequired: Boolean? = null,
    val authenticated: Boolean? = null,
)
