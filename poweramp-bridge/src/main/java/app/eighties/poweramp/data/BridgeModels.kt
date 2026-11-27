package app.eighties.poweramp.data

import java.util.Locale

data class LosslessTrack(
    val id: String,
    val provider: String,
    val title: String,
    val artist: String,
    val album: String? = null,
    val year: Int? = null,
    val trackNumber: Int? = null,
    val durationSec: Int? = null,
    val durationMs: Long? = null,
    val artworkUrl: String? = null,
    val codec: String = "FLAC",
    val bitDepth: Int? = null,
    val sampleRate: Int? = null,
    val bitrateKbps: Int? = null,
    val fileSize: Long? = null,
    val qualityTier: String = "LOSSLESS",
    val genre: String? = null,
    val reason: String? = null,
) {
    val isHiRes: Boolean
        get() = (bitDepth ?: 0) >= 24 || (sampleRate ?: 0) > 48_000 || qualityTier.contains("HI-RES", ignoreCase = true)

    val effectiveDurationMs: Long
        get() = durationMs?.takeIf { it > 0 }
            ?: durationSec?.takeIf { it > 0 }?.times(1000L)
            ?: 210_000L

    val mimeType: String
        get() = if (codec.equals("ALAC", ignoreCase = true)) "audio/mp4" else "audio/flac"

    val fileExtension: String
        get() = if (codec.equals("ALAC", ignoreCase = true)) "m4a" else "flac"

    val displayFilename: String
        get() = "$artist - $title.$fileExtension".replace(Regex("[\\\\/:*?\"<>|]"), "_")

    val badgeText: String
        get() {
            val specs = if (bitDepth != null && sampleRate != null && bitDepth > 0 && sampleRate > 0) {
                val khz = sampleRate / 1000.0
                val sr = if (khz % 1.0 == 0.0) "${khz.toInt()}" else String.format(Locale.US, "%.1f", khz)
                "${bitDepth}-bit/${sr}kHz"
            } else null
            return when {
                isHiRes && specs != null -> "HI-RES · $specs"
                isHiRes -> "HI-RES · $codec"
                specs != null -> "$codec · $specs"
                else -> codec
            }
        }

    companion object {
        const val RESOLVE_PREFIX = "resolve:"

        fun resolveSeedId(artist: String, title: String, album: String?): String =
            "$RESOLVE_PREFIX${artist.trim()}|${title.trim()}|${album?.trim().orEmpty()}"
    }
}

data class PreparedStream(
    val track: LosslessTrack,
    val signedStreamUrl: String,
    val servedBy: String?,
    val fallback: Boolean,
)

data class LyricsData(
    val syncedLyrics: String?,
    val plainLyrics: String?,
    val instrumental: Boolean,
    val source: String,
)

data class HealthStatus(
    val ok: Boolean,
    val demo: Boolean,
    val cache: String?,
    val providers: List<String>,
    val accessRequired: Boolean,
    val authenticated: Boolean,
)
