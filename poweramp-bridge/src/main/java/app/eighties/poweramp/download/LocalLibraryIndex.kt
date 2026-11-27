package app.eighties.poweramp.download

import android.content.ContentUris
import android.content.Context
import android.net.Uri
import android.provider.MediaStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap

/**
 * Indexes locally saved FLAC/ALAC files from Android MediaStore so Search/Discover/Album views
 * show an offline checkmark badge and play local files directly in Poweramp.
 */
class LocalLibraryIndex(private val context: Context) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val localTracks = ConcurrentHashMap<String, Uri>()
    private val _version = MutableStateFlow(0)
    val version: StateFlow<Int> = _version

    fun refreshAsync() {
        scope.launch { refreshBlocking() }
    }

    fun refreshBlocking() {
        val resolver = context.contentResolver
        val found = HashMap<String, Uri>()
        val projection = arrayOf(
            MediaStore.Audio.Media._ID,
            MediaStore.Audio.Media.TITLE,
            MediaStore.Audio.Media.ARTIST,
            MediaStore.Audio.Media.MIME_TYPE,
        )
        runCatching {
            resolver.query(
                MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
                projection,
                "${MediaStore.Audio.Media.IS_MUSIC} != 0",
                null,
                null,
            )?.use { cursor ->
                val idCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media._ID)
                val titleCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.TITLE)
                val artistCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.ARTIST)
                while (cursor.moveToNext()) {
                    val id = cursor.getLong(idCol)
                    val title = cursor.getString(titleCol).orEmpty()
                    val artist = cursor.getString(artistCol).orEmpty()
                    val key = normalizeKey(artist, title)
                    if (key.isNotEmpty()) {
                        found[key] = ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, id)
                    }
                }
            }
        }
        localTracks.clear()
        localTracks.putAll(found)
        _version.value++
    }

    fun markDownloaded(artist: String, title: String, uri: Uri?) {
        val key = normalizeKey(artist, title)
        if (key.isNotEmpty()) {
            localTracks[key] = uri ?: Uri.EMPTY
            _version.value++
        }
    }

    fun findLocalUri(artist: String, title: String): Uri? {
        val uri = localTracks[normalizeKey(artist, title)] ?: return null
        return if (uri == Uri.EMPTY) null else uri
    }

    fun isDownloaded(artist: String, title: String): Boolean =
        localTracks.containsKey(normalizeKey(artist, title))

    private fun normalizeKey(artist: String, title: String): String {
        val a = artist.lowercase().replace(Regex("[^a-z0-9]+"), " ").trim()
        val t = title.lowercase().replace(Regex("[^a-z0-9]+"), " ").trim()
        return if (a.isBlank() || t.isBlank()) "" else "$a|$t"
    }
}
