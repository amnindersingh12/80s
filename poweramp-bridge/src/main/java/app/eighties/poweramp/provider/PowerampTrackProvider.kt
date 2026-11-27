package app.eighties.poweramp.provider

import android.content.res.AssetFileDescriptor
import android.database.Cursor
import android.database.MatrixCursor
import android.graphics.Point
import android.media.MediaFormat
import android.net.Uri
import android.os.Bundle
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.DocumentsContract.Root
import android.provider.DocumentsProvider
import android.provider.MediaStore
import android.util.Log
import app.eighties.poweramp.R
import app.eighties.poweramp.data.BridgeAppGraph
import app.eighties.poweramp.data.BridgeDatabase
import app.eighties.poweramp.data.BridgeFolder
import app.eighties.poweramp.data.CachedTrackRow
import app.eighties.poweramp.poweramp.PowerampContract
import java.io.File
import java.io.FileNotFoundException

/**
 * Official Poweramp Track Provider implementing Android Storage Access Framework ([DocumentsProvider])
 * with Dynamic URL tracks (`__dynamic_url` + `CALL_GET_URL`), empty seek-wave (`byte[0]`),
 * LRCLIB lyrics (`COLUMN_TRACK_LYRICS` / `COLUMN_TRACK_LYRICS_SYNCED`), and SQLite-backed scans.
 */
class PowerampTrackProvider : DocumentsProvider() {

    private var installTimeMs: Long = System.currentTimeMillis()

    override fun onCreate(): Boolean {
        val ctx = context ?: return false
        installTimeMs = runCatching {
            val info = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
            info.lastUpdateTime.takeIf { it > 0 } ?: info.firstInstallTime
        }.getOrElse { System.currentTimeMillis() }
        BridgeAppGraph.db(ctx).ensureDefaultFolders()
        return true
    }

    override fun queryRoots(projection: Array<out String>?): Cursor? {
        return try {
            val ctx = context ?: return null
            val cols = projection ?: DEFAULT_ROOT_PROJECTION
            MatrixCursor(cols).apply {
                newRow().apply {
                    addIfPresent(Root.COLUMN_ROOT_ID, BridgeDatabase.ROOT_ID)
                    addIfPresent(Root.COLUMN_TITLE, ctx.getString(R.string.root_title))
                    addIfPresent(Root.COLUMN_SUMMARY, ctx.getString(R.string.root_summary))
                    addIfPresent(Root.COLUMN_FLAGS, Root.FLAG_SUPPORTS_IS_CHILD)
                    addIfPresent(Root.COLUMN_ICON, R.mipmap.ic_launcher)
                    addIfPresent(Root.COLUMN_DOCUMENT_ID, BridgeDatabase.ROOT_DOC_ID)
                }
            }
        } catch (t: Throwable) {
            Log.e(TAG, "queryRoots failed", t)
            null
        }
    }

    override fun queryDocument(documentId: String, projection: Array<out String>?): Cursor? {
        return try {
            val ctx = context ?: return null
            val db = BridgeAppGraph.db(ctx)
            val folder = db.getFolder(documentId)
            if (folder != null) {
                val cols = projection ?: DEFAULT_DOCUMENT_PROJECTION
                return MatrixCursor(cols).apply {
                    addFolderRow(newRow(), folder)
                }
            }
            val trackRow = db.getTrack(documentId) ?: return null
            val cols = projection ?: DEFAULT_TRACK_PROJECTION
            val wantsLyrics = projection != null && (
                projection.contains(PowerampContract.COLUMN_TRACK_LYRICS) ||
                    projection.contains(PowerampContract.COLUMN_TRACK_LYRICS_SYNCED)
                )
            MatrixCursor(cols).apply {
                addTrackRow(newRow(), trackRow, includeMetadata = true, includeLyrics = wantsLyrics)
            }
        } catch (t: Throwable) {
            Log.e(TAG, "queryDocument failed id=$documentId", t)
            null
        }
    }

