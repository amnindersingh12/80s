package app.simple.felicity.remote

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WebApiClientTest {

    private val server = FakeServer()
    private var config: ServerConfig? = ServerConfig.from("https://music.example.com/80s", "correct-horse-key")
    private val api = WebApiClient({ config }, server.client(), Dispatchers.Unconfined)

    private fun last(): Request = server.requests.last().request

    @Test
    fun `health maps providers and sources`() = runBlocking {
        server.on("GET", "/80s/api/health") {
            FakeServer.json(it, 200, """{"ok":true,"demo":false,"providers":[{"name":"remote","kind":"remote-media","role":"primary","circuit":"open","lastError":"timed out"},{"name":"subsonic","role":"fallback","circuit":"closed"}],"recommendations":{"lastfm":true,"listenbrainz":true,"musicbrainz":false},"cache":"redis","accessRequired":true,"authenticated":true}""")
        }
        val h = api.health()
        assertEquals("remote", h.primary?.name)
        assertTrue(h.primary!!.circuitOpen)
        assertEquals("subsonic", h.fallback?.name)
        assertEquals(mapOf("lastfm" to true, "listenbrainz" to true, "musicbrainz" to false), h.recommendationSources)
        assertTrue(h.accessRequired && h.authenticated)
        assertEquals("redis", h.cache)
    }

    @Test
    fun `health rejects servers that are not web`() = runBlocking {
        server.on("GET", "/80s/api/health") { FakeServer.json(it, 200, """{"status":"up"}""") }
        val err = runCatching { api.health() }.exceptionOrNull() as RemoteApiException
        assertEquals(RemoteApiException.BAD_RESPONSE, err.code)
    }

    @Test
    fun `search builds the url, maps tracks and resolves relative covers`() = runBlocking {
        server.on("GET", "/80s/api/search") {
            FakeServer.json(it, 200, """{"query":"lover","provider":"remote","fallback":false,"cached":true,"tracks":[
              {"id":"remote:t1","provider":"remote","title":"Lover","artist":"Diljit Dosanjh","album":"MoonChild Era","durationSec":182,"coverUrl":"/api/cover/remote:c1","format":"flac","lossless":true,"bitDepth":24,"sampleRate":96000},
              {"id":"no-prefix","title":"broken"},
              {"id":"subsonic:9","title":"","artist":null,"coverUrl":"https://cdn.example.net/x.jpg"}]}""")
        }
        val res = api.search("lover ❤", limit = 99)
        val url = last().url
        assertEquals("/80s/api/search", url.encodedPath)
        assertEquals("lover ❤", url.queryParameter("q"))
        assertEquals("50", url.queryParameter("limit"))
        assertEquals(2, res.tracks.size)
        val t = res.tracks[0]
        assertEquals("https://music.example.com/80s/api/cover/remote:c1", t.coverUrl)
        assertEquals(182, t.durationSec)
        assertTrue(t.isHiRes)
        assertEquals("FLAC 24/96", t.qualityLabel)
        assertEquals("Untitled", res.tracks[1].title)
        assertEquals("Unknown artist", res.tracks[1].artist)
        assertEquals("https://cdn.example.net/x.jpg", res.tracks[1].coverUrl)
        assertTrue(res.cached)
    }

    @Test
    fun `injects the access key header on every server request and follows settings changes`() = runBlocking {
        server.on("GET", "/80s/api/search") { FakeServer.json(it, 200, """{"tracks":[]}""") }
        api.search("a")
        assertEquals("Bearer correct-horse-key", last().header("Authorization"))

        config = ServerConfig.from("https://music.example.com/80s", "rotated-key-456")
        api.search("b")
        assertEquals("Bearer rotated-key-456", last().header("Authorization"))

        config = ServerConfig.from("https://music.example.com/80s", null)
        api.search("c")
        assertNull(last().header("Authorization"))
    }

    @Test
    fun `interceptor never sends the key to another origin`() {
        val seen = mutableListOf<Request>()
        val cfg = ServerConfig.from("https://music.example.com", "k-123456789012")
        val client = OkHttpClient.Builder()
            .addInterceptor(AccessKeyInterceptor { cfg })
            .addInterceptor(Interceptor { chain -> seen += chain.request(); FakeServer.json(chain.request(), 200, "{}") })
            .build()
        client.newCall(Request.Builder().url("https://cdn.r2.example.com/a.flac".toHttpUrl()).build()).execute().close()
        client.newCall(Request.Builder().url("https://music.example.com/api/health".toHttpUrl()).build()).execute().close()
        assertNull(seen[0].header("Authorization"))
        assertEquals("Bearer k-123456789012", seen[1].header("Authorization"))
    }

    @Test
    fun `prepare handles 200 ready, 202 preparing and 5xx job errors as states`() = runBlocking {
        server.on("POST", "/80s/api/tracks/remote:t1/prepare") {
            FakeServer.json(it, 200, """{"id":"remote:t1","state":"ready","servedBy":"remote","fallback":false}""")
        }
        server.on("POST", "/80s/api/tracks/remote:t2/prepare") {
            FakeServer.json(it, 202, """{"id":"remote:t2","state":"preparing","stage":"uploading","progress":0.42,"elapsedMs":1200}""")
        }
        server.on("GET", "/80s/api/tracks/remote:t3/prepare") {
            FakeServer.json(it, 504, """{"id":"remote:t3","state":"error","error":{"code":"JOB_TIMEOUT","message":"still packaging","retryable":true}}""")
        }
        assertEquals("ready", api.prepare("remote:t1").state)
        assertEquals("POST", last().method)

        val p = api.prepare("remote:t2")
        assertEquals("preparing", p.state)
        assertEquals(0.42f, p.progress!!, 0.0001f)
        assertEquals("uploading", p.stage)

        val e = api.prepareStatus("remote:t3")
        assertEquals("error", e.state)
        assertEquals("JOB_TIMEOUT", e.error?.code)
        assertTrue(e.error!!.retryable)
        assertEquals("GET", last().method)
    }

    @Test
    fun `maps API errors, access denial, bad JSON and network failures`() = runBlocking {
        server.on("GET", "/80s/api/search") {
            when (it.url.queryParameter("q")) {
                "locked" -> FakeServer.json(it, 401, """{"error":{"code":"ACCESS_REQUIRED","message":"Unlock the player with the access key first","retryable":false}}""")
                "down" -> FakeServer.json(it, 503, """{"error":{"code":"UPSTREAM_UNAVAILABLE","message":"down","retryable":true}}""")
                "html" -> FakeServer.json(it, 200, "<html>proxy login</html>")
                "bare404" -> FakeServer.json(it, 404, "nope")
                else -> FakeServer.fail()
            }
        }
        suspend fun err(q: String) = runCatching { api.search(q) }.exceptionOrNull() as RemoteApiException

        err("locked").let { assertTrue(it.isAccessDenied); assertEquals(401, it.httpStatus); assertFalse(it.retryable) }
        err("down").let { assertEquals("UPSTREAM_UNAVAILABLE", it.code); assertTrue(it.retryable) }
        err("html").let { assertEquals(RemoteApiException.BAD_RESPONSE, it.code) }
        err("bare404").let { assertEquals("HTTP_404", it.code); assertTrue(it.message.contains("80s web server")) }
        err("offline").let { assertEquals(RemoteApiException.NETWORK, it.code); assertTrue(it.retryable) }

        config = null
        assertEquals(RemoteApiException.NOT_CONFIGURED, err("x").code)
    }

    @Test
    fun `recommendations separate playable from metadata-only`() = runBlocking {
        server.on("GET", "/80s/api/recommendations") {
            FakeServer.json(it, 200, """{"seed":{"type":"tag","tag":"punjabi pop","label":"Punjabi Pop"},
              "similarArtists":[{"name":"AP Dhillon","score":1,"sources":["lastfm"],"playable":true}],
              "relatedTracks":[
                {"key":"ap dhillon|excuses","title":"Excuses","artist":"AP Dhillon","score":1,"sources":["lastfm"],"availability":"playable","track":{"id":"remote:t2","title":"Excuses","artist":"AP Dhillon","lossless":true}},
                {"key":"x|deep cut","title":"Deep Cut","artist":"X","score":0.5,"sources":["listenbrainz"],"availability":"metadata-only","coverUrl":"https://coverartarchive.org/r/1"}],
              "tags":["bhangra"],"sources":{"lastfm":"ok","listenbrainz":"ok","musicbrainz":"error"},"warnings":["MusicBrainz: 503"]}""")
        }
        val r = api.recommendations(RecommendationSeed.tag("Punjabi Pop"))
        val q = last().url
        assertEquals("tag", q.queryParameter("type"))
        assertEquals("punjabi pop", q.queryParameter("tag"))
        assertEquals("Punjabi Pop", r.seedLabel)
        assertTrue(r.relatedTracks[0].playable)
        assertEquals("ap dhillon|excuses", r.relatedTracks[0].track?.key)
        assertFalse(r.relatedTracks[1].playable)
        assertEquals("error", r.sources["musicbrainz"])
        assertTrue(r.similarArtists[0].playable)
    }

    @Test
    fun `radio posts seed and exclusions as JSON`() = runBlocking {
        server.on("POST", "/80s/api/radio") {
            FakeServer.json(it, 200, """{"seed":{"label":"Lover — Diljit Dosanjh"},"tracks":[{"id":"remote:t9","title":"G.O.A.T.","artist":"Diljit Dosanjh","key":"diljit dosanjh|goat","reason":"More by Diljit Dosanjh"}],"exhausted":false,"warnings":[]}""")
        }
        val seed = RecommendationSeed.track(RemoteTrack("remote:t1", "remote", "Lover", "Diljit Dosanjh"))
        val batch = api.radio(seed, exclude = listOf("remote:t1", "remote:t1", "diljit dosanjh|lover"), limit = 10)
        val body = server.requests.last().body!!
        assertTrue(body.contains(""""type":"track""""))
        assertTrue(body.contains(""""trackId":"remote:t1""""))
        assertTrue(body.contains(""""exclude":["remote:t1","diljit dosanjh|lover"]"""))
        assertTrue(body.contains(""""limit":10"""))
        assertEquals("More by Diljit Dosanjh", batch.tracks.single().reason)
    }

    @Test
    fun `download streams bytes and uses the server filename`() = runBlocking {
        val payload = ByteArray(4096) { (it % 251).toByte() }
        server.on("GET", "/80s/api/download/remote:pa") {
            FakeServer.bytes(it, 200, payload, mapOf(
                    "content-type" to "audio/flac",
                    "content-disposition" to "attachment; filename=\"Gurdas Maan - _ Pyaar.flac\"; filename*=UTF-8''Gurdas%20Maan%20-%20%E0%A8%AA%E0%A8%BF%E0%A8%86%E0%A8%B0%20Pyaar.flac",
            ))
        }
        val track = RemoteTrack("remote:pa", "remote", "ਪਿਆਰ Pyaar", "Gurdas Maan")
        val (info, bytes) = api.download(track) { info, input -> info to input.readBytes() }
        assertEquals("Gurdas Maan - ਪਿਆਰ Pyaar.flac", info.filename)
        assertArrayEquals(payload, bytes)
        val url = last().url
        assertEquals("Gurdas Maan", url.queryParameter("artist"))
        assertEquals("Bearer correct-horse-key", last().header("Authorization"))
    }

    @Test
    fun `download falls back to Artist - Title when no header is sent`() = runBlocking {
        server.on("GET", "/80s/api/download/") { FakeServer.bytes(it, 200, byteArrayOf(1), mapOf("content-type" to "audio/wav")) }
        val info = api.download(RemoteTrack("demo:1", "demo", "Lover", "Diljit Dosanjh")) { info, _ -> info }
        assertEquals("Diljit Dosanjh - Lover.wav", info.filename)
    }

    @Test
    fun `stream urls carry the encoded public id`() {
        assertEquals("https://music.example.com/80s/api/stream/remote:t1", api.streamUrl("remote:t1"))
    }
}
