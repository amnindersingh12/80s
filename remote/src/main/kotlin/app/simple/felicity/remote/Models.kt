package app.simple.felicity.remote

/*
 * Kotlin mirror of web/shared/api.d.ts. DTOs are nullable on purpose (Gson ignores
 * Kotlin nullability); `toDomain()` validates and produces the clean public models.
 */

/** A track exposed by the server. [id] is the public `<provider>:<id>` form. */
data class RemoteTrack(
        val id: String,
        val provider: String,
        val title: String,
        val artist: String,
        val album: String? = null,
        val durationSec: Int? = null,
        /** Absolute URL (already resolved against the server), or null. */
        val coverUrl: String? = null,
        val format: String? = null,
        val lossless: Boolean = false,
        val bitDepth: Int? = null,
        val sampleRate: Int? = null,
        val bitrateKbps: Int? = null,
        val year: Int? = null,
        val trackNumber: Int? = null,
        val isrc: String? = null,
        /** Recommendation key (`artist|title`) when the track came from Discover/Radio. */
        val key: String? = null,
        val reason: String? = null,
) {
    /** True for 24-bit and/or > 48 kHz material — drives the HI-RES badge. */
    val isHiRes: Boolean get() = (bitDepth ?: 0) >= 24 || (sampleRate ?: 0) > 48_000

    /** "FLAC 24/96", "WAV 16/44.1", "MP3 320"… */
    val qualityLabel: String
        get() {
            val fmt = (format ?: if (lossless) "lossless" else "").uppercase()
            val bd = bitDepth
            val sr = sampleRate
            if (bd != null && sr != null && bd > 0 && sr > 0) {
                val khz = sr / 1000.0
                val k = if (khz % 1.0 == 0.0) khz.toInt().toString() else String.format(java.util.Locale.US, "%.1f", khz)
                return "$fmt $bd/$k".trim()
            }
            if (!lossless && bitrateKbps != null) return "$fmt $bitrateKbps".trim()
            return fmt.ifEmpty { "AUDIO" }
        }
}

data class SearchResult(val query: String, val tracks: List<RemoteTrack>, val provider: String?, val fallback: Boolean, val cached: Boolean)

data class ProviderHealth(val name: String, val kind: String?, val role: String?, val circuitOpen: Boolean, val lastError: String?)

data class ServerHealth(
        val demo: Boolean,
        val providers: List<ProviderHealth>,
        val recommendationSources: Map<String, Boolean>,
        val cache: String?,
        val accessRequired: Boolean,
        val authenticated: Boolean,
        /** Media-config problems found at boot; non-empty = server fell back to demo mode. */
        val configErrors: List<String> = emptyList(),
) {
    val primary: ProviderHealth? get() = providers.firstOrNull { it.role == "primary" } ?: providers.firstOrNull()
    val fallback: ProviderHealth? get() = providers.firstOrNull { it.role == "fallback" }
}

/** Server-side job state for `/api/tracks/:id/prepare`. */
data class PrepareStatus(
        val id: String,
        /** `idle` | `preparing` | `ready` | `error` */
        val state: String,
        val stage: String? = null,
        /** 0..1 */
        val progress: Float? = null,
        val elapsedMs: Long? = null,
        val servedBy: String? = null,
        val fallback: Boolean = false,
        val error: RemoteError? = null,
)

data class RemoteError(val code: String, val message: String, val retryable: Boolean, val upstreamStatus: Int? = null)

enum class SeedType(val wire: String) { TRACK("track"), ARTIST("artist"), TAG("tag") }

data class RecommendationSeed(
        val type: SeedType,
        val trackId: String? = null,
        val artist: String? = null,
        val title: String? = null,
        val tag: String? = null,
) {
    companion object {
        fun track(t: RemoteTrack) = RecommendationSeed(SeedType.TRACK, trackId = t.id, artist = t.artist, title = t.title)
        fun track(artist: String, title: String) = RecommendationSeed(SeedType.TRACK, artist = artist, title = title)
        fun artist(name: String) = RecommendationSeed(SeedType.ARTIST, artist = name)
        fun tag(tag: String) = RecommendationSeed(SeedType.TAG, tag = tag.lowercase())
    }
}

data class SimilarArtist(val name: String, val mbid: String?, val score: Double, val sources: List<String>, val imageUrl: String?, val playable: Boolean)

data class RecommendedTrack(
        val key: String,
        val title: String,
        val artist: String,
        val album: String?,
        val durationSec: Int?,
        val coverUrl: String?,
        val score: Double,
        val sources: List<String>,
        /** Present only when the track is playable on the server. */
        val track: RemoteTrack?,
        val reason: String?,
) {
    val playable: Boolean get() = track != null
}

data class Recommendations(
        val seedLabel: String,
        val seed: RecommendationSeed,
        val similarArtists: List<SimilarArtist>,
        val relatedTracks: List<RecommendedTrack>,
        val tags: List<String>,
        /** source → ok | error | disabled | skipped */
        val sources: Map<String, String>,
        val warnings: List<String>,
)

data class RadioBatch(val seedLabel: String, val tracks: List<RemoteTrack>, val exhausted: Boolean, val warnings: List<String>)

