package app.eighties.poweramp.ui

import android.app.Dialog
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.graphics.RenderEffect
import android.graphics.Shader
import android.os.Build
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.core.view.isVisible
import androidx.fragment.app.DialogFragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import app.eighties.poweramp.R
import app.eighties.poweramp.data.BridgeAppGraph
import app.eighties.poweramp.data.LosslessTrack
import app.eighties.poweramp.data.LrcLine
import app.eighties.poweramp.data.LrcParser
import app.eighties.poweramp.poweramp.PowerampContract
import app.eighties.poweramp.poweramp.PowerampHelper
import com.google.android.material.button.MaterialButton
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class LyricsSheetDialogFragment : DialogFragment() {

    private var tickerJob: Job? = null
    private var syncedLines: List<LrcLine> = emptyList()
    private var currentPosMs: Long = 0L
    private var manualScroll: Boolean = false
    private var lastManualScrollAt: Long = 0L

    override fun onCreateDialog(savedInstanceState: Bundle?): Dialog {
        return Dialog(requireContext(), android.R.style.Theme_Black_NoTitleBar_Fullscreen)
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        return inflater.inflate(R.layout.dialog_lyrics, container, false)
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        val args = requireArguments()
        val title = args.getString(ARG_TITLE).orEmpty()
        val artist = args.getString(ARG_ARTIST).orEmpty()
        val album = args.getString(ARG_ALBUM)
        val durationSec = args.getInt(ARG_DURATION_SEC, 0).takeIf { it > 0 }
        val artworkUrl = args.getString(ARG_ARTWORK_URL)

        val backdrop = view.findViewById<ImageView>(R.id.lyricsBackdrop)
        val thumb = view.findViewById<ImageView>(R.id.lyricsThumb)
        val titleView = view.findViewById<TextView>(R.id.lyricsTitle)
        val subtitleView = view.findViewById<TextView>(R.id.lyricsSubtitle)
        val sourceView = view.findViewById<TextView>(R.id.lyricsSource)
        val loadingBar = view.findViewById<ProgressBar>(R.id.lyricsLoading)
        val plainView = view.findViewById<TextView>(R.id.lyricsPlain)
        val emptyView = view.findViewById<TextView>(R.id.lyricsEmpty)
        val recycler = view.findViewById<RecyclerView>(R.id.lyricsRecycler)
        val btnClose = view.findViewById<ImageButton>(R.id.btnLyricsClose)
        val btnSync = view.findViewById<MaterialButton>(R.id.btnLyricsSync)
        val btnPrev = view.findViewById<ImageButton>(R.id.btnLyricsPrev)
        val btnPlayPause = view.findViewById<MaterialButton>(R.id.btnLyricsPlayPause)
        val btnNext = view.findViewById<ImageButton>(R.id.btnLyricsNext)
        val btnOpenPoweramp = view.findViewById<MaterialButton>(R.id.btnLyricsOpenPoweramp)
        val btnSaveFlac = view.findViewById<MaterialButton>(R.id.btnLyricsSaveFlac)

        titleView.text = title
        subtitleView.text = listOfNotNull(artist.takeIf { it.isNotBlank() }, album?.takeIf { it.isNotBlank() }).joinToString(" · ")
        CoverLoader.load(thumb, artworkUrl, R.drawable.ic_music_note)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            backdrop.setRenderEffect(RenderEffect.createBlurEffect(48f, 48f, Shader.TileMode.CLAMP))
        }
        viewLifecycleOwner.lifecycleScope.launch {
            val bmp = CoverLoader.loadBitmap(artworkUrl)
            if (bmp != null) {
                backdrop.setImageBitmap(bmp)
                backdrop.alpha = 0.45f
            }
        }

        btnClose.setOnClickListener { dismiss() }
        btnPrev.setOnClickListener { PowerampHelper.sendCommand(requireContext(), PowerampContract.CMD_PREVIOUS) }
        btnPlayPause.setOnClickListener { PowerampHelper.sendCommand(requireContext(), PowerampContract.CMD_TOGGLE_PLAY_PAUSE) }
        btnNext.setOnClickListener { PowerampHelper.sendCommand(requireContext(), PowerampContract.CMD_NEXT) }
        btnOpenPoweramp.setOnClickListener { PowerampHelper.openPowerampApp(requireContext()) }
        val trackJson = args.getString(ARG_TRACK_JSON)
        val trackObj = trackJson?.let { runCatching { com.google.gson.Gson().fromJson(it, LosslessTrack::class.java) }.getOrNull() }
        btnSaveFlac.isVisible = trackObj != null
        btnSaveFlac.setOnClickListener {
            val tr = trackObj ?: return@setOnClickListener
            btnSaveFlac.isEnabled = false
            btnSaveFlac.text = "Saving…"
            viewLifecycleOwner.lifecycleScope.launch {
                runCatching { BridgeAppGraph.downloads(requireContext()).downloadToLibrary(tr) }
                    .onSuccess {
                        btnSaveFlac.text = "Saved"
                    }
                    .onFailure {
                        btnSaveFlac.isEnabled = true
                        btnSaveFlac.text = "Save FLAC"
                    }
            }
        }

        val layoutManager = LinearLayoutManager(requireContext())
        recycler.layoutManager = layoutManager
        lateinit var adapter: LyricLineAdapter
        adapter = LyricLineAdapter { line ->
            manualScroll = false
            btnSync.isVisible = false
            currentPosMs = line.timeMs
            PowerampHelper.seekToMs(requireContext(), line.timeMs)
            updateActiveLine(recycler, layoutManager, adapter, btnSync)
        }
        recycler.adapter = adapter

        recycler.addOnScrollListener(object : RecyclerView.OnScrollListener() {
            override fun onScrollStateChanged(rv: RecyclerView, newState: Int) {
                if (newState == RecyclerView.SCROLL_STATE_DRAGGING) {
                    manualScroll = true
                    lastManualScrollAt = System.currentTimeMillis()
                    btnSync.isVisible = syncedLines.isNotEmpty()
                }
            }
        })
        btnSync.setOnClickListener {
            manualScroll = false
            btnSync.isVisible = false
            updateActiveLine(recycler, layoutManager, adapter, btnSync, forceScroll = true)
        }

        viewLifecycleOwner.lifecycleScope.launch {
            loadingBar.isVisible = true
            val ctx = requireContext()
            val data = withContext(Dispatchers.IO) {
                val db = BridgeAppGraph.db(ctx)
                db.getCachedLyrics(artist, title) ?: BridgeAppGraph.api(ctx)
                    .fetchLyricsBlocking(title, artist, album, durationSec)
                    ?.also { db.putCachedLyrics(artist, title, it) }
            }
            loadingBar.isVisible = false
            if (data == null || (data.syncedLyrics.isNullOrBlank() && data.plainLyrics.isNullOrBlank() && !data.instrumental)) {
                emptyView.isVisible = true
                emptyView.text = getString(R.string.lyrics_empty)
                return@launch
            }

            syncedLines = LrcParser.parse(data.syncedLyrics)
            if (syncedLines.isNotEmpty()) {
                sourceView.text = "SYNCED"
                sourceView.isVisible = true
                recycler.isVisible = true
                adapter.submit(syncedLines)
                startSyncTicker(recycler, layoutManager, adapter, btnSync)
            } else if (!data.plainLyrics.isNullOrBlank()) {
                sourceView.text = "PLAIN"
                sourceView.isVisible = true
                plainView.isVisible = true
                plainView.text = data.plainLyrics
            } else if (data.instrumental) {
                emptyView.isVisible = true
                emptyView.text = getString(R.string.lyrics_instrumental)
            }
        }
    }

    private fun startSyncTicker(
        recycler: RecyclerView,
        layoutManager: LinearLayoutManager,
        adapter: LyricLineAdapter,
        btnSync: MaterialButton,
    ) {
        tickerJob?.cancel()
        tickerJob = viewLifecycleOwner.lifecycleScope.launch {
            var lastTickMs = System.currentTimeMillis()
            while (isActive) {
                val status = readPowerampStatus()
                val now = System.currentTimeMillis()
                val dt = now - lastTickMs
                lastTickMs = now

                if (status.hasBroadcast) {
                    if (kotlin.math.abs(currentPosMs - status.positionMs) > 1500L || !status.paused) {
                        if (kotlin.math.abs(currentPosMs - status.positionMs) > 1200L) {
                            currentPosMs = status.positionMs
                        } else if (!status.paused) {
                            currentPosMs += dt
                        }
                    }
                } else {
                    currentPosMs += dt
                }

                if (manualScroll && now - lastManualScrollAt > 4000L) {
                    manualScroll = false
                    btnSync.isVisible = false
                }
                updateActiveLine(recycler, layoutManager, adapter, btnSync)
                delay(250L)
            }
        }
    }

    private data class PowerampStatus(val hasBroadcast: Boolean, val positionMs: Long, val paused: Boolean)

    private fun readPowerampStatus(): PowerampStatus {
        val intent: Intent? = runCatching {
            requireContext().registerReceiver(null, IntentFilter(PowerampContract.ACTION_STATUS_CHANGED))
        }.getOrNull()
        if (intent == null) return PowerampStatus(false, currentPosMs, false)
        val posSec = intent.getIntExtra(PowerampContract.EXTRA_POSITION, -1)
        val paused = intent.getBooleanExtra(PowerampContract.EXTRA_PAUSED, false)
        return PowerampStatus(
            hasBroadcast = posSec >= 0,
            positionMs = if (posSec >= 0) posSec * 1000L else currentPosMs,
            paused = paused,
        )
    }

    private fun updateActiveLine(
        recycler: RecyclerView,
        layoutManager: LinearLayoutManager,
        adapter: LyricLineAdapter,
        btnSync: MaterialButton,
        forceScroll: Boolean = false,
    ) {
        val active = LrcParser.activeIndex(syncedLines, currentPosMs)
        val changed = adapter.setActiveIndex(active)
        if ((changed || forceScroll) && !manualScroll && active >= 0) {
            btnSync.isVisible = false
            val targetOffset = (recycler.height / 3).coerceAtLeast(120)
            layoutManager.scrollToPositionWithOffset(active, targetOffset)
        }
    }

    override fun onDestroyView() {
        tickerJob?.cancel()
        super.onDestroyView()
    }

    private class LyricLineAdapter(
        private val onLineClick: (LrcLine) -> Unit,
    ) : RecyclerView.Adapter<LyricLineAdapter.Holder>() {

        private var items: List<LrcLine> = emptyList()
        private var activeIndex: Int = -1

        fun submit(lines: List<LrcLine>) {
            items = lines
            notifyDataSetChanged()
        }

        fun setActiveIndex(idx: Int): Boolean {
            if (idx == activeIndex) return false
            val prev = activeIndex
            activeIndex = idx
            if (prev in items.indices) notifyItemChanged(prev)
            if (idx in items.indices) notifyItemChanged(idx)
            return true
        }

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
            val view = LayoutInflater.from(parent.context).inflate(R.layout.item_lyric_line, parent, false)
            return Holder(view)
        }

        override fun getItemCount(): Int = items.size

        override fun onBindViewHolder(holder: Holder, position: Int) {
            holder.bind(items[position], position == activeIndex, position < activeIndex, onLineClick)
        }

        class Holder(itemView: View) : RecyclerView.ViewHolder(itemView) {
            private val text = itemView.findViewById<TextView>(R.id.lyricLineText)
            fun bind(line: LrcLine, active: Boolean, past: Boolean, onClick: (LrcLine) -> Unit) {
                text.text = line.text
                text.setTextColor(
                    when {
                        active -> Color.WHITE
                        past -> Color.argb(135, 255, 255, 255)
                        else -> Color.argb(88, 255, 255, 255)
                    },
                )
                text.scaleX = if (active) 1.03f else 1.0f
                text.scaleY = if (active) 1.03f else 1.0f
                itemView.setOnClickListener { onClick(line) }
            }
        }
    }

    companion object {
        private const val ARG_TITLE = "title"
        private const val ARG_ARTIST = "artist"
        private const val ARG_ALBUM = "album"
        private const val ARG_DURATION_SEC = "duration_sec"
        private const val ARG_ARTWORK_URL = "artwork_url"
        private const val ARG_TRACK_JSON = "track_json"

        fun newInstance(track: LosslessTrack): LyricsSheetDialogFragment {
            return LyricsSheetDialogFragment().apply {
                arguments = Bundle().apply {
                    putString(ARG_TITLE, track.title)
                    putString(ARG_ARTIST, track.artist)
                    putString(ARG_ALBUM, track.album)
                    putInt(ARG_DURATION_SEC, (track.effectiveDurationMs / 1000L).toInt())
                    putString(ARG_ARTWORK_URL, track.artworkUrl)
                    putString(ARG_TRACK_JSON, com.google.gson.Gson().toJson(track))
                }
            }
        }
    }
}
