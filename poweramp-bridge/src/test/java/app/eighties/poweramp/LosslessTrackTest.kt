package app.eighties.poweramp

import app.eighties.poweramp.data.LosslessTrack
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LosslessTrackTest {

    @Test
    fun `formats Hi-Res FLAC badge and MIME accurately`() {
        val hiRes = LosslessTrack(
            id = "hifi:123",
            provider = "hifi",
            title = "Karma Police",
            artist = "Radiohead",
            durationMs = 264_000L,
            codec = "FLAC",
            bitDepth = 24,
            sampleRate = 96_000,
        )
        assertTrue(hiRes.isHiRes)
        assertEquals("HI-RES · 24-bit/96kHz", hiRes.badgeText)
        assertEquals("audio/flac", hiRes.mimeType)
        assertEquals(264_000L, hiRes.effectiveDurationMs)

        val cd = hiRes.copy(bitDepth = 16, sampleRate = 44_100, qualityTier = "LOSSLESS")
        assertFalse(cd.isHiRes)
        assertEquals("FLAC · 16-bit/44.1kHz", cd.badgeText)
    }
}