data class ResolveResult(val track: RemoteTrack, val prepare: PrepareStatus)

// ------------------------------------------------------------------ DTOs ---

internal class TrackDto(
        val id: String? = null, val provider: String? = null, val title: String? = null, val artist: String? = null,
        val album: String? = null, val durationSec: Double? = null, val coverUrl: String? = null, val format: String? = null,
        val lossless: Boolean? = null, val bitDepth: Int? = null, val sampleRate: Int? = null, val bitrateKbps: Int? = null,
        val year: Int? = null, val trackNumber: Int? = null, val isrc: String? = null, val key: String? = null, val reason: String? = null,
)

internal class SearchDto(val query: String? = null, val tracks: List<TrackDto>? = null, val provider: String? = null, val fallback: Boolean? = null, val cached: Boolean? = null)

internal class ProviderDto(val name: String? = null, val kind: String? = null, val role: String? = null, val circuit: String? = null, val lastError: String? = null)

internal class HealthDto(
        val ok: Boolean? = null, val demo: Boolean? = null, val providers: List<ProviderDto>? = null,
        val recommendations: Map<String, Boolean>? = null, val cache: String? = null,
        val accessRequired: Boolean? = null, val authenticated: Boolean? = null,
        val configErrors: List<String>? = null,
)

internal class ErrorDto(val code: String? = null, val message: String? = null, val retryable: Boolean? = null, val upstreamStatus: Int? = null)
internal class ErrorBodyDto(val error: ErrorDto? = null)

internal class PrepareDto(
        val id: String? = null, val state: String? = null, val stage: String? = null, val progress: Double? = null,
        val elapsedMs: Long? = null, val servedBy: String? = null, val fallback: Boolean? = null, val error: ErrorDto? = null,
)

internal class ResolveDto(val track: TrackDto? = null, val prepare: PrepareDto? = null)

internal class SeedDto(val type: String? = null, val trackId: String? = null, val artist: String? = null, val title: String? = null, val tag: String? = null, val label: String? = null)
internal class ArtistDto(val name: String? = null, val mbid: String? = null, val score: Double? = null, val sources: List<String>? = null, val imageUrl: String? = null, val playable: Boolean? = null)
internal class RecTrackDto(
        val key: String? = null, val title: String? = null, val artist: String? = null, val album: String? = null,
        val durationSec: Double? = null, val coverUrl: String? = null, val score: Double? = null, val sources: List<String>? = null,
        val availability: String? = null, val track: TrackDto? = null, val reason: String? = null,
)

internal class RecommendationsDto(
        val seed: SeedDto? = null, val similarArtists: List<ArtistDto>? = null, val relatedTracks: List<RecTrackDto>? = null,
        val tags: List<String>? = null, val sources: Map<String, String>? = null, val warnings: List<String>? = null,
)

internal class RadioDto(val seed: SeedDto? = null, val tracks: List<TrackDto>? = null, val exhausted: Boolean? = null, val warnings: List<String>? = null)

internal fun ErrorDto.toDomain(fallbackStatus: Int): RemoteError = RemoteError(
        code = code ?: "HTTP_$fallbackStatus",
        message = message ?: "Request failed (HTTP $fallbackStatus)",
        retryable = retryable ?: (fallbackStatus >= 500),
        upstreamStatus = upstreamStatus,
)

internal fun TrackDto.toDomain(config: ServerConfig, extraKey: String? = null, extraReason: String? = null): RemoteTrack? {
    val id = id?.takeIf { it.contains(':') } ?: return null
    return RemoteTrack(
            id = id,
            provider = provider ?: id.substringBefore(':'),
            title = title?.takeIf { it.isNotBlank() } ?: "Untitled",
            artist = artist?.takeIf { it.isNotBlank() } ?: "Unknown artist",
            album = album?.takeIf { it.isNotBlank() },
            durationSec = durationSec?.toInt()?.takeIf { it > 0 },
            coverUrl = config.resolve(coverUrl)?.toString(),
            format = format?.lowercase(),
            lossless = lossless ?: false,
            bitDepth = bitDepth?.takeIf { it > 0 },
            sampleRate = sampleRate?.takeIf { it > 0 },
            bitrateKbps = bitrateKbps?.takeIf { it > 0 },
            year = year,
            trackNumber = trackNumber,
            isrc = isrc,
            key = key ?: extraKey,
            reason = reason ?: extraReason,
    )
}

internal fun PrepareDto.toDomain(fallbackId: String, httpStatus: Int): PrepareStatus = PrepareStatus(
        id = id ?: fallbackId,
        state = state ?: "idle",
        stage = stage,
        progress = progress?.toFloat()?.coerceIn(0f, 1f),
        elapsedMs = elapsedMs,
        servedBy = servedBy,
        fallback = fallback ?: false,
        error = error?.toDomain(httpStatus),
)

internal fun SeedDto?.toSeed(fallback: RecommendationSeed): RecommendationSeed {
    if (this == null) return fallback
    val t = SeedType.entries.firstOrNull { it.wire == type } ?: fallback.type
    return RecommendationSeed(t, trackId ?: fallback.trackId, artist ?: fallback.artist, title ?: fallback.title, tag ?: fallback.tag)
}
