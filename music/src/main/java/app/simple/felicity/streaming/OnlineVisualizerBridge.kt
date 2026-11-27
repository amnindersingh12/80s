package app.simple.felicity.streaming

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.audiofx.Visualizer
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import app.simple.felicity.decorations.views.FelicityVisualizer
import app.simple.felicity.engine.managers.MediaPlaybackManager
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.sin

/**
 * Feeds [FelicityVisualizer]'s lock-free twin buffers for online streams using Android's
 * [Visualizer] API when `RECORD_AUDIO` is granted, with a smooth playback-state harmonic
 * fallback when audio capture is restricted (never crashing or prompting for permissions).
 */
class OnlineVisualizerBridge(
        private val context: Context,
        private val view: FelicityVisualizer,
) {
    private val handler = Handler(Looper.getMainLooper())
    private var audioVisualizer: Visualizer? = null
    private var attachedSession = 0
    private var running = false

    private val fallbackTicker = object : Runnable {
        override fun run() {
            if (!running) return
            val playing = MediaPlaybackManager.isPlaying()
            val t = System.currentTimeMillis() / 220.0
            val frontIsA = view.isBufferAFront.get()
            val back = if (frontIsA) view.bufferB else view.bufferA
            for (i in back.indices) {
                back[i] = if (playing) {
                    val wave = 0.25f + 0.55f * abs(sin(t + i * 0.42).toFloat()) * (0.6f + 0.4f * sin(t * 0.5 + i * 0.17).toFloat())
                    wave.coerceIn(0.05f, 0.95f)
                } else {
                    0.02f
                }
            }
            view.isBufferAFront.set(!frontIsA)
            view.postInvalidate()
            handler.postDelayed(this, 33L)
        }
    }

    fun start(sessionId: Int) {
        stop()
        running = true
        if (sessionId > 0 && hasCapturePermission() && attachNativeVisualizer(sessionId)) {
            return
        }
        handler.post(fallbackTicker)
    }

    fun stop() {
        running = false
        handler.removeCallbacks(fallbackTicker)
        runCatching {
            audioVisualizer?.enabled = false
            audioVisualizer?.release()
        }
        audioVisualizer = null
        attachedSession = 0
    }

    private fun hasCapturePermission(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    private fun attachNativeVisualizer(sessionId: Int): Boolean {
        return runCatching {
            val v = Visualizer(sessionId).apply {
                captureSize = Visualizer.getCaptureSizeRange()[1].coerceAtMost(1024)
                setDataCaptureListener(object : Visualizer.OnDataCaptureListener {
                    override fun onWaveFormDataCapture(visualizer: Visualizer?, waveform: ByteArray?, samplingRate: Int) = Unit

                    override fun onFftDataCapture(visualizer: Visualizer?, fft: ByteArray?, samplingRate: Int) {
                        if (fft == null || fft.size < 4 || !running) return
                        val frontIsA = view.isBufferAFront.get()
                        val back = if (frontIsA) view.bufferB else view.bufferA
                        val bins = (fft.size / 2).coerceAtLeast(1)
                        for (i in back.indices) {
                            val idx = ((i * bins) / back.size).coerceIn(1, bins - 1) * 2
                            val re = fft.getOrElse(idx) { 0 }.toFloat()
                            val im = fft.getOrElse(idx + 1) { 0 }.toFloat()
                            back[i] = (hypot(re, im) / 128f).coerceIn(0f, 1f)
                        }
                        view.isBufferAFront.set(!frontIsA)
                        view.postInvalidate()
                    }
                }, Visualizer.getMaxCaptureRate() / 2, false, true)
                enabled = true
            }
            audioVisualizer = v
            attachedSession = sessionId
            true
        }.getOrElse {
            audioVisualizer = null
            false
        }
    }
}
