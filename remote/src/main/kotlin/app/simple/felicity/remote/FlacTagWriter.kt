package app.simple.felicity.remote

import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Pure-Kotlin FLAC metadata writer that ensures Vorbis Comments (`TITLE`, `ARTIST`, `ALBUM`,
 * `DATE`, `TRACKNUMBER`) and an optional front-cover `PICTURE` block are present without touching
 * audio frames or external dependencies. RFC 9639 SEEKTABLE offsets are relative to the first
 * audio frame, so inserting/replacing header metadata blocks preserves seeking intact.
 */
object FlacTagWriter {

    private const val BLOCK_STREAMINFO = 0
    private const val BLOCK_PADDING = 1
    private const val BLOCK_VORBIS_COMMENT = 4
    private const val BLOCK_PICTURE = 6
    private const val MAX_HEADER_SCAN_BYTES = 16 * 1024 * 1024L

    fun embedIfMissing(
        file: File,
        track: RemoteTrack,
        coverBytes: ByteArray? = null,
        coverMime: String = "image/jpeg",
    ): Boolean {
        if (!file.isFile || file.length() < 42) return false
        RandomAccessFile(file, "r").use { raf ->
            val magic = ByteArray(4)
            raf.readFully(magic)
            if (String(magic, Charsets.US_ASCII) != "fLaC") return false

            val preserved = mutableListOf<Pair<Int, ByteArray>>()
            var hasComments = false
            var hasPicture = false
            var isLast = false
            var audioOffset = 4L

            while (!isLast && raf.filePointer < file.length() && raf.filePointer < MAX_HEADER_SCAN_BYTES) {
                val hdr = raf.read()
                if (hdr < 0) return false
                isLast = (hdr and 0x80) != 0
                val type = hdr and 0x7f
                val b0 = raf.read()
                val b1 = raf.read()
                val b2 = raf.read()
                if ((b0 or b1 or b2) < 0) return false
                val len = (b0 shl 16) or (b1 shl 8) or b2
                if (len < 0 || raf.filePointer + len > file.length()) return false

                val payload = ByteArray(len)
                raf.readFully(payload)
                audioOffset = raf.filePointer

                when (type) {
                    BLOCK_PADDING -> Unit // trim excess padding
                    BLOCK_VORBIS_COMMENT -> {
                        hasComments = true
                        preserved += type to payload
                    }
                    BLOCK_PICTURE -> {
                        hasPicture = true
                        preserved += type to payload
                    }
                    else -> preserved += type to payload
                }
            }

            if (preserved.none { it.first == BLOCK_STREAMINFO }) return false
            val needComments = !hasComments
            val needPicture = !hasPicture && coverBytes != null && coverBytes.isNotEmpty()
            if (!needComments && !needPicture) return false

            if (needComments) preserved += BLOCK_VORBIS_COMMENT to buildVorbisComment(track)
            if (needPicture) preserved += BLOCK_PICTURE to buildPictureBlock(coverBytes, coverMime)

            val tmp = File(file.parentFile, "${file.name}.tagtmp")
            try {
                tmp.outputStream().buffered().use { out ->
                    out.write("fLaC".toByteArray(Charsets.US_ASCII))
                    preserved.forEachIndexed { idx, (type, payload) ->
                        val lastBit = if (idx == preserved.lastIndex) 0x80 else 0x00
                        out.write(lastBit or (type and 0x7f))
                        out.write((payload.size ushr 16) and 0xff)
                        out.write((payload.size ushr 8) and 0xff)
                        out.write(payload.size and 0xff)
                        out.write(payload)
                    }
                    raf.seek(audioOffset)
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = raf.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                    }
                }
                if (!tmp.renameTo(file)) {
                    tmp.copyTo(file, overwrite = true)
                    tmp.delete()
                }
                return true
            } catch (e: Exception) {
                tmp.delete()
                throw e
            }
        }
    }

    private fun buildVorbisComment(track: RemoteTrack): ByteArray {
        val comments = buildList {
            add("TITLE=${track.title}")
            add("ARTIST=${track.artist}")
            track.album?.takeIf { it.isNotBlank() }?.let { add("ALBUM=$it") }
            add("ALBUMARTIST=${track.artist}")
            track.year?.let { add("DATE=$it") }
            track.trackNumber?.let { add("TRACKNUMBER=$it") }
        }
        val out = ByteArrayOutputStream()
        val vendor = "80s-felicity".toByteArray(Charsets.UTF_8)
        out.writeLeInt(vendor.size)
        out.write(vendor)
        out.writeLeInt(comments.size)
        for (c in comments) {
            val bytes = c.toByteArray(Charsets.UTF_8)
            out.writeLeInt(bytes.size)
            out.write(bytes)
        }
        return out.toByteArray()
    }

    private fun buildPictureBlock(data: ByteArray, mime: String): ByteArray {
        val mimeBytes = mime.substringBefore(';').trim().ifBlank { "image/jpeg" }.toByteArray(Charsets.US_ASCII)
        val out = ByteArrayOutputStream()
        val dos = DataOutputStream(out)
        dos.writeInt(3) // Picture type 3: Cover (front)
        dos.writeInt(mimeBytes.size)
        dos.write(mimeBytes)
        dos.writeInt(0) // description length
        dos.writeInt(0) // width (unknown)
        dos.writeInt(0) // height (unknown)
        dos.writeInt(0) // color depth
        dos.writeInt(0) // indexed colors
        dos.writeInt(data.size)
        dos.write(data)
        dos.flush()
        return out.toByteArray()
    }

    private fun ByteArrayOutputStream.writeLeInt(value: Int) {
        val buf = ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(value).array()
        write(buf)
    }
}
