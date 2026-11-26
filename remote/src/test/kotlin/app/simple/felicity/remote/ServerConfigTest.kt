package app.simple.felicity.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerConfigTest {

    private fun norm(s: String) = ServerConfig.normalizeBaseUrl(s).toString()

    @Test
    fun `adds a sensible scheme and normalises paths`() {
        assertEquals("http://192.168.1.20:8787/", norm("192.168.1.20:8787"))
        assertEquals("http://localhost:8787/", norm("localhost:8787"))
        assertEquals("http://nas.local/", norm("nas.local"))
        assertEquals("http://homeserver:8787/", norm("homeserver:8787"))
        assertEquals("https://music.example.com/", norm("music.example.com"))
        assertEquals("https://music.example.com/", norm("  https://music.example.com/api/  "))
        assertEquals("https://example.com/80s/", norm("https://example.com/80s"))
        assertEquals("https://example.com/80s/", norm("https://example.com/80s/api?x=1#y"))
        assertEquals("http://10.0.0.5/", norm("HTTP://10.0.0.5"))
    }

    @Test
    fun `rejects unusable addresses with a readable message`() {
        listOf("", "   ", "ftp://x.com", "http://", "a b.com", "https://user:pw@x.com").forEach { input ->
            val err = runCatching { ServerConfig.normalizeBaseUrl(input) }.exceptionOrNull()
            assertTrue("expected rejection for '$input' but got $err", err is InvalidServerUrlException)
        }
        assertTrue(runCatching { ServerConfig.normalizeBaseUrl("https://user:pw@x.com") }.exceptionOrNull()!!.message!!.contains("access key"))
    }

    @Test
    fun `blank url means not configured`() {
        assertNull(ServerConfig.from(null, "key"))
        assertNull(ServerConfig.from("  ", "key"))
        assertNull(ServerConfig.fromOrNull("ftp://nope", null))
    }

    @Test
    fun `builds api urls under a reverse-proxy prefix and encodes ids`() {
        val cfg = ServerConfig.from("https://example.com/80s", null)!!
        assertEquals("https://example.com/80s/api/stream/remote:t1", cfg.api("stream", "remote:t1").build().toString())
        assertEquals("https://example.com/80s/api/stream/subsonic:a%2Fb%20c", cfg.api("stream", "subsonic:a/b c").build().toString())
        assertEquals("http://h:1/api/health", ServerConfig.from("http://h:1", null)!!.api("health").build().toString())
    }

    @Test
    fun `resolves relative cover paths against the server, keeps absolute urls`() {
        val cfg = ServerConfig.from("https://example.com/80s/", null)!!
        assertEquals("https://example.com/80s/api/cover/subsonic:al-1", cfg.resolve("/api/cover/subsonic:al-1").toString())
        assertEquals("https://cdn.example.net/a.jpg", cfg.resolve("https://cdn.example.net/a.jpg").toString())
        assertNull(cfg.resolve(null))
        assertNull(cfg.resolve(""))
    }

    @Test
    fun `access key header only for the same origin`() {
        val cfg = ServerConfig.from("https://music.example.com", " secret-key-123 ")!!
        assertEquals(mapOf("Authorization" to "Bearer secret-key-123"), cfg.authHeadersFor("https://music.example.com/api/stream/remote:1"))
        assertEquals(emptyMap<String, String>(), cfg.authHeadersFor("https://cdn.r2.example.com/file.flac?sig=1"))
        assertEquals(emptyMap<String, String>(), cfg.authHeadersFor("http://music.example.com/api/x")) // scheme differs
        assertEquals(emptyMap<String, String>(), cfg.authHeadersFor("https://music.example.com:8443/api/x")) // port differs
        assertEquals(emptyMap<String, String>(), ServerConfig.from("https://music.example.com", "  ")!!.authHeadersFor("https://music.example.com/api/x"))
        assertFalse(ServerConfig.from("https://music.example.com", "")!!.hasAccessKey)
    }

    @Test
    fun `toString never reveals the key`() {
        val s = ServerConfig.from("https://x.com", "super-secret")!!.toString()
        assertFalse(s.contains("super-secret"))
        assertTrue(s.contains("***"))
    }
}
