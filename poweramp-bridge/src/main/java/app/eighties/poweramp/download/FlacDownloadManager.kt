package app.eighties.poweramp.download

import android.content.ContentValues
import android.content.Context
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.documentfile.provider.DocumentFile
import app.eighties.poweramp.data.BridgeApiClient
import app.eighties.poweramp.data.BridgeApiException
import app.eighties.poweramp.data.BridgeAppGraph
import app.eighties.poweramp.data.BridgePrefs
import app.eighties.poweramp.data.LosslessTrack
import app.eighties.poweramp.poweramp.PowerampHelper
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream

class FlacDownloadManager(
    private val context: Context,
    private val prefs: BridgePrefs,
    private val api: BridgeApiClient,
) {
    suspend fun downloadToLibrary(track: LosslessTrack): String = withContext(Dispatchers.IO) {
        val treeUriStr = prefs.downloadTreeUri
        if (treeUriStr != null) {
            val treeUri = Uri.parse(treeUriStr)
            val dir = DocumentFile.fromTreeUri(context, treeUri)
            if (dir != null && dir.canWrite()) {
                val targetName = track.displayFilename
                dir.findFile(targetName)?.delete()
                val doc = dir.createFile(track.mimeType, targetName)
                    ?: throw BridgeApiException("Cannot create file in selected download folder")
                api.downloadAudioStream(track) { _, _, stream ->
                    context.contentResolver.openOutputStream(doc.uri)?.use { out ->
                        stream.copyTo(out)
                    } ?: throw BridgeApiException("Failed to open output stream")
                }
                PowerampHelper.triggerRescan(context, null, fromUi = true)
                BridgeAppGraph.localLibrary(context).markDownloaded(track.artist, track.title, doc.uri)
                return@withContext targetName
            }
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val subdir = prefs.downloadSubdir
            val relPath = "${Environment.DIRECTORY_MUSIC}/$subdir"
            val values = ContentValues().apply {
                put(MediaStore.Audio.Media.DISPLAY_NAME, track.displayFilename)
                put(MediaStore.Audio.Media.MIME_TYPE, track.mimeType)
                put(MediaStore.Audio.Media.TITLE, track.title)
                put(MediaStore.Audio.Media.ARTIST, track.artist)
                track.album?.let { put(MediaStore.Audio.Media.ALBUM, it) }
                track.year?.let { put(MediaStore.Audio.Media.YEAR, it) }
                put(MediaStore.Audio.Media.RELATIVE_PATH, relPath)
                put(MediaStore.Audio.Media.IS_PENDING, 1)
            }
            val resolver = context.contentResolver
            val itemUri = resolver.insert(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, values)
                ?: throw BridgeApiException("MediaStore rejected track insert")
            try {
                api.downloadAudioStream(track) { _, _, stream ->
                    resolver.openOutputStream(itemUri)?.use { out ->
                        stream.copyTo(out)
                    } ?: throw BridgeApiException("Could not write to MediaStore URI")
                }
                values.clear()
                values.put(MediaStore.Audio.Media.IS_PENDING, 0)
                resolver.update(itemUri, values, null, null)
                BridgeAppGraph.localLibrary(context).markDownloaded(track.artist, track.title, itemUri)
                return@withContext "$relPath/${track.displayFilename}"
            } catch (t: Throwable) {
                resolver.delete(itemUri, null, null)
                throw t
            }
        }

        @Suppress("DEPRECATION")
        val musicDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC)
        val folder = File(musicDir, prefs.downloadSubdir).apply { mkdirs() }
        val target = File(folder, track.displayFilename)
        api.downloadAudioStream(track) { _, _, stream ->
            FileOutputStream(target).use { out -> stream.copyTo(out) }
        }
        MediaScannerConnection.scanFile(context, arrayOf(target.absolutePath), arrayOf(track.mimeType), null)
        BridgeAppGraph.localLibrary(context).markDownloaded(track.artist, track.title, Uri.fromFile(target))
        target.absolutePath
    }
}
