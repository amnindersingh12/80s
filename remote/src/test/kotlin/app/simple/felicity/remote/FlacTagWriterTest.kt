package app.simple.felicity.remote

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayOutputStream

class FlacTagWriterTest {

    @get:Rule
    val tmp = TemporaryFolder()

    @Test
    fun embedsVorbisCommentsAndCoverWithoutAlteringAudioFrames() {
        val fakeAudio = byteArrayOf(0xFF.toByte(), 0xF8.toByte(), 0x11, 0x22, 0x33, 0x44)
        val rawFlac = ByteArrayOutputStream().apply {
            write("fLaC".toByteArray(Charsets.US_ASCII))
            // Single STREAMINFO block (isLast=1, type=0, length=34)
            write(0x80)
            write(0); write(0); write(34)
            write(ByteArray(34) { 0x01 })
            write(fakeAudio)
        }.toByteArray()

        val file = tmp.newFile("test.flac").apply { writeBytes(rawFlac) }
        val track = RemoteTrack(id = "hifi:1", provider = "hifi", title = "80's", artist = "Harnoor", album = "80's", year = 2024, trackNumber = 1)
        val fakeCover = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xD9.toByte())

        assertTrue(FlacTagWriter.embedIfMissing(file, track, fakeCover, "image/jpeg"))

        val out = file.readBytes()
        val text = out.toString(Charsets.UTF_8)
        assertTrue(out.copyOfRange(0, 4).contentEquals("fLaC".toByteArray(Charsets.US_ASCII)))
        assertTrue(text.contains("TITLE=80's"))
        assertTrue(text.contains("ARTIST=Harnoor"))
        assertTrue(text.contains("image/jpeg"))
        assertArrayEquals(fakeAudio, out.copyOfRange(out.size - fakeAudio.size, out.size))
    }

    @Test
    fun mergesPartialVorbisCommentsAndLyricsWithoutDroppingExistingTags() {
        val fakeAudio = byteArrayOf(0xFF.toByte(), 0xF8.toByte(), 0x55, 0x66)
        val existingComment = ByteArrayOutputStream().apply {
            fun leInt(v: Int) = java.nio.ByteBuffer.allocate(4).order(java.nio.ByteOrder.LITTLE_ENDIAN).putInt(v).array()
            val vendor = "vendor".toByteArray(Charsets.UTF_8)
            val tags = listOf("TITLE=Custom Title", "CUSTOM=keep-me")
            write(leInt(vendor.size)); write(vendor)
            write(leInt(tags.size))
            tags.forEach { t -> val b = t.toByteArray(Charsets.UTF_8); write(leInt(b.size)); write(b) }
        }.toByteArray()

        val rawFlac = ByteArrayOutputStream().apply {
            write("fLaC".toByteArray(Charsets.US_ASCII))
            write(0x00); write(0); write(0); write(34); write(ByteArray(34) { 0x01 })
            write(0x84)
            write((existingComment.size ushr 16) and 0xff)
            write((existingComment.size ushr 8) and 0xff)
            write(existingComment.size and 0xff)
            write(existingComment)
            write(fakeAudio)
        }.toByteArray()

        val file = tmp.newFile("partial.flac").apply { writeBytes(rawFlac) }
        val track = RemoteTrack(id = "hifi:2", provider = "hifi", title = "Ignored", artist = "Harnoor", album = "Single")
        assertTrue(FlacTagWriter.embedIfMissing(file, track, lyricsText = "[00:01.00] Line one"))

        val text = file.readBytes().toString(Charsets.UTF_8)
        assertTrue(text.contains("TITLE=Custom Title"))
        assertTrue(text.contains("CUSTOM=keep-me"))
        assertTrue(text.contains("ARTIST=Harnoor"))
        assertTrue(text.contains("ALBUM=Single"))
        assertTrue(text.contains("LYRICS=[00:01.00] Line one"))
    }
}
