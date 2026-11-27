package app.eighties.poweramp.poweramp

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import app.eighties.poweramp.data.BridgeAppGraph
import app.eighties.poweramp.data.LosslessTrack
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

data class PowerampNowPlaying(
    val title: String = "",
    val artist: String = "",
    val album: String? = null,
    val durationSec: Int = 0,
    val positionSec: Int = 0,
    val paused: Boolean = true,
    val track: LosslessTrack? = null,
) {
    val hasTrack: Boolean get() = title.isNotBlank() && artist.isNotBlank()
}

/**
 * Shared live mirror of Poweramp's active playback state driven by
 * `TRACK_CHANGED`, `STATUS_CHANGED`, sticky broadcasts, and user actions in the bridge app.
 */
object PowerampStateMonitor {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val _state = MutableStateFlow(PowerampNowPlaying())
    val state: StateFlow<PowerampNowPlaying> = _state
    private var lastMetadataKey: String? = null

    fun setOptimisticPlaying(context: Context, track: LosslessTrack) {
        lastMetadataKey = "${track.artist.lowercase()}|${track.title.lowercase()}"
        _state.value = PowerampNowPlaying(
            title = track.title,
            artist = track.artist,
            album = track.album,
            durationSec = (track.effectiveDurationMs / 1000L).toInt(),
            positionSec = 0,
            paused = false,
            track = track,
        )
        context.applicationContext
    }

    fun readStickyState(context: Context) {
        val ctx = context.applicationContext
        runCatching {
            ctx.registerReceiver(null, IntentFilter(PowerampContract.ACTION_TRACK_CHANGED))
        }.getOrNull()?.let { onBroadcast(ctx, it) }
        runCatching {
            ctx.registerReceiver(null, IntentFilter(PowerampContract.ACTION_STATUS_CHANGED))
        }.getOrNull()?.let { onBroadcast(ctx, it) }
    }

    fun onBroadcast(context: Context, intent: Intent) {
        when (intent.action) {
            PowerampContract.ACTION_TRACK_CHANGED,
            PowerampContract.ACTION_TRACK_CHANGED_EXPLICIT,
            -> {
                val trackBundle = intent.getBundleExtra(PowerampContract.EXTRA_TRACK) ?: return
                val title = trackBundle.getString(PowerampContract.TRACK_TITLE)?.trim().orEmpty()
                val artist = trackBundle.getString(PowerampContract.TRACK_ARTIST)?.trim().orEmpty()
                if (title.isBlank() || artist.isBlank() || artist.equals("Unknown artist", ignoreCase = true)) return
                val album = trackBundle.getString(PowerampContract.TRACK_ALBUM)?.trim()?.takeIf { it.isNotBlank() }
                val durSec = trackBundle.getInt("dur", 0)
                val prev = _state.value
                val sameTrack = prev.title.equals(title, ignoreCase = true) && prev.artist.equals(artist, ignoreCase = true)
                val nextTrack = if (sameTrack) prev.track else null
                _state.value = prev.copy(
                    title = title,
                    artist = artist,
                    album = album ?: prev.album,
                    durationSec = if (durSec > 0) durSec else prev.durationSec,
                    track = nextTrack,
                )
                enrichTrackIfNeeded(context, artist, title, album)
            }

            PowerampContract.ACTION_STATUS_CHANGED -> {
                val paused = intent.getBooleanExtra(PowerampContract.EXTRA_PAUSED, _state.value.paused)
                val posSec = intent.getIntExtra(PowerampContract.EXTRA_POSITION, -1)
                _state.value = _state.value.copy(
                    paused = paused,
                    positionSec = if (posSec >= 0) posSec else _state.value.positionSec,
                )
            }
        }
    }

    private fun enrichTrackIfNeeded(context: Context, artist: String, title: String, album: String?) {
        val key = "${artist.lowercase()}|${title.lowercase()}"
        if (key == lastMetadataKey && _state.value.track != null) return
        lastMetadataKey = key
        scope.launch {
            val hit = runCatching {
                BridgeAppGraph.api(context).search("$artist $title", limit = 3)
                    .firstOrNull { it.title.equals(title, ignoreCase = true) }
                    ?: BridgeAppGraph.api(context).search("$artist $title", limit = 1).firstOrNull()
            }.getOrNull()
            val cur = _state.value
            if (cur.artist.equals(artist, ignoreCase = true) && cur.title.equals(title, ignoreCase = true)) {
                _state.value = cur.copy(
                    track = hit ?: cur.track ?: LosslessTrack(
                        id = LosslessTrack.resolveSeedId(artist, title, album),
                        provider = "poweramp",
                        title = title,
                        artist = artist,
                        album = album,
                        durationSec = cur.durationSec.takeIf { it > 0 },
                    ),
                )
            }
        }
    }
}
