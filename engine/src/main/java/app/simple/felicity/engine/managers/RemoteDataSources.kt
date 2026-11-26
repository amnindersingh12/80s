package app.simple.felicity.engine.managers

import android.content.Context
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.ResolvingDataSource
import app.simple.felicity.preferences.RemoteServerPreferences

/**
 * Data sources for the player. Local files and SAF URIs behave exactly as before; `http(s)`
 * URIs (tracks streamed from the `web/` server via `/api/stream/:id`) go through
 * [DefaultHttpDataSource], which issues HTTP `Range` requests so seeking and scrubbing work.
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

    fun factory(context: Context): DataSource.Factory {
        val appContext = context.applicationContext
        val http = DefaultHttpDataSource.Factory()
            .setUserAgent("Felicity (Android; 80s web client)")
            .setConnectTimeoutMs(CONNECT_TIMEOUT_MS)
            .setReadTimeoutMs(READ_TIMEOUT_MS)
            .setAllowCrossProtocolRedirects(false)

        val withAuth = ResolvingDataSource.Factory(http) { spec ->
            val headers = RemoteServerPreferences.getServerConfig(appContext)?.authHeadersFor(spec.uri.toString()).orEmpty()
            if (headers.isEmpty()) spec else spec.withAdditionalHeaders(headers)
        }
        return DefaultDataSource.Factory(appContext, withAuth)
    }
}
