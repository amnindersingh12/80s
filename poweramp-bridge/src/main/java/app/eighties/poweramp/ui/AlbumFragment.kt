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

        viewLifecycleOwner.lifecycleScope.launch {
            binding.albumLoading.isVisible = true
            runCatching { BridgeAppGraph.api(requireContext()).albumDetail(albumId, albumTitle, albumArtist) }
                .onSuccess { detail ->
                    binding.albumLoading.isVisible = false
                    binding.albumHeaderTitle.text = detail.title
                    binding.btnAlbumArtist.text = detail.artist
                    binding.btnAlbumArtist.setOnClickListener {
                        BridgePlayerActions.openArtist(this@AlbumFragment, detail.artistId, detail.artist)
                    }
                    val totalMin = (detail.totalDurationMs / 60_000L).toInt()
                    val specs = if (detail.bitDepth != null && detail.sampleRate != null) {
                        "${detail.codec} · ${detail.bitDepth}-bit/${String.format(Locale.US, "%.1f", detail.sampleRate / 1000.0)}kHz"
                    } else "${detail.qualityTier} · ${detail.codec}"
                    binding.albumHeaderBadge.text = specs
                    binding.albumMeta.text = listOfNotNull(
                        detail.year?.toString(),
                        "${detail.trackCount} tracks",
                        "$totalMin min",
                    ).joinToString(" · ")

                    CoverLoader.load(binding.albumHeaderCover, detail.coverUrl, R.drawable.ic_music_note)
                    trackAdapter.submitList(detail.tracks)

                    binding.btnPlayAlbum.setOnClickListener {
                        BridgePlayerActions.playList(this@AlbumFragment, detail.tracks)
                    }
                    binding.btnDownloadAlbum.setOnClickListener {
                        binding.btnDownloadAlbum.isEnabled = false
                        binding.btnDownloadAlbum.text = "Downloading…"
                        viewLifecycleOwner.lifecycleScope.launch {
                            val ctx = requireContext()
                            var okCount = 0
                            for (tr in detail.tracks) {
                                trackAdapter.setDownloadState(tr.id, DownloadState.DOWNLOADING)
                                val ok = runCatching { BridgeAppGraph.downloads(ctx).downloadToLibrary(tr) }.isSuccess
                                trackAdapter.setDownloadState(tr.id, if (ok) DownloadState.DOWNLOADED else DownloadState.IDLE)
                                if (ok) okCount++
                            }
                            if (_binding != null) {
                                binding.btnDownloadAlbum.isEnabled = true
                                binding.btnDownloadAlbum.text = "Download Album"
                                Toast.makeText(ctx, "Saved $okCount/${detail.tracks.size} lossless tracks", Toast.LENGTH_SHORT).show()
                            }
                        }
                    }

                    val bmp = CoverLoader.loadBitmap(detail.coverUrl)
                    if (bmp != null && _binding != null) {
                        val accent = CoverLoader.extractAccentColor(bmp)
                        binding.albumHeaderBg.background = GradientDrawable(
                            GradientDrawable.Orientation.TOP_BOTTOM,
                            intArrayOf(accent, 0x00000000),
                        )
                    }
                }
                .onFailure { err ->
                    binding.albumLoading.isVisible = false
                    binding.albumError.isVisible = true
                    binding.albumError.text = err.message ?: getString(R.string.connection_error)
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
