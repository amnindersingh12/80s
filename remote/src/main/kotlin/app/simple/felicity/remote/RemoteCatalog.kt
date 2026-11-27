package app.simple.felicity.remote

/**
 * Process-wide registry of remote tracks that have been handed to the player, keyed by
 * their synthetic audio id (see [RemoteIds]). The player, notification artwork and cover
 * loaders use it to find the cover URL and quality info of a streaming track without
 * adding columns to the local `Audio` table. Bounded so long radio sessions don't grow it forever.
 */
object RemoteCatalog {

    private const val MAX_ENTRIES = 4_000

    private val entries = object : LinkedHashMap<Long, RemoteTrack>(256, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Long, RemoteTrack>?): Boolean = size > MAX_ENTRIES
    }

    @Synchronized
    fun register(track: RemoteTrack): Long {
        val id = RemoteIds.audioIdFor(track.id)
        entries[id] = track
        return id
    }

    @Synchronized
    fun get(audioId: Long): RemoteTrack? = entries[audioId]

    @Synchronized
    fun size(): Int = entries.size

    @Synchronized
    fun clear() = entries.clear()
}
