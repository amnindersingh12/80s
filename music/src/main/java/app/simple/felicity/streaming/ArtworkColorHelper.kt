package app.simple.felicity.streaming

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.view.View
import androidx.core.graphics.ColorUtils
import app.simple.felicity.theme.managers.ThemeManager
import com.bumptech.glide.Glide
import com.bumptech.glide.request.target.CustomTarget
import com.bumptech.glide.request.transition.Transition

/**
 * Extracts a vibrant/dominant accent color from album artwork without extra dependencies,
 * and paints smooth Spotify/Apple Music-style ambient vertical gradients.
 */
object ArtworkColorHelper {

    fun extractDominantColor(bitmap: Bitmap, fallback: Int = ThemeManager.accent.primaryAccentColor): Int {
        val scaled = Bitmap.createScaledBitmap(bitmap, 16, 16, true)
        var bestColor = fallback
        var bestScore = -1f
        for (y in 0 until scaled.height) {
            for (x in 0 until scaled.width) {
                val px = scaled.getPixel(x, y)
                if (Color.alpha(px) < 128) continue
                val hsl = FloatArray(3)
                ColorUtils.colorToHSL(px, hsl)
                val sat = hsl[1]
                val lum = hsl[2]
                if (lum < 0.12f || lum > 0.88f) continue
                val score = sat * 2f + (1f - kotlin.math.abs(lum - 0.45f))
                if (score > bestScore) {
                    bestScore = score
                    bestColor = px
                }
            }
        }
        if (scaled !== bitmap) scaled.recycle()
        return bestColor
    }

    fun applyAmbientGradient(target: View, accentColor: Int, alphaFraction: Float = 0.34f) {
        val bg = ThemeManager.theme.viewGroupTheme.backgroundColor
        val top = ColorUtils.setAlphaComponent(accentColor, (alphaFraction.coerceIn(0f, 1f) * 255).toInt())
        val mid = ColorUtils.blendARGB(bg, top, 0.5f)
        target.background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(top, mid, bg))
    }

    fun tintFromUrl(context: Context, url: String?, target: View, alphaFraction: Float = 0.34f) {
        if (url.isNullOrBlank()) {
            applyAmbientGradient(target, ThemeManager.accent.primaryAccentColor, alphaFraction * 0.6f)
            return
        }
        Glide.with(context.applicationContext)
            .asBitmap()
            .load(url)
            .override(64, 64)
            .into(object : CustomTarget<Bitmap>() {
                override fun onResourceReady(resource: Bitmap, transition: Transition<in Bitmap>?) {
                    applyAmbientGradient(target, extractDominantColor(resource), alphaFraction)
                }

                override fun onLoadCleared(placeholder: Drawable?) = Unit
            })
    }
}
