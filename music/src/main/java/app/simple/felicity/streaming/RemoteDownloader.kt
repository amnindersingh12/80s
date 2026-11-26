package app.simple.felicity.streaming

import android.content.Context
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Environment
import android.provider.DocumentsContract
import androidx.core.net.toUri
import androidx.documentfile.provider.DocumentFile
import app.simple.felicity.preferences.RemoteServerPreferences
import app.simple.felicity.preferences.SAFPreferences
import app.simple.felicity.remote.RemoteTrack
import app.simple.felicity.remote.WebApiClient
import app.simple.felicity.repository.services.AudioDatabaseService
import java.io.File
import java.io.IOException

sealed interface DownloadResult {
    data class Saved(val displayName: String, val folderName: String) : DownloadResult
    data class AlreadyExists(val displayName: String) : DownloadResult
    data class Failed(val message: String, val needsFolder: Boolean = false) : DownloadResult
}

/**
 * Saves `/api/download/:id` into the user's music folder so Felicity's own library picks it up.
 *
 * Felicity only indexes the SAF folders the user granted in *Library → Music folders*, so the
 * file is written into the configured download folder (or the first music folder), named
 * exactly as the server sends it (`Artist - Title.flac`). Afterwards the library rescan runs
 * and, for folders on primary storage, the MediaStore scanner is poked too.
 */
class RemoteDownloader(private val context: Context, private val api: WebApiClient) {

    fun targetFolder(): DocumentFile? {
        val candidates = listOfNotNull(RemoteServerPreferences.getDownloadTreeUri()) + SAFPreferences.getTreeUris()
        return candidates.asSequence()
            .mapNotNull { runCatching { DocumentFile.fromTreeUri(context, it.toUri()) }.getOrNull() }
            .firstOrNull { it.exists() && it.canWrite() }
    }

    suspend fun download(track: RemoteTrack, onProgress: (Float?) -> Unit = {}): DownloadResult {
        val folder = targetFolder()
            ?: return DownloadResult.Failed("Add a music folder in Library → Music folders first", needsFolder = true)

        return try {
            api.download(track) { info, input ->
                folder.findFile(info.filename)?.takeIf { it.isFile && it.length() > 0 }?.let {
                    return@download DownloadResult.AlreadyExists(info.filename)
                }
                val mime = info.contentType?.substringBefore(';')?.trim().takeUnless { it.isNullOrBlank() || it == "application/octet-stream" }
                    ?: RemoteAudioMapper.mimeFor(track)
                // DocumentFile appends an extension from the MIME type, so give it the bare name.
                val bare = info.filename.substringBeforeLast('.', info.filename)
                val file = folder.createFile(mime, bare) ?: throw IOException("Could not create the file in ${folder.name}")
                try {
                    context.contentResolver.openOutputStream(file.uri, "w")?.use { out ->
                        val buffer = ByteArray(64 * 1024)
                        var total = 0L
                        var lastReport = 0L
                        while (true) {
                            val n = input.read(buffer)
                            if (n < 0) break
                            out.write(buffer, 0, n)
                            total += n
                            if (total - lastReport > 256 * 1024) {
                                lastReport = total
                                onProgress(if (info.contentLength > 0) total.toFloat() / info.contentLength else null)
                            }
                        }
                    } ?: throw IOException("Could not open the file for writing")
                } catch (e: Exception) {
                    file.delete() // never leave a half-written track in the library
                    throw e
                }
                onProgress(1f)
                notifyLibrary(file.uri)
                DownloadResult.Saved(file.name ?: info.filename, folder.name ?: "Music")
            }
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            DownloadResult.Failed(e.message ?: "Download failed")
        }
    }

    private fun notifyLibrary(documentUri: Uri) {
        // Felicity's scanner reads the SAF folders directly — this is what makes the track show up.
        AudioDatabaseService.refreshScan(context)
        // Best effort for other apps: map primary-storage document ids to a real path for MediaStore.
        runCatching {
            val docId = DocumentsContract.getDocumentId(documentUri)
            if (docId.startsWith("primary:")) {
                @Suppress("DEPRECATION")
                val path = File(Environment.getExternalStorageDirectory(), docId.removePrefix("primary:")).absolutePath
                MediaScannerConnection.scanFile(context, arrayOf(path), null, null)
            }
        }
    }
}
