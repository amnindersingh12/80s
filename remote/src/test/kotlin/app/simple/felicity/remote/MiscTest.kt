package app.simple.felicity.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MiscTest {

    @Test
    fun `parses the server's Content-Disposition including RFC 5987 names`() {
        assertEquals(
                "Diljit Dosanjh - Lover.flac",
                ContentDisposition.filename("""attachment; filename="Diljit Dosanjh - Lover.flac"; filename*=UTF-8''Diljit%20Dosanjh%20-%20Lover.flac"""),
        )
        assertEquals(
                "Gurdas Maan - ਪਿਆਰ Pyaar.flac",
                ContentDisposition.filename("""attachment; filename="Gurdas Maan - _ Pyaar.flac"; filename*=UTF-8''Gurdas%20Maan%20-%20%E0%A8%AA%E0%A8%BF%E0%A8%86%E0%A8%B0%20Pyaar.flac"""),
        )
        assertEquals("a b.flac", ContentDisposition.filename("attachment; filename=\"a b.flac\""))
        assertEquals("plain.flac", ContentDisposition.filename("attachment; filename=plain.flac"))
        assertNull(ContentDisposition.filename(null))
        assertNull(ContentDisposition.filename("inline"))
    }

    @Test
    fun `sanitises hostile filenames`() {
        assertEquals("passwd", ContentDisposition.filename("""attachment; filename="../../etc/passwd""""))
        assertEquals("AC DC - Back In Black.flac", ContentDisposition.sanitize("AC/DC - Back In Black.flac"))
        assertEquals("AC DC - Back In Black.flac", ContentDisposition.fallback("AC/DC", "Back In Black"))
        assertEquals("a b.flac", ContentDisposition.sanitize("a:b.flac"))
        assertEquals("AP Dhillon - With You.flac", ContentDisposition.fallback("AP Dhillon", "With You"))
        assertEquals("track.wav", ContentDisposition.fallback(null, " ", "wav"))
    }

    @Test
    fun `remote audio ids are stable, negative and distinct`() {
        val a = RemoteIds.audioIdFor("remote:t1")
        assertEquals(a, RemoteIds.audioIdFor("remote:t1"))
        assertTrue(a < 0)
        assertNotEquals(a, RemoteIds.audioIdFor("remote:t2"))
        assertNotEquals(a, RemoteIds.hashFor("remote:t1"))
        assertTrue((1..2000).map { RemoteIds.audioIdFor("demo:$it") }.all { it < 0 })
        assertEquals(2000, (1..2000).map { RemoteIds.audioIdFor("demo:$it") }.toSet().size)
        assertTrue(RemoteIds.isRemoteUri("https://x/api/stream/a:b"))
        assertTrue(!RemoteIds.isRemoteUri("content://media/1") && !RemoteIds.isRemoteUri("/sdcard/a.flac"))
    }

    @Test
    fun `catalog registers and bounds entries`() {
        RemoteCatalog.clear()
        val t = RemoteTrack("demo:1", "demo", "Lover", "Diljit Dosanjh")
        val id = RemoteCatalog.register(t)
        assertEquals(t, RemoteCatalog.get(id))
        repeat(5000) { RemoteCatalog.register(t.copy(id = "demo:x$it")) }
        assertTrue(RemoteCatalog.size() <= 4000)
    }

    @Test
    fun `quality labels match the web UI`() {
        assertEquals("FLAC 24/96", RemoteTrack("a:1", "a", "t", "a", format = "flac", lossless = true, bitDepth = 24, sampleRate = 96000).qualityLabel)
        assertEquals("WAV 16/44.1", RemoteTrack("a:1", "a", "t", "a", format = "wav", lossless = true, bitDepth = 16, sampleRate = 44100).qualityLabel)
        assertEquals("MP3 320", RemoteTrack("a:1", "a", "t", "a", format = "mp3", bitrateKbps = 320).qualityLabel)
        assertTrue(RemoteTrack("a:1", "a", "t", "a", bitDepth = 24).isHiRes)
    }
}
