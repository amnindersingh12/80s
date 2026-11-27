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
import app.simple.felicity.remote.FlacTagWriter
import app.simple.felicity.remote.RemoteTrack
import app.simple.felicity.remote.WebApiClient
import app.simple.felicity.repository.repositories.LrcRepository
import app.simple.felicity.repository.services.AudioDatabaseService
import com.google.gson.Gson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest

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

    private val gson = Gson()

    fun targetFolder(): DocumentFile? {
        val candidates = listOfNotNull(RemoteServerPreferences.getDownloadTreeUri()) + SAFPreferences.getTreeUris()
        return candidates.asSequence()
            .mapNotNull { runCatching { DocumentFile.fromTreeUri(context, it.toUri()) }.getOrNull() }
            .firstOrNull { it.exists() && it.canWrite() }
    }

    suspend fun download(track: RemoteTrack, onProgress: (Float?) -> Unit = {}): DownloadResult {
        val folder = targetFolder()
            ?: return DownloadResult.Failed("Add a music folder in Library → Music folders first", needsFolder = true)

        val partDir = File(context.cacheDir, "dl_parts").apply { mkdirs() }
        pruneStaleParts(partDir)
        val key = sha256Prefix(track.id)
        val partFile = File(partDir, "$key.part")
        val metaFile = File(partDir, "$key.meta.json")
        runCatching { metaFile.writeText(gson.toJson(track)) }
        var resolvedName = "${track.artist} - ${track.title}.${RemoteAudioMapper.extensionFor(track)}"
        var resolvedMime = RemoteAudioMapper.mimeFor(track)

        return try {
            var attempt = 0
            while (true) {
                val resumeFrom = if (partFile.isFile) partFile.length() else 0L
                val result = runCatching {
                    api.download(track, rangeStart = resumeFrom) { info, input ->
                        resolvedName = info.filename
                        resolvedMime = info.contentType?.substringBefore(';')?.trim()
                            .takeUnless { it.isNullOrBlank() || it == "application/octet-stream" }
                            ?: RemoteAudioMapper.mimeFor(track)

                        folder.findFile(info.filename)?.takeIf { it.isFile && it.length() > 0 }?.let {
                            partFile.delete()
                            metaFile.delete()
                            return@download DownloadResult.AlreadyExists(info.filename)
                        }

                        val append = info.isPartial && resumeFrom > 0L
                        var total = if (append) resumeFrom else 0L
                        val expectedTotal = info.totalLength.takeIf { it > 0 } ?: -1L
                        var lastReport = total
                        FileOutputStream(partFile, append).use { out ->
                            val buffer = ByteArray(64 * 1024)
                            while (true) {
                                val n = input.read(buffer)
                                if (n < 0) break
                                out.write(buffer, 0, n)
                                total += n
                                if (total - lastReport > 256 * 1024) {
                                    lastReport = total
                                    onProgress(if (expectedTotal > 0) (total.toFloat() / expectedTotal).coerceIn(0f, 0.98f) else null)
                                }
                            }
                        }
                        null
                    }
                }
                val already = result.getOrNull()
                if (already != null) return already
                if (result.isSuccess) break
                val err = result.exceptionOrNull()!!
                if (err is kotlinx.coroutines.CancellationException) throw err
                if (++attempt >= MAX_RESUME_ATTEMPTS) throw err
                delay(1_200L * attempt)
            }

            val cachedLyrics = runCatching { LrcRepository(context).loadLrcFromFile(api.streamUrl(track.id)).getOrNull() }.getOrNull()
            if (resolvedMime.contains("flac", ignoreCase = true) || resolvedName.endsWith(".flac", ignoreCase = true)) {
                val cover = track.coverUrl?.let { api.fetchSmallAsset(it) }
                withContext(Dispatchers.IO) {
                    runCatching {
                        FlacTagWriter.embedIfMissing(
                                file = partFile,
                                track = track,
                                coverBytes = cover?.second,
                                coverMime = cover?.first ?: "image/jpeg",
                                lyricsText = cachedLyrics,
                        )
                    }
                }
            }

            val bare = resolvedName.substringBeforeLast('.', resolvedName)
            val file = folder.createFile(resolvedMime, bare) ?: throw IOException("Could not create the file in ${folder.name}")
            try {
                withContext(Dispatchers.IO) {
                    context.contentResolver.openOutputStream(file.uri, "w")?.use { out ->
                        partFile.inputStream().use { input -> input.copyTo(out, bufferSize = 64 * 1024) }
                    } ?: throw IOException("Could not open the file for writing")
                }
            } catch (e: Exception) {
                file.delete()
                throw e
            }
            partFile.delete()
            metaFile.delete()
            onProgress(1f)
            notifyLibrary(file.uri)
            DownloadResult.Saved(file.name ?: resolvedName, folder.name ?: "Music")
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            DownloadResult.Failed(e.message ?: "Download failed")
        }
    }

    /** Returns tracks with partial downloads left on disk from interrupted sessions. */
    fun pendingResumableDownloads(): List<RemoteTrack> {
        val partDir = File(context.cacheDir, "dl_parts").takeIf { it.isDirectory } ?: return emptyList()
        pruneStaleParts(partDir)
        return partDir.listFiles { f -> f.name.endsWith(".meta.json") }.orEmpty().mapNotNull { meta ->
            val part = File(partDir, meta.name.removeSuffix(".meta.json") + ".part")
            if (!part.isFile || part.length() <= 0L) {
                meta.delete()
                return@mapNotNull null
            }
            runCatching { gson.fromJson(meta.readText(), RemoteTrack::class.java) }.getOrNull()
        }
    }

    private fun sha256Prefix(id: String): String =
        MessageDigest.getInstance("SHA-256").digest(id.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }.take(24)

    private fun pruneStaleParts(dir: File) {
        val cutoff = System.currentTimeMillis() - 7L * 24 * 60 * 60 * 1000
        dir.listFiles()?.filter { it.lastModified() < cutoff }?.forEach { it.delete() }
    }

    companion object {
        private const val MAX_RESUME_ATTEMPTS = 3
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
