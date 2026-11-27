package app.eighties.poweramp.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.util.LruCache
import android.widget.ImageView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL

object CoverLoader {
    private const val MAX_CACHE_KB = 8 * 1024
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val cache = object : LruCache<String, Bitmap>(MAX_CACHE_KB) {
        override fun sizeOf(key: String, value: Bitmap): Int = maxOf(1, value.byteCount / 1024)
    }

    fun load(imageView: ImageView, url: String?, placeholderRes: Int) {
        imageView.tag = url
        if (url.isNullOrBlank()) {
            imageView.setImageResource(placeholderRes)
            return
        }
        cache.get(url)?.let { bmp ->
            imageView.setImageBitmap(bmp)
            return
        }
        imageView.setImageResource(placeholderRes)
        scope.launch {
            val bmp = fetchBitmap(url)
            if (bmp != null) {
                cache.put(url, bmp)
                withContext(Dispatchers.Main) {
                    if (imageView.tag == url) {
                        imageView.setImageBitmap(bmp)
                    }
                }
            }
        }
    }

    suspend fun loadBitmap(url: String?): Bitmap? {
        if (url.isNullOrBlank()) return null
        cache.get(url)?.let { return it }
        return withContext(Dispatchers.IO) {
            fetchBitmap(url)?.also { cache.put(url, it) }
        }
    }

    /** Samples an 8x8 grid to compute a rich dark-friendly accent tint without external Palette deps. */
    fun extractAccentColor(bitmap: Bitmap): Int {
        val w = bitmap.width
        val h = bitmap.height
        if (w <= 0 || h <= 0) return Color.parseColor("#2A2240")
        var bestColor = Color.parseColor("#2A2240")
        var bestScore = -1f
        val hsv = FloatArray(3)
        for (xi in 1..7) {
            for (yi in 1..7) {
                val px = bitmap.getPixel((w * xi) / 8, (h * yi) / 8)
                Color.colorToHSV(px, hsv)
                val score = hsv[1] * 2f + (1f - kotlin.math.abs(hsv[2] - 0.5f))
                if (score > bestScore && hsv[2] > 0.15f) {
                    bestScore = score
                    hsv[2] = hsv[2].coerceAtMost(0.42f)
                    bestColor = Color.HSVToColor(255, hsv)
                }
            }
        }
        return bestColor
    }

    private fun fetchBitmap(rawUrl: String): Bitmap? = runCatching {
        val conn = (URL(rawUrl).openConnection() as HttpURLConnection).apply {
            connectTimeout = 6_000
            readTimeout = 8_000
            instanceFollowRedirects = true
        }
        try {
            if (conn.responseCode !in 200..299) return null
            conn.inputStream.use { stream ->
                BitmapFactory.decodeStream(stream)
            }
        } finally {
            conn.disconnect()
        }
    }.getOrNull()
}
