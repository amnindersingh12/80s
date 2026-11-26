package app.simple.felicity.repository.covers

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Log
import app.simple.felicity.preferences.RemoteServerPreferences
import app.simple.felicity.remote.RemoteCatalog
import app.simple.felicity.remote.RemoteIds
import app.simple.felicity.repository.models.Audio
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * Artwork for tracks streamed from the `web/` server.
 *
 * Remote tracks have no local file to read tags from, so the cover comes from the URL the
 * server reported. The access key is attached only when the image lives on the server
 * itself (e.g. `/api/cover/…`), never for third-party CDNs.
 */
object RemoteCover {

    private const val TAG = "RemoteCover"
    private const val MAX_BYTES = 8L * 1024 * 1024
    private const val TARGET_PX = 1024

    private val client by lazy {
        OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .build()
    }

    fun isRemote(audio: Audio): Boolean = RemoteIds.isRemoteUri(audio.uri)

    /** Blocking; called from Glide's background fetcher thread. */
    fun load(context: Context, audio: Audio): Bitmap? {
        val url = RemoteCatalog.get(audio.id)?.coverUrl ?: return null
        val request = Request.Builder().url(url).apply {
            RemoteServerPreferences.getServerConfig(context)?.authHeadersFor(url)?.forEach { (k, v) -> header(k, v) }
        }.build()
        return runCatching {
            client.newCall(request).execute().use { res ->
                if (!res.isSuccessful) return null
                if (res.body.contentLength() > MAX_BYTES) return null
                val bytes = res.body.bytes()
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                var sample = 1
                while (bounds.outWidth / (sample * 2) >= TARGET_PX && bounds.outHeight / (sample * 2) >= TARGET_PX) sample *= 2
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
            }
        }.onFailure { Log.w(TAG, "Cover download failed for ${audio.title}: ${it.message}") }.getOrNull()
    }
}
