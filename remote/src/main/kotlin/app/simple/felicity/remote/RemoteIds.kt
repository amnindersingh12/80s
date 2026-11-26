package app.simple.felicity.remote

/**
 * Remote tracks play through Felicity's normal `Audio` pipeline, which is keyed by a `Long`
 * id. Room assigns positive ids to local files, so remote tracks get a stable *negative* id
 * derived from their public `<provider>:<id>` — the two ranges can never collide.
 */
object RemoteIds {

    fun audioIdFor(publicId: String): Long {
        var h = -0x340d631b7bdddcdbL // FNV-1a 64 offset basis
        for (b in publicId.toByteArray(Charsets.UTF_8)) {
            h = h xor (b.toLong() and 0xff)
            h *= 0x100000001b3L
        }
        return -(h and Long.MAX_VALUE) - 1 // always in [Long.MIN_VALUE, -1]
    }

    fun isRemoteAudioId(id: Long): Boolean = id < 0

    /** Content hash used by Felicity's stats tables; distinct from local XXHash values in practice. */
    fun hashFor(publicId: String): Long = audioIdFor("hash:$publicId")

    fun isRemoteUri(uri: String?): Boolean =
        uri != null && (uri.startsWith("http://", ignoreCase = true) || uri.startsWith("https://", ignoreCase = true))
}
