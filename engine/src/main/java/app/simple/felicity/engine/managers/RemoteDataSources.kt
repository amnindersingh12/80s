package app.simple.felicity.engine.managers

import android.content.Context
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.CacheWriter
import androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import app.simple.felicity.preferences.RemoteServerPreferences
import java.io.File

/**
 * Data sources for the player. Local files and SAF URIs behave exactly as before; `http(s)`
 * URIs (tracks streamed from the `web/` server via `/api/stream/:id`) go through
 * [DefaultHttpDataSource] wrapped in a 350 MiB LRU [SimpleCache] so seeking, scrubbing,
 * repeat-one, and pre-buffered gapless transitions read straight from disk.
 *
 * The server's `APP_ACCESS_KEY` is added per request — read fresh from settings, and only
 * for the configured server's origin — so changing the key needs no player rebuild and the
 * key never reaches any other host.
 */
@OptIn(UnstableApi::class)
object RemoteDataSources {

    /**
     * The first byte of a stream can be delayed while the server's packaging job finishes
     * (capped at 45 s server-side), so the read timeout is generous.
     */
    private const val READ_TIMEOUT_MS = 60_000
    private const val CONNECT_TIMEOUT_MS = 15_000
    private const val CACHE_BYTES = 350L * 1024L * 1024L
    private const val PREFETCH_BYTES = 768L * 1024L

    @Volatile
    private var cacheInstance: SimpleCache? = null

    private fun cache(appContext: Context): SimpleCache = cacheInstance ?: synchronized(this) {
        cacheInstance ?: SimpleCache(
                File(appContext.cacheDir, "exo_flac_cache"),
                LeastRecentlyUsedCacheEvictor(CACHE_BYTES),
                StandaloneDatabaseProvider(appContext),
        ).also { cacheInstance = it }
    }

    private fun httpWithAuth(appContext: Context): DataSource.Factory {
        val http = DefaultHttpDataSource.Factory()
            .setUserAgent("Felicity (Android; 80s web client)")
            .setConnectTimeoutMs(CONNECT_TIMEOUT_MS)
            .setReadTimeoutMs(READ_TIMEOUT_MS)
            .setAllowCrossProtocolRedirects(false)

        return ResolvingDataSource.Factory(http) { spec ->
            val headers = RemoteServerPreferences.getServerConfig(appContext)?.authHeadersFor(spec.uri.toString()).orEmpty()
            if (headers.isEmpty()) spec else spec.withAdditionalHeaders(headers)
        }
    }

    private fun cachedHttpFactory(appContext: Context): CacheDataSource.Factory =
        CacheDataSource.Factory()
            .setCache(cache(appContext))
            .setUpstreamDataSourceFactory(httpWithAuth(appContext))
            .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)

    fun factory(context: Context): DataSource.Factory {
        val appContext = context.applicationContext
        return DefaultDataSource.Factory(appContext, cachedHttpFactory(appContext))
    }

    /** Pre-buffers the opening FLAC chunk of an upcoming stream into [SimpleCache] for gapless starts. */
    fun prefetchStream(context: Context, url: String, maxBytes: Long = PREFETCH_BYTES) {
        val appContext = context.applicationContext
        val dataSource = cachedHttpFactory(appContext).createDataSourceForDownloading()
        val spec = DataSpec.Builder().setUri(url).setLength(maxBytes).build()
        runCatching {
            CacheWriter(dataSource, spec, null, null).cache()
        }
    }
}
