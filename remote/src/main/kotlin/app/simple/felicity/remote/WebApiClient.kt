package app.simple.felicity.remote

import com.google.gson.Gson
import com.google.gson.JsonParseException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** The two prepare calls, split out so [PreparePoller] can be tested with a fake. */
interface PrepareApi {
    /** `POST /api/tracks/:id/prepare` — starts or joins the upstream job. */
    suspend fun prepare(id: String): PrepareStatus

    /** `GET /api/tracks/:id/prepare` — current job status. */
    suspend fun prepareStatus(id: String): PrepareStatus
}

/** Metadata for a download that is about to be streamed to disk. */
data class DownloadInfo(val filename: String, val contentType: String?, val contentLength: Long)

/**
 * Typed client for the `web/` Fastify API.
 *
 * [config] is read on every call, so it always reflects the latest settings and returns
 * [RemoteApiException.NOT_CONFIGURED] when no server is set. The access key is injected by
 * [AccessKeyInterceptor] for the server's own origin only.
 */
class WebApiClient(
        private val config: () -> ServerConfig?,
        baseClient: OkHttpClient = defaultHttpClient(),
        private val io: CoroutineDispatcher = Dispatchers.IO,
        private val gson: Gson = Gson(),
) : PrepareApi {

    // Auth goes first so every other interceptor (logging, caching, tests) sees the final request.
    private val client: OkHttpClient = baseClient.newBuilder()
        .apply { interceptors().add(0, AccessKeyInterceptor(config)) }
        .build()

    /** Downloads can take minutes on slow links: no call timeout, generous read timeout. */
    private val downloadClient: OkHttpClient = client.newBuilder()
        .callTimeout(0, TimeUnit.MILLISECONDS)
        .readTimeout(90, TimeUnit.SECONDS)
        .build()

    fun requireConfig(): ServerConfig = config() ?: throw RemoteApiException.notConfigured()

    // ------------------------------------------------------------ endpoints ---

    suspend fun health(): ServerHealth {
        val dto = getJson<HealthDto>(requireConfig().api("health").build())
        if (dto.ok != true) throw RemoteApiException(200, RemoteApiException.BAD_RESPONSE, "This doesn't look like an 80s web server (no ok:true in /api/health)", false)
        return ServerHealth(
                demo = dto.demo ?: false,
                providers = dto.providers.orEmpty().mapNotNull { p ->
                    p.name?.let { ProviderHealth(it, p.kind, p.role, p.circuit == "open", p.lastError) }
                },
                recommendationSources = dto.recommendations.orEmpty(),
                cache = dto.cache,
                accessRequired = dto.accessRequired ?: false,
                authenticated = dto.authenticated ?: true,
                configErrors = dto.configErrors.orEmpty(),
        )
    }

    suspend fun search(query: String, limit: Int = 30): SearchResult {
        val cfg = requireConfig()
        val url = cfg.api("search").addQueryParameter("q", query).addQueryParameter("limit", limit.coerceIn(1, 50).toString()).build()
        val dto = getJson<SearchDto>(url)
        return SearchResult(
                query = dto.query ?: query,
                tracks = dto.tracks.orEmpty().mapNotNull { it.toDomain(cfg) },
                provider = dto.provider,
                fallback = dto.fallback ?: false,
                cached = dto.cached ?: false,
        )
    }

    override suspend fun prepare(id: String): PrepareStatus = prepareCall(id, post = true)

    override suspend fun prepareStatus(id: String): PrepareStatus = prepareCall(id, post = false)

    suspend fun recommendations(seed: RecommendationSeed, limit: Int = 24): Recommendations {
        val cfg = requireConfig()
        val b = cfg.api("recommendations").addQueryParameter("type", seed.type.wire)
        seed.trackId?.let { b.addQueryParameter("trackId", it) }
        seed.artist?.let { b.addQueryParameter("artist", it) }
        seed.title?.let { b.addQueryParameter("title", it) }
        seed.tag?.let { b.addQueryParameter("tag", it) }
        b.addQueryParameter("limit", limit.coerceIn(1, 50).toString())
        return parseRecommendations(getJson<RecommendationsDto>(b.build()), cfg, seed)
    }

    suspend fun home(genre: String? = null, seedArtist: String? = null, limit: Int = 24): Recommendations {
        val cfg = requireConfig()
        val b = cfg.api("home").addQueryParameter("limit", limit.coerceIn(1, 50).toString())
        genre?.takeIf { it.isNotBlank() }?.let { b.addQueryParameter("genre", it) }
        seedArtist?.takeIf { it.isNotBlank() }?.let { b.addQueryParameter("seedArtist", it) }
        val fallbackSeed = if (!seedArtist.isNullOrBlank()) RecommendationSeed.artist(seedArtist) else RecommendationSeed.tag(genre ?: "punjabi pop")
        return parseRecommendations(getJson<RecommendationsDto>(b.build()), cfg, fallbackSeed)
    }

    suspend fun resolve(title: String, artist: String, album: String? = null): ResolveResult {
        val cfg = requireConfig()
        val body = buildMap {
            put("title", title)
            put("artist", artist)
            album?.takeIf { it.isNotBlank() }?.let { put("album", it) }
        }
        val request = Request.Builder().url(cfg.api("tracks", "resolve").build())
            .post(gson.toJson(body).toRequestBody(JSON))
            .build()
        val dto = decode<ResolveDto>(request)
        val track = dto.track?.toDomain(cfg)
            ?: throw RemoteApiException(200, RemoteApiException.BAD_RESPONSE, "Server returned no resolved track", false)
        val prepare = dto.prepare?.toDomain(track.id, 200) ?: PrepareStatus(track.id, "ready")
        return ResolveResult(track, prepare)
    }

    private fun parseRecommendations(dto: RecommendationsDto, cfg: ServerConfig, fallbackSeed: RecommendationSeed): Recommendations {
        return Recommendations(
                seedLabel = dto.seed?.label ?: fallbackSeed.artist ?: fallbackSeed.tag ?: "",
                seed = dto.seed.toSeed(fallbackSeed),
                similarArtists = dto.similarArtists.orEmpty().mapNotNull { a ->
                    a.name?.let { SimilarArtist(it, a.mbid, a.score ?: 0.0, a.sources.orEmpty(), cfg.resolve(a.imageUrl)?.toString(), a.playable ?: false) }
                },
                relatedTracks = dto.relatedTracks.orEmpty().mapNotNull { r ->
                    val key = r.key ?: return@mapNotNull null
                    RecommendedTrack(
                            key = key,
                            title = r.title ?: return@mapNotNull null,
                            artist = r.artist ?: return@mapNotNull null,
                            album = r.album,
                            durationSec = r.durationSec?.toInt(),
                            coverUrl = cfg.resolve(r.coverUrl)?.toString(),
                            score = r.score ?: 0.0,
                            sources = r.sources.orEmpty(),
                            track = if (r.availability == "playable") r.track?.toDomain(cfg, key, r.reason) else null,
                            reason = r.reason,
                    )
                },
                tags = dto.tags.orEmpty(),
                sources = dto.sources.orEmpty(),
                warnings = dto.warnings.orEmpty(),
        )
    }

    suspend fun radio(seed: RecommendationSeed, exclude: Collection<String> = emptyList(), limit: Int = 12): RadioBatch {
        val cfg = requireConfig()
        val body = mapOf(
                "seed" to buildMap {
                    put("type", seed.type.wire)
                    seed.trackId?.let { put("trackId", it) }
                    seed.artist?.let { put("artist", it) }
                    seed.title?.let { put("title", it) }
                    seed.tag?.let { put("tag", it) }
                },
                "exclude" to exclude.distinct().takeLast(900),
                "limit" to limit.coerceIn(1, 50),
        )
        val request = Request.Builder().url(cfg.api("radio").build())
            .post(gson.toJson(body).toRequestBody(JSON))
            .build()
        val dto = decode<RadioDto>(request)
        return RadioBatch(
                seedLabel = dto.seed?.label ?: "",
                tracks = dto.tracks.orEmpty().mapNotNull { it.toDomain(cfg) },
                exhausted = dto.exhausted ?: false,
                warnings = dto.warnings.orEmpty(),
        )
    }

    /** URL the player streams from (`GET /api/stream/:id`, Range-aware). */
    fun streamUrl(trackId: String): String = requireConfig().api("stream", trackId).build().toString()

    /** `GET /api/download/:id` with artist/title hints for the server's filename fallback. */
    fun downloadUrl(track: RemoteTrack): HttpUrl = requireConfig().api("download", track.id)
        .addQueryParameter("artist", track.artist)
        .addQueryParameter("title", track.title)
        .build()

    /**
     * Streams `/api/download/:id`. [sink] receives the server's filename (from
     * `Content-Disposition`, e.g. `Artist - Title.flac`) and the body stream; whatever it
     * returns is returned here. The response is always closed afterwards.
     */
    suspend fun <T> download(track: RemoteTrack, sink: suspend (DownloadInfo, InputStream) -> T): T {
        val request = Request.Builder().url(downloadUrl(track)).build()
        val response = await(downloadClient.newCall(request))
        return response.use { res ->
            if (!res.isSuccessful) throw errorFrom(res, res.body.string())
            val ext = res.header("content-type")?.let(::extensionForMime) ?: track.format ?: "flac"
            val name = ContentDisposition.filename(res.header("content-disposition"))
                ?: ContentDisposition.fallback(track.artist, track.title, ext)
            val info = DownloadInfo(name, res.header("content-type"), res.body.contentLength())
            withContext(io) { sink(info, res.body.byteStream()) }
        }
    }

    // ------------------------------------------------------------- plumbing ---

    private suspend fun prepareCall(id: String, post: Boolean): PrepareStatus {
        val url = requireConfig().api("tracks", id, "prepare").build()
        val request = Request.Builder().url(url).apply {
            if (post) post(ByteArray(0).toRequestBody(null))
        }.build()
        val response = await(client.newCall(request))
        val text = withContext(io) { response.use { it.body.string() } }
        // Job errors come back as 5xx *with* a status body — that is a state, not a crash.
        val dto = runCatching { gson.fromJson(text, PrepareDto::class.java) }.getOrNull()
        if (dto?.state != null) return dto.toDomain(id, response.code)
        throw errorFrom(response, text)
    }

    private suspend inline fun <reified T : Any> getJson(url: HttpUrl): T =
        decode(Request.Builder().url(url).get().build())

    private suspend inline fun <reified T : Any> decode(request: Request): T {
        val response = await(client.newCall(request))
        val text = withContext(io) { response.use { it.body.string() } }
        if (!response.isSuccessful) throw errorFrom(response, text)
        return try {
            gson.fromJson(text, T::class.java) ?: throw JsonParseException("empty body")
        } catch (e: JsonParseException) {
            throw RemoteApiException(response.code, RemoteApiException.BAD_RESPONSE, "The server returned something that isn't valid JSON", false, e)
        }
    }

    private fun errorFrom(response: Response, body: String): RemoteApiException {
        val err = runCatching { gson.fromJson(body, ErrorBodyDto::class.java)?.error }.getOrNull()
        if (err != null) {
            val e = err.toDomain(response.code)
            return RemoteApiException(response.code, e.code, e.message, e.retryable)
        }
        val message = when (response.code) {
            401 -> "The server needs an access key (APP_ACCESS_KEY)"
            404 -> "Not found — is this the 80s web server address?"
            in 500..599 -> "Server error (HTTP ${response.code})"
            else -> "Request failed (HTTP ${response.code})"
        }
        val code = if (response.code == 401) RemoteApiException.ACCESS_REQUIRED else "HTTP_${response.code}"
        return RemoteApiException(response.code, code, message, response.code >= 500)
    }

    private suspend fun await(call: Call): Response = suspendCancellableCoroutine { cont ->
        cont.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (cont.isActive) {
                    cont.resumeWithException(
                            if (e is RemoteApiException) e
                            else RemoteApiException(0, RemoteApiException.NETWORK, "Can't reach the server: ${e.message ?: e.javaClass.simpleName}", true, e)
                    )
                }
            }

            override fun onResponse(call: Call, response: Response) {
                if (cont.isActive) cont.resume(response) { _, _, _ -> response.close() } else response.close()
            }
        })
    }

    companion object {
        private val JSON = "application/json; charset=utf-8".toMediaType()

        /**
         * 20 s connect/read: enough for a sleeping free-tier dyno (Heroku Eco, Render, Fly
         * auto-stop) to boot on the first request, see [withWakeRetry] for the second chance.
         */
        const val CONNECT_TIMEOUT_SECONDS = 20L
        const val READ_TIMEOUT_SECONDS = 20L

        fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(CONNECT_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .readTimeout(READ_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .callTimeout(60, TimeUnit.SECONDS)
            .build()

        fun extensionForMime(mime: String): String? {
            val m = mime.lowercase()
            return when {
                "flac" in m -> "flac"
                "wav" in m || "wave" in m -> "wav"
                "mpeg" in m || "mp3" in m -> "mp3"
                "mp4" in m || "m4a" in m || "aac" in m -> "m4a"
                "ogg" in m || "opus" in m -> "ogg"
                else -> null
            }
        }
    }
}
