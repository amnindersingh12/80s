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
}