    override fun queryChildDocuments(
        parentDocumentId: String,
        projection: Array<out String>?,
        sortOrder: String?,
    ): Cursor? {
        return try {
            val ctx = context ?: return null
            val db = BridgeAppGraph.db(ctx)
            val childFolders = db.getChildFolders(parentDocumentId)
            var tracks = db.getTracksInFolder(parentDocumentId)
            if (tracks.isEmpty() && BridgeDatabase.FOLDER_GENRES.containsKey(parentDocumentId)) {
                BridgeAppGraph.syncManager(ctx).syncSingleFolderBlocking(parentDocumentId)
                tracks = db.getTracksInFolder(parentDocumentId)
            }

            val wantsMeta = projection == null || projection.contains(MediaStore.MediaColumns.TITLE)
            val cols = projection ?: DEFAULT_TRACK_PROJECTION
            MatrixCursor(cols).apply {
                for (folder in childFolders) {
                    addFolderRow(newRow(), folder)
                }
                for (trackRow in tracks) {
                    addTrackRow(newRow(), trackRow, includeMetadata = wantsMeta, includeLyrics = false)
                }
            }
        } catch (t: Throwable) {
            Log.e(TAG, "queryChildDocuments failed parent=$parentDocumentId", t)
            null
        }
    }

    override fun isChildDocument(parentDocumentId: String, documentId: String): Boolean {
        return try {
            if (parentDocumentId == documentId) return true
            if (documentId.startsWith("$parentDocumentId/")) return true
            val ctx = context ?: return false
            val db = BridgeAppGraph.db(ctx)
            val track = db.getTrack(documentId)
            if (track != null) {
                return track.folderId == parentDocumentId || track.folderId.startsWith("$parentDocumentId/")
            }
            val folder = db.getFolder(documentId)
            folder != null && (folder.parentId == parentDocumentId || folder.docId.startsWith("$parentDocumentId/"))
        } catch (t: Throwable) {
            Log.e(TAG, "isChildDocument failed", t)
            false
        }
    }

    override fun openDocumentThumbnail(
        documentId: String,
        sizeHint: Point?,
        signal: CancellationSignal?,
    ): AssetFileDescriptor {
        signal?.throwIfCanceled()
        val ctx = context ?: throw FileNotFoundException(documentId)
        val trackRow = BridgeAppGraph.db(ctx).getTrack(documentId)
        val coverUrl = trackRow?.track?.artworkUrl ?: throw FileNotFoundException(documentId)
        val cacheDir = File(ctx.cacheDir, "covers")
        val target = File(cacheDir, "${Integer.toHexString(coverUrl.hashCode())}.jpg")
        if (!target.isFile || target.length() == 0L) {
            signal?.throwIfCanceled()
            val ok = BridgeAppGraph.api(ctx).downloadCoverBlocking(coverUrl, target)
            if (!ok || !target.isFile) throw FileNotFoundException(documentId)
        }
        val pfd = ParcelFileDescriptor.open(target, ParcelFileDescriptor.MODE_READ_ONLY)
        return AssetFileDescriptor(pfd, 0, AssetFileDescriptor.UNKNOWN_LENGTH)
    }

    override fun openDocument(documentId: String, mode: String?, signal: CancellationSignal?): ParcelFileDescriptor {
        throw FileNotFoundException("Dynamic URL tracks stream via CALL_GET_URL: $documentId")
    }

    override fun call(method: String, arg: String?, extras: Bundle?): Bundle? {
        return try {
            super.call(method, arg, extras) ?: when (method) {
                PowerampContract.CALL_GET_URL -> handleGetUrl(arg)
                PowerampContract.CALL_GET_DIR_METADATA -> handleGetDirMetadata(arg)
                PowerampContract.CALL_RESCAN -> handleRescan()
                else -> null
            }
        } catch (t: Throwable) {
            Log.e(TAG, "call($method) failed", t)
            null
        }
    }

