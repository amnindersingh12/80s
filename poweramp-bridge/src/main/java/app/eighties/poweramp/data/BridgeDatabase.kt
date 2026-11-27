package app.eighties.poweramp.data

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

data class BridgeFolder(
    val docId: String,
    val parentId: String,
    val displayName: String,
    val sortOrder: Int,
    val hasSubdirs: Boolean,
    val lastModified: Long,
)

data class CachedTrackRow(
    val docId: String,
    val folderId: String,
    val track: LosslessTrack,
    val sortOrder: Int,
    val lastModified: Long,
)

/**
 * Thread-safe SQLite store backing [app.eighties.poweramp.provider.PowerampTrackProvider]
 * so Poweramp hierarchy/metadata scans complete instantaneously without blocking on the network.
 */
class BridgeDatabase(context: Context) : SQLiteOpenHelper(
    context.applicationContext,
    DB_NAME,
    null,
    DB_VERSION,
) {
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE folders (
                doc_id TEXT PRIMARY KEY,
                parent_id TEXT NOT NULL,
                display_name TEXT NOT NULL,
                sort_order INTEGER NOT NULL,
                has_subdirs INTEGER NOT NULL,
                last_modified INTEGER NOT NULL
            )
            """.trimIndent(),
        )
        db.execSQL(
            """
            CREATE TABLE tracks (
                doc_id TEXT PRIMARY KEY,
                folder_id TEXT NOT NULL,
                track_id TEXT NOT NULL,
                title TEXT NOT NULL,
                artist TEXT NOT NULL,
                artist_id TEXT,
                album_artist TEXT,
                album TEXT,
                album_id TEXT,
                year INTEGER,
                track_number INTEGER,
                duration_ms INTEGER NOT NULL,
                artwork_url TEXT,
                codec TEXT NOT NULL,
                bit_depth INTEGER,
                sample_rate INTEGER,
                bitrate_kbps INTEGER,
                file_size INTEGER,
                quality_tier TEXT,
                genre TEXT,
                sort_order INTEGER NOT NULL,
                last_modified INTEGER NOT NULL
            )
            """.trimIndent(),
        )
        db.execSQL("CREATE INDEX idx_tracks_folder ON tracks(folder_id, sort_order)")
        db.execSQL(
            """
            CREATE TABLE lyrics_cache (
                cache_key TEXT PRIMARY KEY,
                synced_lyrics TEXT,
                plain_lyrics TEXT,
                instrumental INTEGER NOT NULL,
                fetched_at INTEGER NOT NULL
            )
            """.trimIndent(),
        )
        seedDefaultFolders(db)
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < 2) {
            runCatching { db.execSQL("ALTER TABLE tracks ADD COLUMN album_artist TEXT") }
        }
        if (oldVersion < 3) {
            runCatching { db.execSQL("ALTER TABLE tracks ADD COLUMN artist_id TEXT") }
            runCatching { db.execSQL("ALTER TABLE tracks ADD COLUMN album_id TEXT") }
        }
        seedDefaultFolders(db)
    }

    fun ensureDefaultFolders() {
        synchronized(this) {
            seedDefaultFolders(writableDatabase)
        }
    }

    private fun seedDefaultFolders(db: SQLiteDatabase) {
        val now = System.currentTimeMillis()
        for (spec in DEFAULT_FOLDERS) {
            val cv = ContentValues().apply {
                put("doc_id", spec.docId)
                put("parent_id", spec.parentId)
                put("display_name", spec.displayName)
                put("sort_order", spec.sortOrder)
                put("has_subdirs", if (spec.hasSubdirs) 1 else 0)
                put("last_modified", now)
            }
            db.insertWithOnConflict("folders", null, cv, SQLiteDatabase.CONFLICT_IGNORE)
        }
    }

    fun getFolder(docId: String): BridgeFolder? = synchronized(this) {
        readableDatabase.rawQuery(
            "SELECT doc_id, parent_id, display_name, sort_order, has_subdirs, last_modified FROM folders WHERE doc_id = ? LIMIT 1",
            arrayOf(docId),
        ).use { c -> if (c.moveToFirst()) c.toFolder() else null }
    }

    fun getChildFolders(parentDocId: String): List<BridgeFolder> = synchronized(this) {
        readableDatabase.rawQuery(
            "SELECT doc_id, parent_id, display_name, sort_order, has_subdirs, last_modified FROM folders WHERE parent_id = ? ORDER BY sort_order ASC",
            arrayOf(parentDocId),
        ).use { c ->
            buildList {
                while (c.moveToNext()) add(c.toFolder())
            }
        }
    }

    fun getTrack(docId: String): CachedTrackRow? = synchronized(this) {
        readableDatabase.rawQuery(
            "SELECT * FROM tracks WHERE doc_id = ? LIMIT 1",
            arrayOf(docId),
        ).use { c -> if (c.moveToFirst()) c.toTrackRow() else null }
    }

    fun getTracksInFolder(folderId: String): List<CachedTrackRow> = synchronized(this) {
        readableDatabase.rawQuery(
            "SELECT * FROM tracks WHERE folder_id = ? ORDER BY sort_order ASC",
            arrayOf(folderId),
        ).use { c ->
            buildList {
                while (c.moveToNext()) add(c.toTrackRow())
            }
        }
    }

    fun replaceFolderTracks(folderId: String, items: List<LosslessTrack>, genreLabel: String? = null) {
        val now = System.currentTimeMillis()
        synchronized(this) {
            val db = writableDatabase
            db.beginTransaction()
            try {
                db.delete("tracks", "folder_id = ?", arrayOf(folderId))
                items.forEachIndexed { idx, track ->
                    val docId = trackDocId(folderId, idx, track.id)
                    insertTrack(db, docId, folderId, track, genreLabel ?: track.genre, idx + 1, now)
                }
                val folderUpdate = ContentValues().apply { put("last_modified", now) }
                db.update("folders", folderUpdate, "doc_id = ? OR doc_id = ?", arrayOf(folderId, ROOT_DOC_ID))
                db.setTransactionSuccessful()
            } finally {
                db.endTransaction()
            }
        }
    }

    fun addRecentSearchTrack(track: LosslessTrack, maxItems: Int = 40) {
        val now = System.currentTimeMillis()
        synchronized(this) {
            val db = writableDatabase
            db.beginTransaction()
            try {
                val existing = readableDatabase.rawQuery(
                    "SELECT * FROM tracks WHERE folder_id = ? AND track_id != ? ORDER BY sort_order ASC LIMIT ?",
                    arrayOf(FOLDER_RECENT_SEARCHES, track.id, (maxItems - 1).toString()),
                ).use { c ->
                    buildList {
                        while (c.moveToNext()) add(c.toTrackRow().track)
                    }
                }
                val combined = listOf(track) + existing
                db.delete("tracks", "folder_id = ?", arrayOf(FOLDER_RECENT_SEARCHES))
                combined.forEachIndexed { idx, t ->
                    val docId = trackDocId(FOLDER_RECENT_SEARCHES, idx, t.id)
                    insertTrack(db, docId, FOLDER_RECENT_SEARCHES, t, t.genre ?: "Recent Search", idx + 1, now)
                }
                val cv = ContentValues().apply { put("last_modified", now) }
                db.update("folders", cv, "doc_id = ? OR doc_id = ?", arrayOf(FOLDER_RECENT_SEARCHES, ROOT_DOC_ID))
                db.setTransactionSuccessful()
            } finally {
                db.endTransaction()
            }
        }
    }

    fun addToQueue(tracks: List<LosslessTrack>, playNext: Boolean = false) {
        if (tracks.isEmpty()) return
        val now = System.currentTimeMillis()
        val ids = tracks.map { it.id }.toSet()
        synchronized(this) {
            val db = writableDatabase
            db.beginTransaction()
            try {
                val existing = readableDatabase.rawQuery(
                    "SELECT * FROM tracks WHERE folder_id = ? ORDER BY sort_order ASC",
                    arrayOf(FOLDER_QUEUE),
                ).use { c ->
                    buildList {
                        while (c.moveToNext()) add(c.toTrackRow().track)
                    }.filterNot { it.id in ids }
                }
                val combined = if (playNext) tracks + existing else existing + tracks
                db.delete("tracks", "folder_id = ?", arrayOf(FOLDER_QUEUE))
                combined.take(100).forEachIndexed { idx, t ->
                    val docId = trackDocId(FOLDER_QUEUE, idx, t.id)
                    insertTrack(db, docId, FOLDER_QUEUE, t, t.genre ?: "Queue", idx + 1, now)
                }
                val cv = ContentValues().apply { put("last_modified", now) }
                db.update("folders", cv, "doc_id = ? OR doc_id = ?", arrayOf(FOLDER_QUEUE, ROOT_DOC_ID))
                db.setTransactionSuccessful()
            } finally {
                db.endTransaction()
            }
        }
    }

    fun getCachedLyrics(artist: String, title: String): LyricsData? = synchronized(this) {
        val key = "${artist.trim().lowercase()}|${title.trim().lowercase()}"
        val minFresh = System.currentTimeMillis() - 7 * 24 * 60 * 60_000L
        readableDatabase.rawQuery(
            "SELECT synced_lyrics, plain_lyrics, instrumental FROM lyrics_cache WHERE cache_key = ? AND fetched_at >= ? LIMIT 1",
            arrayOf(key, minFresh.toString()),
        ).use { c ->
            if (!c.moveToFirst()) return null
            LyricsData(
                syncedLyrics = c.getString(0),
                plainLyrics = c.getString(1),
                instrumental = c.getInt(2) == 1,
                source = "cache",
            )
        }
    }

    fun putCachedLyrics(artist: String, title: String, data: LyricsData) = synchronized(this) {
        val key = "${artist.trim().lowercase()}|${title.trim().lowercase()}"
        val cv = ContentValues().apply {
            put("cache_key", key)
            put("synced_lyrics", data.syncedLyrics)
            put("plain_lyrics", data.plainLyrics)
            put("instrumental", if (data.instrumental) 1 else 0)
            put("fetched_at", System.currentTimeMillis())
        }
        writableDatabase.insertWithOnConflict("lyrics_cache", null, cv, SQLiteDatabase.CONFLICT_REPLACE)
    }

    private fun insertTrack(
        db: SQLiteDatabase,
        docId: String,
        folderId: String,
        track: LosslessTrack,
        genre: String?,
        sortOrder: Int,
        now: Long,
    ) {
        val cv = ContentValues().apply {
            put("doc_id", docId)
            put("folder_id", folderId)
            put("track_id", track.id)
            put("title", track.title)
            put("artist", track.artist)
            put("artist_id", track.artistId)
            put("album_artist", track.albumArtist)
            put("album", track.album)
            put("album_id", track.albumId)
            track.year?.let { put("year", it) }
            track.trackNumber?.let { put("track_number", it) }
            put("duration_ms", track.effectiveDurationMs)
            put("artwork_url", track.artworkUrl)
            put("codec", track.codec)
            track.bitDepth?.let { put("bit_depth", it) }
            track.sampleRate?.let { put("sample_rate", it) }
            track.bitrateKbps?.let { put("bitrate_kbps", it) }
            track.fileSize?.let { put("file_size", it) }
            put("quality_tier", track.qualityTier)
            put("genre", genre)
            put("sort_order", sortOrder)
            put("last_modified", now)
        }
        db.insertWithOnConflict("tracks", null, cv, SQLiteDatabase.CONFLICT_REPLACE)
    }

    private fun Cursor.toFolder(): BridgeFolder = BridgeFolder(
        docId = getString(0),
        parentId = getString(1),
        displayName = getString(2),
        sortOrder = getInt(3),
        hasSubdirs = getInt(4) == 1,
        lastModified = getLong(5),
    )

    private fun Cursor.toTrackRow(): CachedTrackRow {
        val track = LosslessTrack(
            id = getString(getColumnIndexOrThrow("track_id")),
            provider = "80s",
            title = getString(getColumnIndexOrThrow("title")),
            artist = getString(getColumnIndexOrThrow("artist")),
            artistId = getStringOrNull("artist_id"),
            albumArtist = getStringOrNull("album_artist"),
            album = getStringOrNull("album"),
            albumId = getStringOrNull("album_id"),
            year = getIntOrNull("year"),
            trackNumber = getIntOrNull("track_number"),
            durationMs = getLong(getColumnIndexOrThrow("duration_ms")),
            artworkUrl = getStringOrNull("artwork_url"),
            codec = getString(getColumnIndexOrThrow("codec")),
            bitDepth = getIntOrNull("bit_depth"),
            sampleRate = getIntOrNull("sample_rate"),
            bitrateKbps = getIntOrNull("bitrate_kbps"),
            fileSize = getLongOrNull("file_size"),
            qualityTier = getStringOrNull("quality_tier") ?: "LOSSLESS",
            genre = getStringOrNull("genre"),
        )
        return CachedTrackRow(
            docId = getString(getColumnIndexOrThrow("doc_id")),
            folderId = getString(getColumnIndexOrThrow("folder_id")),
            track = track,
            sortOrder = getInt(getColumnIndexOrThrow("sort_order")),
            lastModified = getLong(getColumnIndexOrThrow("last_modified")),
        )
    }

    private fun Cursor.getStringOrNull(col: String): String? {
        val idx = getColumnIndex(col)
        return if (idx >= 0 && !isNull(idx)) getString(idx) else null
    }

    private fun Cursor.getIntOrNull(col: String): Int? {
        val idx = getColumnIndex(col)
        return if (idx >= 0 && !isNull(idx)) getInt(idx) else null
    }

    private fun Cursor.getLongOrNull(col: String): Long? {
        val idx = getColumnIndex(col)
        return if (idx >= 0 && !isNull(idx)) getLong(idx) else null
    }

    companion object {
        private const val DB_NAME = "eighties_bridge.db"
        private const val DB_VERSION = 3

        const val ROOT_ID = "eighties_root"
        const val ROOT_DOC_ID = "root"
        const val FOLDER_FOR_YOU = "root/for_you"
        const val FOLDER_WESTERN = "root/western"
        const val FOLDER_POP = "root/western/pop"
        const val FOLDER_HIP_HOP = "root/western/hip_hop"
        const val FOLDER_ROCK_INDIE = "root/western/rock_indie"
        const val FOLDER_ELECTRONIC = "root/western/electronic"
        const val FOLDER_RNB = "root/western/rnb"
        const val FOLDER_PUNJABI = "root/punjabi_desi"
        const val FOLDER_RADIO = "root/radio"
        const val FOLDER_RECENT_SEARCHES = "root/recent_searches"
        const val FOLDER_QUEUE = "root/bridge_queue"

        fun trackDocId(folderId: String, index: Int, rawTrackId: String): String {
            val safeId = Integer.toHexString(rawTrackId.hashCode())
            return "$folderId/t_${index}_$safeId.flac"
        }

        val FOLDER_GENRES: Map<String, Pair<String, String>> = mapOf(
            FOLDER_FOR_YOU to ("mixed" to "Mixed"),
            FOLDER_POP to ("pop" to "Pop"),
            FOLDER_HIP_HOP to ("hip-hop" to "Hip-Hop & Rap"),
            FOLDER_ROCK_INDIE to ("rock" to "Rock & Indie"),
            FOLDER_ELECTRONIC to ("electronic" to "Electronic"),
            FOLDER_RNB to ("rnb" to "R&B & Soul"),
            FOLDER_PUNJABI to ("punjabi" to "Punjabi & Desi"),
        )

        private data class FolderSpec(
            val docId: String,
            val parentId: String,
            val displayName: String,
            val sortOrder: Int,
            val hasSubdirs: Boolean,
        )

        private val DEFAULT_FOLDERS = listOf(
            FolderSpec(ROOT_DOC_ID, "", "80s Hi-Res Lossless", 0, true),
            FolderSpec(FOLDER_FOR_YOU, ROOT_DOC_ID, "For You (Mixed)", 1, false),
            FolderSpec(FOLDER_WESTERN, ROOT_DOC_ID, "Western", 2, true),
            FolderSpec(FOLDER_POP, FOLDER_WESTERN, "Pop", 1, false),
            FolderSpec(FOLDER_HIP_HOP, FOLDER_WESTERN, "Hip-Hop & Rap", 2, false),
            FolderSpec(FOLDER_ROCK_INDIE, FOLDER_WESTERN, "Rock & Indie", 3, false),
            FolderSpec(FOLDER_ELECTRONIC, FOLDER_WESTERN, "Electronic", 4, false),
            FolderSpec(FOLDER_RNB, FOLDER_WESTERN, "R&B & Soul", 5, false),
            FolderSpec(FOLDER_PUNJABI, ROOT_DOC_ID, "Punjabi & Desi", 3, false),
            FolderSpec(FOLDER_RADIO, ROOT_DOC_ID, "Radio (Based on Now Playing)", 4, false),
            FolderSpec(FOLDER_RECENT_SEARCHES, ROOT_DOC_ID, "Recent Searches", 5, false),
            FolderSpec(FOLDER_QUEUE, ROOT_DOC_ID, "Bridge Queue", 6, false),
        )
    }
}
