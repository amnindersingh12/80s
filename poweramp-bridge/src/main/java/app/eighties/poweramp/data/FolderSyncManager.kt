package app.eighties.poweramp.data

import android.content.Context
import android.util.Log
import app.eighties.poweramp.poweramp.PowerampHelper
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull

class FolderSyncManager(
    private val context: Context,
    private val prefs: BridgePrefs,
    private val db: BridgeDatabase,
    private val api: BridgeApiClient,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    fun refreshAllAsync(triggerPowerampScan: Boolean = true) {
        scope.launch {
            runCatching { refreshAllInternal(triggerPowerampScan) }
                .onFailure { Log.w(TAG, "refreshAllAsync failed: ${it.message}") }
        }
    }

    suspend fun refreshAll(): Int = refreshAllInternal(triggerPowerampScan = true)

    fun syncSingleFolderBlocking(folderId: String) {
        if (prefs.serverUrl.isBlank()) return
        runBlocking {
            withTimeoutOrNull(6_000L) {
                runCatching { syncFolder(folderId) }
            }
        }
    }

    suspend fun syncRadioFromTrack(artist: String, title: String) {
        if (prefs.serverUrl.isBlank() || artist.isBlank() || title.isBlank()) return
        val tracks = api.home(seedArtist = artist, seedTrack = title, limit = 20)
        if (tracks.isNotEmpty()) {
            db.replaceFolderTracks(BridgeDatabase.FOLDER_RADIO, tracks, genreLabel = "Radio: $artist")
            PowerampHelper.triggerRescan(context, BridgeDatabase.FOLDER_RADIO, fromUi = false)
        }
    }

    private suspend fun refreshAllInternal(triggerPowerampScan: Boolean): Int {
        if (prefs.serverUrl.isBlank()) return 0
        db.ensureDefaultFolders()
        val tasks = BridgeDatabase.FOLDER_GENRES.keys.map { folderId ->
            scope.async { runCatching { syncFolder(folderId) }.getOrDefault(0) }
        }
        val counts = tasks.awaitAll().sum()
        if (triggerPowerampScan) {
            PowerampHelper.triggerRescan(context, null, fromUi = false)
        }
        return counts
    }

    private suspend fun syncFolder(folderId: String): Int {
        if (folderId == BridgeDatabase.FOLDER_FOR_YOU) {
            val mixed = api.home(genre = "mixed", limit = 20)
            val customGenres = prefs.preferredGenres.filter { it != "mixed" }.take(2)
            val extras = if (customGenres.isNotEmpty()) {
                customGenres.flatMap { g -> runCatching { api.home(genre = g, limit = 8) }.getOrDefault(emptyList()) }
            } else emptyList()
            val merged = (mixed + extras).distinctBy { "${it.artist.lowercase()}|${it.title.lowercase()}" }.take(25)
            if (merged.isNotEmpty()) {
                db.replaceFolderTracks(folderId, merged, genreLabel = "Mixed")
            }
            return merged.size
        }
        val (genreTag, displayGenre) = BridgeDatabase.FOLDER_GENRES[folderId] ?: return 0
        val tracks = api.home(genre = genreTag, limit = 20)
        if (tracks.isNotEmpty()) {
            db.replaceFolderTracks(folderId, tracks, genreLabel = displayGenre)
        }
        return tracks.size
    }

    companion object {
        private const val TAG = "FolderSyncManager"
    }
}