    private fun handleGetUrl(arg: String?): Bundle? {
        val ctx = context ?: return null
        if (arg.isNullOrBlank()) return null
        val docId = runCatching { DocumentsContract.getDocumentId(Uri.parse(arg)) }.getOrNull() ?: return null
        val cachedRow = BridgeAppGraph.db(ctx).getTrack(docId) ?: return null
        val prepared = BridgeAppGraph.api(ctx).prepareOrResolveBlocking(cachedRow.track)
        return Bundle().apply {
            putString(PowerampContract.COLUMN_URL, prepared.signedStreamUrl)
            putString(PowerampContract.COLUMN_HTTP_METHOD, "GET")
        }
    }

    private fun handleGetDirMetadata(arg: String?): Bundle {
        if (arg.isNullOrBlank()) return Bundle.EMPTY
        val docId = runCatching { DocumentsContract.getDocumentId(Uri.parse(arg)) }.getOrNull() ?: return Bundle.EMPTY
        val segments = docId.split('/').filter { it.isNotEmpty() }
        if (segments.size <= 1) return Bundle.EMPTY
        val ancestors = Array(segments.size - 1) { i ->
            segments.subList(0, i + 1).joinToString("/")
        }
        return Bundle().apply {
            putStringArray(PowerampContract.EXTRA_ANCESTORS, ancestors)
        }
    }

    private fun handleRescan(): Bundle? {
        context?.let { BridgeAppGraph.syncManager(it).refreshAllAsync(triggerPowerampScan = false) }
        return null
    }

    private fun MatrixCursor.addFolderRow(row: MatrixCursor.RowBuilder, folder: BridgeFolder) {
        row.add(Document.COLUMN_DOCUMENT_ID, folder.docId)
        row.add(Document.COLUMN_MIME_TYPE, Document.MIME_TYPE_DIR)
        row.add(Document.COLUMN_DISPLAY_NAME, folder.displayName)
        row.add(Document.COLUMN_LAST_MODIFIED, maxOf(folder.lastModified, installTimeMs))
        row.add(Document.COLUMN_FLAGS, 0)
        row.add(
            PowerampContract.COLUMN_FLAGS,
            if (folder.hasSubdirs) PowerampContract.FLAG_HAS_SUBDIRS else PowerampContract.FLAG_NO_SUBDIRS,
        )
    }

    private fun MatrixCursor.addTrackRow(
        row: MatrixCursor.RowBuilder,
        item: CachedTrackRow,
        includeMetadata: Boolean,
        includeLyrics: Boolean,
    ) {
        val t = item.track
        val docFlags = if (!t.artworkUrl.isNullOrBlank()) Document.FLAG_SUPPORTS_THUMBNAIL else 0
        row.add(Document.COLUMN_DOCUMENT_ID, item.docId)
        row.add(Document.COLUMN_MIME_TYPE, t.mimeType)
        row.add(Document.COLUMN_DISPLAY_NAME, t.displayFilename)
        row.add(Document.COLUMN_LAST_MODIFIED, item.lastModified)
        row.add(Document.COLUMN_SIZE, t.fileSize ?: 0L)
        row.add(Document.COLUMN_FLAGS, docFlags)

        row.add(PowerampContract.COLUMN_URL, PowerampContract.DYNAMIC_URL)
        row.add(MediaStore.Audio.AudioColumns.DURATION, t.effectiveDurationMs)
        row.add(PowerampContract.COLUMN_TRACK_ALT, item.sortOrder)
        row.add(PowerampContract.COLUMN_FLAGS, PowerampContract.FLAG_HAS_LYRICS)
        // Always supply empty track_wave bytes so Poweramp never pre-downloads remote FLACs during scan.
        row.add(PowerampContract.COLUMN_TRACK_WAVE, EMPTY_WAVE)

        if (includeMetadata) {
            row.add(MediaStore.MediaColumns.TITLE, t.title)
            row.add(MediaStore.Audio.AudioColumns.ARTIST, t.artist)
            row.add(MediaStore.Audio.AudioColumns.ALBUM, t.album ?: t.artist)
            row.add(PowerampContract.COLUMN_ALBUM_ARTIST, t.artist)
            t.year?.let { row.add(MediaStore.Audio.AudioColumns.YEAR, it) }
            t.trackNumber?.let { row.add(MediaStore.Audio.AudioColumns.TRACK, it) }
            row.add(PowerampContract.COLUMN_GENRE, t.genre ?: "Hi-Res Lossless")
            row.add(MediaFormat.KEY_SAMPLE_RATE, t.sampleRate ?: 44_100)
            row.add(MediaFormat.KEY_CHANNEL_COUNT, 2)
            row.add(MediaFormat.KEY_BIT_RATE, (t.bitrateKbps ?: 1_411) * 1000)
            row.add(PowerampContract.COLUMN_BITS_PER_SAMPLE, t.bitDepth ?: 16)
        }

        if (includeLyrics) {
            val ctx = context
            if (ctx != null) {
                val db = BridgeAppGraph.db(ctx)
                val cached = db.getCachedLyrics(t.artist, t.title)
                val lyrics = cached ?: BridgeAppGraph.api(ctx)
                    .fetchLyricsBlocking(t.title, t.artist, t.album, t.durationSec)
                    ?.also { db.putCachedLyrics(t.artist, t.title, it) }
                if (lyrics != null) {
                    lyrics.syncedLyrics?.let { row.add(PowerampContract.COLUMN_TRACK_LYRICS_SYNCED, it) }
                    val plainOrSynced = lyrics.syncedLyrics ?: lyrics.plainLyrics
                    plainOrSynced?.let { row.add(PowerampContract.COLUMN_TRACK_LYRICS, it) }
                }
            }
        }
    }

