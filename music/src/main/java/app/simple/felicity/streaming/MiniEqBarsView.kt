package app.simple.felicity.streaming

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.util.AttributeSet
import android.view.View
import app.simple.felicity.theme.managers.ThemeManager
import kotlin.math.sin

/** Lightweight 3-bar animated equalizer indicator for the currently playing track row. */
class MiniEqBarsView @JvmOverloads constructor(
        context: Context,
        attrs: AttributeSet? = null,
        defStyleAttr: Int = 0
) : View(context, attrs, defStyleAttr) {

    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = ThemeManager.accent.primaryAccentColor
    }
    private val rect = RectF()
    private var animating = false
    private val ticker = object : Runnable {
        override fun run() {
            if (!animating || visibility != VISIBLE) return
            invalidate()
            postDelayed(this, 60L)
        }
    }

    fun setAnimating(active: Boolean) {
        if (animating == active) return
        animating = active
        removeCallbacks(ticker)
        if (active && visibility == VISIBLE) post(ticker) else invalidate()
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        paint.color = ThemeManager.accent.primaryAccentColor
        if (animating && visibility == VISIBLE) post(ticker)
    }

    override fun onDetachedFromWindow() {
        removeCallbacks(ticker)
        super.onDetachedFromWindow()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return
        val barW = w / 5f
        val gap = barW
        val t = System.currentTimeMillis() / 160.0
        for (i in 0 until 3) {
            val frac = if (animating) (0.35f + 0.65f * ((sin(t + i * 1.4).toFloat() + 1f) / 2f)) else 0.45f
            val barH = (h * frac).coerceAtLeast(barW)
            val left = i * (barW + gap)
            rect.set(left, h - barH, left + barW, h)
            canvas.drawRoundRect(rect, barW / 2f, barW / 2f, paint)
        }
    }
}
