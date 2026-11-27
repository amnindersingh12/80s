package app.eighties.poweramp

import app.eighties.poweramp.data.BridgeApiClient
import app.eighties.poweramp.data.LosslessTrack
import app.eighties.poweramp.data.SearchTopResult
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeApiClientTest {

    private fun fakeClient(handler: (okhttp3.Request) -> Pair<Int, String>): OkHttpClient {
        return OkHttpClient.Builder()
            .addInterceptor { chain ->
                val req = chain.request()
                val (code, json) = handler(req)
                Response.Builder()
                    .request(req)
                    .protocol(Protocol.HTTP_1_1)
                    .code(code)
                    .message("OK")
                    .body(json.toResponseBody())
                    .build()
            }
            .build()
    }

    @Test
    fun `search filters out lossy tracks and resolves absolute signed stream URL`() = runTest {
        val seenKeys = mutableListOf<String?>()
        val client = BridgeApiClient(
            serverUrlProvider = { "https://example.test" },
            accessKeyProvider = { "secret-key-123" },
            client = fakeClient { req ->
                seenKeys.add(req.header("X-Access-Key"))
                when {
                    req.url.encodedPath == "/api/search" -> 200 to """
                        {
                          "tracks": [
                            {"id":"hifi:1","title":"FLAC Song","artist":"Artist","lossless":true,"format":"flac","bitDepth":24,"sampleRate":96000},
                            {"id":"hifi:2","title":"MP3 Song","artist":"Artist","lossless":false,"format":"mp3"}
                          ]
                        }
                    """.trimIndent()
                    req.url.encodedPath == "/api/tracks/hifi:1/prepare" -> 200 to """
                        {
                          "id":"hifi:1",
                          "state":"ready",
                          "signedStreamUrl":"/api/stream/hifi%3A1?st=9999999999.abc"
                        }
                    """.trimIndent()
                    else -> 404 to "{}"
                }
            },
        )

        val tracks = client.search("test")
        assertEquals(1, tracks.size)
        assertEquals("hifi:1", tracks[0].id)
        assertEquals("HI-RES · 24-bit/96kHz", tracks[0].badgeText)

        val prepared = client.prepareOrResolve(tracks[0])
        assertEquals("https://example.test/api/stream/hifi%3A1?st=9999999999.abc", prepared.signedStreamUrl)
        assertTrue(seenKeys.all { it == "secret-key-123" })
    }

    @Test
    fun `resolve endpoint returns signedStreamUrl for recommendation seeds`() = runTest {
        val client = BridgeApiClient(
            serverUrlProvider = { "https://example.test" },
            accessKeyProvider = { "" },
            client = fakeClient { req ->
                if (req.url.encodedPath == "/api/tracks/resolve") {
                    200 to """
                        {
                          "track":{"id":"remote:42","title":"Karma Police","artist":"Radiohead","lossless":true,"format":"flac"},
                          "prepare":{"id":"remote:42","state":"ready"},
                          "signedStreamUrl":"/api/stream/remote%3A42?st=123.sig"
                        }
                    """.trimIndent()
                } else 404 to "{}"
            },
        )
        val seed = LosslessTrack(
            id = LosslessTrack.resolveSeedId("Radiohead", "Karma Police", "OK Computer"),
            provider = "rec",
            title = "Karma Police",
            artist = "Radiohead",
        )
        val resolved = client.prepareOrResolve(seed)
        assertEquals("remote:42", resolved.track.id)
        assertEquals("https://example.test/api/stream/remote%3A42?st=123.sig", resolved.signedStreamUrl)
    }

    @Test
    fun `searchCatalog, artistDetail, albumDetail, and homeFeed parse structured payloads`() = runTest {
        val client = BridgeApiClient(
            serverUrlProvider = { "https://example.test" },
            accessKeyProvider = { "key" },
            client = fakeClient { req ->
                when (req.url.encodedPath) {
                    "/api/search" -> 200 to """
                        {
                          "query":"Coldplay",
                          "topResult":{"kind":"artist","item":{"id":"hifi:a1","name":"Coldplay"}},
                          "tracks":[{"id":"hifi:t1","title":"Yellow","artist":"Coldplay","lossless":true,"format":"flac"}],
                          "artists":[{"id":"hifi:a1","name":"Coldplay"}],
                          "albums":[{"id":"hifi:al1","title":"Parachutes","artist":"Coldplay","year":2000}]
                        }
                    """.trimIndent()
                    "/api/artists/hifi:a1" -> 200 to """
                        {
                          "id":"hifi:a1","name":"Coldplay","genres":["Rock"],
                          "topTracks":[{"id":"hifi:t1","title":"Yellow","artist":"Coldplay","lossless":true}],
                          "albums":[{"id":"hifi:al1","title":"Parachutes","artist":"Coldplay"}],
                          "similarArtists":[{"name":"Keane"}]
                        }
                    """.trimIndent()
                    "/api/albums/hifi:al1" -> 200 to """
                        {
                          "id":"hifi:al1","title":"Parachutes","artist":"Coldplay","year":2000,"trackCount":1,"totalDurationMs":266000,"codec":"FLAC","qualityTier":"LOSSLESS",
                          "tracks":[{"id":"hifi:t1","title":"Yellow","artist":"Coldplay","lossless":true,"trackNumber":1}]
                        }
                    """.trimIndent()
                    "/api/home" -> 200 to """
                        {
                          "genre":"mixed",
                          "featuredTrack":{"id":"hifi:t1","title":"Yellow","artist":"Coldplay","lossless":true},
                          "becauseYouPlayed":{"label":"Because you played Yellow","tracks":[{"track":{"id":"hifi:t2","title":"Clocks","artist":"Coldplay","lossless":true}}]},
                          "relatedTracks":[{"track":{"id":"hifi:t1","title":"Yellow","artist":"Coldplay","lossless":true}}],
                          "albums":[{"id":"hifi:al1","title":"Parachutes","artist":"Coldplay"}],
                          "similarArtists":[{"name":"Keane"}]
                        }
                    """.trimIndent()
                    else -> 404 to "{}"
                }
            },
        )
        val search = client.searchCatalog("Coldplay")
        assertTrue(search.topResult is SearchTopResult.ArtistHit)
        assertEquals(1, search.artists.size)
        assertEquals(1, search.albums.size)

        val artist = client.artistDetail("hifi:a1")
        assertEquals("Coldplay", artist.name)
        assertEquals(1, artist.similarArtists.size)

        val album = client.albumDetail("hifi:al1")
        assertEquals("Parachutes", album.title)
        assertEquals(1, album.tracks.size)

        val feed = client.homeFeed(genre = "mixed", nowPlayingArtist = "Coldplay", nowPlayingTrack = "Yellow")
        assertEquals("Yellow", feed.featuredTrack?.title)
        assertEquals(1, feed.becauseYouPlayed.size)
    }
}