    private fun MatrixCursor.RowBuilder.addIfPresent(col: String, value: Any?) {
        add(col, value)
    }

    companion object {
        private const val TAG = "PowerampTrackProvider"
        private val EMPTY_WAVE = ByteArray(0)

        private val DEFAULT_ROOT_PROJECTION = arrayOf(
            Root.COLUMN_ROOT_ID,
            Root.COLUMN_TITLE,
            Root.COLUMN_SUMMARY,
            Root.COLUMN_FLAGS,
            Root.COLUMN_ICON,
            Root.COLUMN_DOCUMENT_ID,
        )

        private val DEFAULT_DOCUMENT_PROJECTION = arrayOf(
            Document.COLUMN_DOCUMENT_ID,
            Document.COLUMN_MIME_TYPE,
            Document.COLUMN_DISPLAY_NAME,
            Document.COLUMN_LAST_MODIFIED,
            Document.COLUMN_FLAGS,
            Document.COLUMN_SIZE,
            PowerampContract.COLUMN_FLAGS,
        )

        private val DEFAULT_TRACK_PROJECTION = arrayOf(
            Document.COLUMN_DOCUMENT_ID,
            Document.COLUMN_MIME_TYPE,
            Document.COLUMN_DISPLAY_NAME,
            Document.COLUMN_LAST_MODIFIED,
            Document.COLUMN_FLAGS,
            Document.COLUMN_SIZE,
            PowerampContract.COLUMN_URL,
            PowerampContract.COLUMN_TRACK_WAVE,
            PowerampContract.COLUMN_FLAGS,
            PowerampContract.COLUMN_TRACK_ALT,
            MediaStore.MediaColumns.TITLE,
            MediaStore.Audio.AudioColumns.DURATION,
            MediaStore.Audio.AudioColumns.ARTIST,
            MediaStore.Audio.AudioColumns.ALBUM,
            MediaStore.Audio.AudioColumns.YEAR,
            PowerampContract.COLUMN_ALBUM_ARTIST,
            PowerampContract.COLUMN_GENRE,
            MediaStore.Audio.AudioColumns.TRACK,
            MediaFormat.KEY_SAMPLE_RATE,
            MediaFormat.KEY_CHANNEL_COUNT,
            MediaFormat.KEY_BIT_RATE,
            PowerampContract.COLUMN_BITS_PER_SAMPLE,
        )
    }
}
