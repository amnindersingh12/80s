package app.simple.felicity.remote

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.SocketTimeoutException
import java.util.concurrent.TimeUnit

class WakeRetryTest {

    private val server = FakeServer()
    private val config = ServerConfig.from("https://my-80s.herokuapp.com", null)
    private val api = WebApiClient({ config }, server.client(), Dispatchers.Unconfined)
    private val healthJson = """{"ok":true,"demo":false,"providers":[],"recommendations":{},"cache":"memory","accessRequired":false,"authenticated":true}"""

    @Test
    fun `default client waits 20 s to connect and read`() {
        val c = WebApiClient.defaultHttpClient()
        assertEquals(TimeUnit.SECONDS.toMillis(20), c.connectTimeoutMillis.toLong())
        assertEquals(TimeUnit.SECONDS.toMillis(20), c.readTimeoutMillis.toLong())
    }

    @Test
    fun `a timeout on a sleeping dyno reports waking and retries once`() = runBlocking {
        var calls = 0
        server.on("GET", "/api/health") {
            calls++
            if (calls == 1) throw SocketTimeoutException("timeout") else FakeServer.json(it, 200, healthJson)
        }
        var waking = 0
        val health = withWakeRetry({ waking++ }) { api.health() }
        assertFalse(health.demo)
        assertEquals(2, calls)
        assertEquals(1, waking)
    }

    @Test
    fun `a platform 503 without a web JSON body counts as cold start`() = runBlocking {
        var calls = 0
        server.on("GET", "/api/health") {
            calls++
            if (calls == 1) FakeServer.json(it, 503, "<html>Application Error</html>") else FakeServer.json(it, 200, healthJson)
        }
        withWakeRetry { api.health() }
        assertEquals(2, calls)
    }

    @Test
    fun `health exposes boot config errors`() = runBlocking {
        server.on("GET", "/api/health") {
            FakeServer.json(it, 200, healthJson.replace("\"cache\"", "\"configErrors\":[\"SUPABASE_URL is required\"],\"cache\""))
        }
        assertEquals(listOf("SUPABASE_URL is required"), api.health().configErrors)
    }

    @Test
    fun `real errors are not retried`() = runBlocking {
        var calls = 0
        server.on("GET", "/api/search") {
            calls++
            FakeServer.json(it, 503, """{"error":{"code":"UPSTREAM_UNAVAILABLE","message":"down","retryable":true}}""")
        }
        val e = runCatching { withWakeRetry { api.search("x") } }.exceptionOrNull() as RemoteApiException
        assertEquals("UPSTREAM_UNAVAILABLE", e.code)
        assertFalse(e.looksLikeColdStart)
        assertEquals(1, calls)

        server.on("GET", "/api/search") { calls++; FakeServer.fail() } // connection refused ≠ waking
        val refused = runCatching { withWakeRetry { api.search("y") } }.exceptionOrNull() as RemoteApiException
        assertEquals(RemoteApiException.NETWORK, refused.code)
        assertFalse(refused.looksLikeColdStart)
        assertTrue(calls == 2)
    }
}
