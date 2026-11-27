package app.eighties.poweramp.poweramp

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import app.eighties.poweramp.data.BridgeAppGraph
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Receives Poweramp's `TRACK_CHANGED`, `TRACK_CHANGED_EXPLICIT`, and `STATUS_CHANGED`
 * broadcasts, updates [PowerampStateMonitor], and refreshes the `Radio (Based on Now Playing)` folder.
 */
class PowerampTrackReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        PowerampStateMonitor.onBroadcast(context, intent)

        val action = intent.action
        if (action != PowerampContract.ACTION_TRACK_CHANGED &&
            action != PowerampContract.ACTION_TRACK_CHANGED_EXPLICIT
        ) {
            return
        }
        val trackBundle = intent.getBundleExtra(PowerampContract.EXTRA_TRACK) ?: return
        val title = trackBundle.getString(PowerampContract.TRACK_TITLE)?.trim().orEmpty()
        val artist = trackBundle.getString(PowerampContract.TRACK_ARTIST)?.trim().orEmpty()
        if (title.isBlank() || artist.isBlank() || artist.equals("Unknown artist", ignoreCase = true)) return

        val prefs = BridgeAppGraph.prefs(context)
        if (prefs.serverUrl.isBlank()) return
        val seedKey = "${artist.lowercase()}|${title.lowercase()}"
        val now = System.currentTimeMillis()
        if (seedKey == prefs.lastRadioSeedKey && now - prefs.lastRadioUpdatedAt < 30_000L) {
            return
        }
        prefs.lastRadioSeedKey = seedKey
        prefs.lastRadioUpdatedAt = now

        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                withTimeoutOrNull(12_000L) {
                    BridgeAppGraph.syncManager(context).syncRadioFromTrack(artist, title)
                }
            } catch (t: Throwable) {
                Log.w(TAG, "Radio refresh failed: ${t.message}")
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        private const val TAG = "PowerampTrackReceiver"
    }
}
