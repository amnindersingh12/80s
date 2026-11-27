package app.eighties.poweramp.ui

import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.core.view.isVisible
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import app.eighties.poweramp.R
import app.eighties.poweramp.data.BridgeAppGraph
import app.eighties.poweramp.databinding.FragmentAlbumBinding
import kotlinx.coroutines.launch
import java.util.Locale

class AlbumFragment : Fragment() {

    private var _binding: FragmentAlbumBinding? = null
    private val binding get() = _binding!!

    private lateinit var trackAdapter: TrackAdapter

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentAlbumBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        val albumId = arguments?.getString(ARG_ID).orEmpty()
        val albumTitle = arguments?.getString(ARG_TITLE).orEmpty()
        val albumArtist = arguments?.getString(ARG_ARTIST).orEmpty()
        val localIndex = BridgeAppGraph.localLibrary(requireContext())

        binding.btnAlbumBack.setOnClickListener { parentFragmentManager.popBackStack() }
        binding.albumHeaderTitle.text = albumTitle
        binding.btnAlbumArtist.text = albumArtist

        lateinit var ref: TrackAdapter
        ref = TrackAdapter(
            onPlayClick = { t -> BridgePlayerActions.playTrack(this, t) },
            onDownloadClick = { t -> BridgePlayerActions.downloadTrack(this, t) { st -> ref.setDownloadState(t.id, st) } },
            onLyricsClick = { t -> BridgePlayerActions.openLyrics(this, t) },
            onMoreClick = { t -> TrackActionBottomSheet.newInstance(t).show(childFragmentManager, "track_actions") },
            isOfflineDownloaded = { t -> localIndex.isDownloaded(t.artist, t.title) },
            showTrackNumbers = true,
        )
        trackAdapter = ref

        binding.albumTracksRecycler.layoutManager = LinearLayoutManager(requireContext())
        binding.albumTracksRecycler.adapter = trackAdapter

        val ctx = requireContext().applicationContext
        viewLifecycleOwner.lifecycleScope.launch {
            _binding?.albumLoading?.isVisible = true
            suspendRunCatching { BridgeAppGraph.api(ctx).albumDetail(albumId, albumTitle, albumArtist) }
                .onSuccess { detail ->
                    val b = _binding ?: return@onSuccess
                    b.albumLoading.isVisible = false
                    b.albumHeaderTitle.text = detail.title
                    b.btnAlbumArtist.text = detail.artist
                    b.btnAlbumArtist.setOnClickListener {
                        BridgePlayerActions.openArtist(this@AlbumFragment, detail.artistId, detail.artist)
                    }
                    val totalMin = (detail.totalDurationMs / 60_000L).toInt()
                    val specs = if (detail.bitDepth != null && detail.sampleRate != null) {
                        "${detail.codec} · ${detail.bitDepth}-bit/${String.format(Locale.US, "%.1f", detail.sampleRate / 1000.0)}kHz"
                    } else "${detail.qualityTier} · ${detail.codec}"
                    b.albumHeaderBadge.text = specs
                    b.albumMeta.text = listOfNotNull(
                        detail.year?.toString(),
                        "${detail.trackCount} tracks",
                        "$totalMin min",
                    ).joinToString(" · ")

                    CoverLoader.load(b.albumHeaderCover, detail.coverUrl, R.drawable.ic_music_note)
                    trackAdapter.submitList(detail.tracks)

                    b.btnPlayAlbum.setOnClickListener {
                        BridgePlayerActions.playList(this@AlbumFragment, detail.tracks)
                    }
                    b.btnDownloadAlbum.setOnClickListener {
                        b.btnDownloadAlbum.isEnabled = false
                        b.btnDownloadAlbum.text = "Downloading…"
                        viewLifecycleOwner.lifecycleScope.launch {
                            var okCount = 0
                            for (tr in detail.tracks) {
                                trackAdapter.setDownloadState(tr.id, DownloadState.DOWNLOADING)
                                val ok = suspendRunCatching { BridgeAppGraph.downloads(ctx).downloadToLibrary(tr) }.isSuccess
                                trackAdapter.setDownloadState(tr.id, if (ok) DownloadState.DOWNLOADED else DownloadState.IDLE)
                                if (ok) okCount++
                            }
                            _binding?.let { cur ->
                                cur.btnDownloadAlbum.isEnabled = true
                                cur.btnDownloadAlbum.text = "Download Album"
                            }
                            Toast.makeText(ctx, "Saved $okCount/${detail.tracks.size} lossless tracks", Toast.LENGTH_SHORT).show()
                        }
                    }

                    val bmp = CoverLoader.loadBitmap(detail.coverUrl)
                    val cur = _binding ?: return@onSuccess
                    if (bmp != null) {
                        val accent = CoverLoader.extractAccentColor(bmp)
                        cur.albumHeaderBg.background = GradientDrawable(
                            GradientDrawable.Orientation.TOP_BOTTOM,
                            intArrayOf(accent, 0x00000000),
                        )
                    }
                }
                .onFailure { err ->
                    val b = _binding ?: return@onFailure
                    b.albumLoading.isVisible = false
                    b.albumError.isVisible = true
                    b.albumError.text = err.message ?: getString(R.string.connection_error)
                }
        }
    }

    override fun onDestroyView() {
        _binding = null
        super.onDestroyView()
    }

    companion object {
        private const val ARG_ID = "album_id"
        private const val ARG_TITLE = "album_title"
        private const val ARG_ARTIST = "album_artist"

        fun newInstance(id: String?, title: String, artist: String): AlbumFragment {
            val resolvedId = id?.takeIf { it.isNotBlank() }
                ?: "alb:${java.net.URLEncoder.encode(artist, "UTF-8")}|${java.net.URLEncoder.encode(title, "UTF-8")}"
            return AlbumFragment().apply {
                arguments = Bundle().apply {
                    putString(ARG_ID, resolvedId)
                    putString(ARG_TITLE, title)
                    putString(ARG_ARTIST, artist)
                }
            }
        }
    }
}
