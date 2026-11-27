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
import app.eighties.poweramp.data.BridgeDatabase
import app.eighties.poweramp.databinding.FragmentArtistBinding
import app.eighties.poweramp.poweramp.PowerampHelper
import kotlinx.coroutines.launch

class ArtistFragment : Fragment() {

    private var _binding: FragmentArtistBinding? = null
    private val binding get() = _binding!!

    private lateinit var trackAdapter: TrackAdapter
    private lateinit var albumAdapter: AlbumCarouselAdapter
    private lateinit var similarAdapter: ArtistCarouselAdapter

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentArtistBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        val artistId = arguments?.getString(ARG_ID).orEmpty()
        val artistName = arguments?.getString(ARG_NAME).orEmpty()
        val localIndex = BridgeAppGraph.localLibrary(requireContext())

        binding.btnArtistBack.setOnClickListener { parentFragmentManager.popBackStack() }
        binding.artistHeaderName.text = artistName

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

        albumAdapter = AlbumCarouselAdapter { al -> BridgePlayerActions.openAlbum(this, al.id, al.title, al.artist) }
        similarAdapter = ArtistCarouselAdapter { ar -> BridgePlayerActions.openArtist(this, ar.id, ar.name) }

        binding.artistTracksRecycler.layoutManager = LinearLayoutManager(requireContext())
        binding.artistTracksRecycler.adapter = trackAdapter
        binding.artistAlbumsRecycler.layoutManager = LinearLayoutManager(requireContext(), LinearLayoutManager.HORIZONTAL, false)
        binding.artistAlbumsRecycler.adapter = albumAdapter
        binding.similarArtistsRecycler.layoutManager = LinearLayoutManager(requireContext(), LinearLayoutManager.HORIZONTAL, false)
        binding.similarArtistsRecycler.adapter = similarAdapter

        viewLifecycleOwner.lifecycleScope.launch {
            binding.artistLoading.isVisible = true
            runCatching { BridgeAppGraph.api(requireContext()).artistDetail(artistId, artistName) }
                .onSuccess { detail ->
                    binding.artistLoading.isVisible = false
                    binding.artistHeaderName.text = detail.name
                    binding.artistGenres.text = detail.genres.take(4).joinToString(" · ")
                    CoverLoader.load(binding.artistHeaderCover, detail.imageUrl, R.drawable.ic_music_note)

                    trackAdapter.submitList(detail.topTracks)
                    binding.artistAlbumsHeader.isVisible = detail.albums.isNotEmpty()
                    binding.artistAlbumsRecycler.isVisible = detail.albums.isNotEmpty()
                    albumAdapter.submitList(detail.albums)

                    binding.similarArtistsHeader.isVisible = detail.similarArtists.isNotEmpty()
                    binding.similarArtistsRecycler.isVisible = detail.similarArtists.isNotEmpty()
                    similarAdapter.submitList(detail.similarArtists)

                    binding.btnPlayArtistTop.setOnClickListener {
                        BridgePlayerActions.playList(this@ArtistFragment, detail.topTracks)
                    }
                    binding.btnArtistRadio.setOnClickListener {
                        val ctx = requireContext()
                        viewLifecycleOwner.lifecycleScope.launch {
                            runCatching {
                                val tracks = BridgeAppGraph.api(ctx).home(seedArtist = detail.name, limit = 20)
                                BridgeAppGraph.db(ctx).replaceFolderTracks(BridgeDatabase.FOLDER_RADIO, tracks, "Radio: ${detail.name}")
                                PowerampHelper.triggerRescan(ctx, BridgeDatabase.FOLDER_RADIO, fromUi = true)
                                tracks
                            }.onSuccess { tracks ->
                                if (tracks.isNotEmpty()) BridgePlayerActions.playTrack(this@ArtistFragment, tracks.first())
                            }.onFailure { err ->
                                Toast.makeText(ctx, err.message ?: "Radio unavailable", Toast.LENGTH_SHORT).show()
                            }
                        }
                    }

                    val bmp = CoverLoader.loadBitmap(detail.imageUrl)
                    if (bmp != null && _binding != null) {
                        val accent = CoverLoader.extractAccentColor(bmp)
                        binding.artistHeaderBg.background = GradientDrawable(
                            GradientDrawable.Orientation.TOP_BOTTOM,
                            intArrayOf(accent, 0x00000000),
                        )
                    }
                }
                .onFailure { err ->
                    binding.artistLoading.isVisible = false
                    binding.artistError.isVisible = true
                    binding.artistError.text = err.message ?: getString(R.string.connection_error)
                }
        }
    }

    override fun onDestroyView() {
        _binding = null
        super.onDestroyView()
    }

    companion object {
        private const val ARG_ID = "artist_id"
        private const val ARG_NAME = "artist_name"

        fun newInstance(id: String?, name: String): ArtistFragment {
            val resolvedId = id?.takeIf { it.isNotBlank() } ?: "name:${java.net.URLEncoder.encode(name, "UTF-8")}"
            return ArtistFragment().apply {
                arguments = Bundle().apply {
                    putString(ARG_ID, resolvedId)
                    putString(ARG_NAME, name)
                }
            }
        }
    }
}
