package app.eighties.poweramp.ui

import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.core.view.isVisible
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import app.eighties.poweramp.R
import app.eighties.poweramp.data.BridgeAppGraph
import app.eighties.poweramp.data.BridgePrefs
import app.eighties.poweramp.data.HomeFeed
import app.eighties.poweramp.databinding.FragmentDiscoverBinding
import app.eighties.poweramp.poweramp.PowerampStateMonitor
import com.google.android.material.chip.Chip
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

class DiscoverFragment : Fragment() {

    private var _binding: FragmentDiscoverBinding? = null
    private val binding get() = _binding!!

    private lateinit var topTracksAdapter: TrackAdapter
    private lateinit var becauseAdapter: TrackAdapter
    private lateinit var albumAdapter: AlbumCarouselAdapter
    private lateinit var artistAdapter: ArtistCarouselAdapter
    private var activeGenre: String = "mixed"
    private var loadJob: Job? = null

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentDiscoverBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        val localIndex = BridgeAppGraph.localLibrary(requireContext())
        topTracksAdapter = makeTrackAdapter(localIndex)
        becauseAdapter = makeTrackAdapter(localIndex)
        albumAdapter = AlbumCarouselAdapter { album ->
            BridgePlayerActions.openAlbum(this, album.id, album.title, album.artist)
        }
        artistAdapter = ArtistCarouselAdapter { artist ->
            BridgePlayerActions.openArtist(this, artist.id, artist.name)
        }

        binding.discoverTracksRecycler.layoutManager = LinearLayoutManager(requireContext())
        binding.discoverTracksRecycler.adapter = topTracksAdapter

        binding.becauseRecycler.layoutManager = LinearLayoutManager(requireContext())
        binding.becauseRecycler.adapter = becauseAdapter

        binding.discoverAlbumsRecycler.layoutManager =
            LinearLayoutManager(requireContext(), LinearLayoutManager.HORIZONTAL, false)
        binding.discoverAlbumsRecycler.adapter = albumAdapter

        binding.discoverArtistsRecycler.layoutManager =
            LinearLayoutManager(requireContext(), LinearLayoutManager.HORIZONTAL, false)
        binding.discoverArtistsRecycler.adapter = artistAdapter

        setupGenreChips()
        loadFeed(activeGenre)

        viewLifecycleOwner.lifecycleScope.launch {
            localIndex.version.collectLatest {
                topTracksAdapter.notifyDataSetChanged()
                becauseAdapter.notifyDataSetChanged()
            }
        }
    }

    private fun makeTrackAdapter(localIndex: app.eighties.poweramp.download.LocalLibraryIndex): TrackAdapter {
        lateinit var ref: TrackAdapter
        ref = TrackAdapter(
            onPlayClick = { t -> BridgePlayerActions.playTrack(this, t) },
            onDownloadClick = { t -> BridgePlayerActions.downloadTrack(this, t) { st -> ref.setDownloadState(t.id, st) } },
            onLyricsClick = { t -> BridgePlayerActions.openLyrics(this, t) },
            onMoreClick = { t -> TrackActionBottomSheet.newInstance(t).show(childFragmentManager, "track_actions") },
            isOfflineDownloaded = { t -> localIndex.isDownloaded(t.artist, t.title) },
        )
        return ref
    }

    private fun setupGenreChips() {
        binding.discoverGenreChips.removeAllViews()
        BridgePrefs.ALL_GENRES.forEach { (tag, label) ->
            val chip = Chip(requireContext()).apply {
                text = label
                isCheckable = true
                isChecked = tag == activeGenre
                setOnClickListener {
                    activeGenre = tag
                    loadFeed(tag)
                }
            }
            binding.discoverGenreChips.addView(chip)
        }
    }

    private fun loadFeed(genre: String) {
        val ctx = requireContext().applicationContext
        val nowPlaying = PowerampStateMonitor.state.value
        loadJob?.cancel()
        loadJob = viewLifecycleOwner.lifecycleScope.launch {
            _binding?.discoverLoading?.isVisible = true
            suspendRunCatching {
                BridgeAppGraph.api(ctx).homeFeed(
                    genre = genre,
                    nowPlayingArtist = nowPlaying.artist.takeIf { nowPlaying.hasTrack },
                    nowPlayingTrack = nowPlaying.title.takeIf { nowPlaying.hasTrack },
                    limit = 24,
                )
            }.onSuccess { feed ->
                val b = _binding ?: return@onSuccess
                b.discoverLoading.isVisible = false
                bindFeed(b, feed)
            }.onFailure { err ->
                val b = _binding ?: return@onFailure
                b.discoverLoading.isVisible = false
                b.discoverEmpty.isVisible = topTracksAdapter.currentList.isEmpty()
                b.discoverEmpty.text = err.message ?: getString(R.string.connection_error)
            }
        }
    }

    private fun bindFeed(b: FragmentDiscoverBinding, feed: HomeFeed) {
        val hero = feed.featuredTrack
        b.discoverHeroCard.isVisible = hero != null
        if (hero != null) {
            CoverLoader.load(b.discoverHeroCover, hero.artworkUrl, R.drawable.ic_music_note)
            b.discoverHeroBadge.text = hero.badgeText
            b.discoverHeroTitle.text = hero.title
            b.discoverHeroSub.text = listOfNotNull(hero.artist, hero.album).joinToString(" · ")
            b.discoverHeroPlay.setOnClickListener { BridgePlayerActions.playTrack(this, hero) }
            b.discoverHeroSave.setOnClickListener { BridgePlayerActions.downloadTrack(this, hero) }
            viewLifecycleOwner.lifecycleScope.launch {
                val bmp = CoverLoader.loadBitmap(hero.artworkUrl)
                val cur = _binding ?: return@launch
                if (bmp != null) {
                    val accent = CoverLoader.extractAccentColor(bmp)
                    cur.discoverHeroContainer.background = GradientDrawable(
                        GradientDrawable.Orientation.TL_BR,
                        intArrayOf(accent, 0xFF141820.toInt()),
                    )
                }
            }
        }

        val hasBecause = feed.becauseYouPlayed.isNotEmpty()
        b.becauseTitle.isVisible = hasBecause
        b.becauseRecycler.isVisible = hasBecause
        if (hasBecause) {
            b.becauseTitle.text = feed.becauseYouPlayedLabel ?: "Because you're listening"
            becauseAdapter.submitList(feed.becauseYouPlayed)
        }

        b.albumsHeader.isVisible = feed.albums.isNotEmpty()
        b.discoverAlbumsRecycler.isVisible = feed.albums.isNotEmpty()
        albumAdapter.submitList(feed.albums)

        b.artistsHeader.isVisible = feed.artists.isNotEmpty()
        b.discoverArtistsRecycler.isVisible = feed.artists.isNotEmpty()
        artistAdapter.submitList(feed.artists)

        topTracksAdapter.submitList(feed.tracks)
        b.discoverEmpty.isVisible = feed.tracks.isEmpty()
    }

    override fun onDestroyView() {
        loadJob?.cancel()
        _binding = null
        super.onDestroyView()
    }
}
