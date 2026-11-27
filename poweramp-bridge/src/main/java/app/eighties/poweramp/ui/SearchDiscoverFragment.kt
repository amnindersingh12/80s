package app.eighties.poweramp.ui

import android.content.Context
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import androidx.core.view.isVisible
import androidx.core.widget.doAfterTextChanged
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import app.eighties.poweramp.R
import app.eighties.poweramp.data.BridgeAppGraph
import app.eighties.poweramp.data.SearchCatalogResult
import app.eighties.poweramp.data.SearchTopResult
import app.eighties.poweramp.databinding.FragmentSearchDiscoverBinding
import com.google.android.material.chip.Chip
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

class SearchDiscoverFragment : Fragment() {

    private var _binding: FragmentSearchDiscoverBinding? = null
    private val binding get() = _binding!!

    private lateinit var trackAdapter: TrackAdapter
    private lateinit var artistAdapter: ArtistCarouselAdapter
    private lateinit var albumAdapter: AlbumCarouselAdapter
    private var activeFilter: String = "all"
    private var lastQuery: String = ""
    private var searchJob: Job? = null

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentSearchDiscoverBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        val localIndex = BridgeAppGraph.localLibrary(requireContext())

        trackAdapter = TrackAdapter(
            onPlayClick = { t ->
                BridgePlayerActions.playTrack(this, t) { msg ->
                    binding.statusBanner.isVisible = msg != null
                    binding.statusBanner.text = msg.orEmpty()
                }
            },
            onDownloadClick = { t ->
                BridgePlayerActions.downloadTrack(this, t) { st -> trackAdapter.setDownloadState(t.id, st) }
            },
            onLyricsClick = { t -> BridgePlayerActions.openLyrics(this, t) },
            onMoreClick = { t -> TrackActionBottomSheet.newInstance(t).show(childFragmentManager, "track_actions") },
            isOfflineDownloaded = { t -> localIndex.isDownloaded(t.artist, t.title) },
        )
        artistAdapter = ArtistCarouselAdapter { ar -> BridgePlayerActions.openArtist(this, ar.id, ar.name) }
        albumAdapter = AlbumCarouselAdapter { al -> BridgePlayerActions.openAlbum(this, al.id, al.title, al.artist) }

        binding.recyclerTracks.layoutManager = LinearLayoutManager(requireContext())
        binding.recyclerTracks.adapter = trackAdapter
        binding.searchArtistsRecycler.layoutManager = LinearLayoutManager(requireContext(), LinearLayoutManager.HORIZONTAL, false)
        binding.searchArtistsRecycler.adapter = artistAdapter
        binding.searchAlbumsRecycler.layoutManager = LinearLayoutManager(requireContext(), LinearLayoutManager.HORIZONTAL, false)
        binding.searchAlbumsRecycler.adapter = albumAdapter

        setupFilterChips()
        setupRecentChips()
        setupSearchBar()
        showIdleState()

        if (arguments?.getBoolean(MainActivity.EXTRA_FOCUS_SEARCH, false) == true) {
            requestSearchFocus()
        }

        viewLifecycleOwner.lifecycleScope.launch {
            localIndex.version.collectLatest { trackAdapter.notifyDataSetChanged() }
        }
    }

    fun requestSearchFocus() {
        val b = _binding ?: return
        b.searchInput.requestFocus()
        val imm = requireContext().getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
        imm?.showSoftInput(b.searchInput, InputMethodManager.SHOW_IMPLICIT)
    }

    private fun setupFilterChips() {
        val filters = listOf("all" to "All", "tracks" to "Tracks", "artists" to "Artists", "albums" to "Albums")
        binding.filterChips.removeAllViews()
        filters.forEach { (id, label) ->
            val chip = Chip(requireContext()).apply {
                text = label
                isCheckable = true
                isChecked = id == activeFilter
                setOnClickListener {
                    activeFilter = id
                    val q = binding.searchInput.text?.toString()?.trim().orEmpty()
                    if (q.length >= 2) runSearch(q)
                }
            }
            binding.filterChips.addView(chip)
        }
    }

    private fun setupRecentChips() {
        val prefs = BridgeAppGraph.prefs(requireContext())
        val recents = prefs.recentSearches
        binding.recentChips.removeAllViews()
        recents.forEach { q ->
            val chip = Chip(requireContext()).apply {
                text = q
                isCloseIconVisible = true
                setOnClickListener {
                    binding.searchInput.setText(q)
                    binding.searchInput.setSelection(q.length)
                    runSearch(q)
                }
                setOnCloseIconClickListener {
                    prefs.recentSearches = prefs.recentSearches.filterNot { it.equals(q, ignoreCase = true) }
                    setupRecentChips()
                }
            }
            binding.recentChips.addView(chip)
        }
        binding.recentSection.isVisible = binding.searchInput.text.isNullOrBlank() && recents.isNotEmpty()
    }

    private fun setupSearchBar() {
        binding.searchInput.doAfterTextChanged { text ->
            val q = text?.toString()?.trim().orEmpty()
            binding.btnClear.isVisible = q.isNotEmpty()
            if (q.length < 2) {
                searchJob?.cancel()
                showIdleState()
            } else if (q != lastQuery) {
                searchJob?.cancel()
                searchJob = viewLifecycleOwner.lifecycleScope.launch {
                    delay(450L)
                    runSearch(q)
                }
            }
        }
        binding.searchInput.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEARCH) {
                val q = binding.searchInput.text?.toString()?.trim().orEmpty()
                if (q.isNotEmpty()) runSearch(q)
                true
            } else false
        }
        binding.btnSearch.setOnClickListener {
            val q = binding.searchInput.text?.toString()?.trim().orEmpty()
            if (q.isNotEmpty()) runSearch(q)
        }
        binding.btnClear.setOnClickListener {
            binding.searchInput.text?.clear()
            lastQuery = ""
            showIdleState()
        }
    }

    private fun showIdleState() {
        binding.loadingBar.isVisible = false
        binding.heroCard.isVisible = false
        binding.songsHeaderRow.isVisible = false
        binding.searchArtistsHeader.isVisible = false
        binding.searchArtistsRecycler.isVisible = false
        binding.searchAlbumsHeader.isVisible = false
        binding.searchAlbumsRecycler.isVisible = false
        trackAdapter.submitList(emptyList())
        setupRecentChips()
        binding.emptyText.isVisible = true
        binding.emptyText.text = "Search Hi-Res FLAC tracks, artists, and albums."
    }

    private fun runSearch(query: String) {
        val ctx = requireContext()
        lastQuery = query
        searchJob?.cancel()
        searchJob = viewLifecycleOwner.lifecycleScope.launch {
            binding.recentSection.isVisible = false
            binding.loadingBar.isVisible = true
            binding.emptyText.isVisible = false
            runCatching { BridgeAppGraph.api(ctx).searchCatalog(query, type = activeFilter, limit = 30) }
                .onSuccess { res ->
                    binding.loadingBar.isVisible = false
                    if (res.tracks.isNotEmpty() || res.artists.isNotEmpty() || res.albums.isNotEmpty()) {
                        BridgeAppGraph.prefs(ctx).addRecentSearch(query)
                    }
                    bindResults(res)
                }
                .onFailure { err ->
                    binding.loadingBar.isVisible = false
                    binding.heroCard.isVisible = false
                    binding.songsHeaderRow.isVisible = false
                    binding.emptyText.isVisible = true
                    binding.emptyText.text = err.message ?: getString(R.string.connection_error)
                }
        }
    }

    private fun bindResults(res: SearchCatalogResult) {
        val top = if (activeFilter == "all") res.topResult else null
        binding.heroCard.isVisible = top != null
        when (top) {
            is SearchTopResult.TrackHit -> {
                val tr = top.track
                CoverLoader.load(binding.heroCover, tr.artworkUrl, R.drawable.ic_music_note)
                binding.heroBadge.text = tr.badgeText
                binding.heroTitle.text = tr.title
                binding.heroSubtitle.text = listOfNotNull(tr.artist, tr.album).joinToString(" · ")
                binding.heroPlay.text = "Play"
                binding.heroLyrics.isVisible = true
                binding.heroSave.isVisible = true
                binding.heroPlay.setOnClickListener { BridgePlayerActions.playTrack(this, tr) }
                binding.heroLyrics.setOnClickListener { BridgePlayerActions.openLyrics(this, tr) }
                binding.heroSave.setOnClickListener { BridgePlayerActions.downloadTrack(this, tr) }
            }
            is SearchTopResult.ArtistHit -> {
                CoverLoader.load(binding.heroCover, top.artist.imageUrl, R.drawable.ic_music_note)
                binding.heroBadge.text = "ARTIST"
                binding.heroTitle.text = top.artist.name
                binding.heroSubtitle.text = top.artist.genres.take(2).joinToString(" · ").ifBlank { "Lossless Catalog" }
                binding.heroPlay.text = "Open"
                binding.heroLyrics.isVisible = false
                binding.heroSave.isVisible = false
                binding.heroPlay.setOnClickListener { BridgePlayerActions.openArtist(this, top.artist.id, top.artist.name) }
            }
            is SearchTopResult.AlbumHit -> {
                CoverLoader.load(binding.heroCover, top.album.coverUrl, R.drawable.ic_music_note)
                binding.heroBadge.text = "ALBUM"
                binding.heroTitle.text = top.album.title
                binding.heroSubtitle.text = top.album.artist
                binding.heroPlay.text = "Open"
                binding.heroLyrics.isVisible = false
                binding.heroSave.isVisible = false
                binding.heroPlay.setOnClickListener { BridgePlayerActions.openAlbum(this, top.album.id, top.album.title, top.album.artist) }
            }
            null -> {}
        }

        val visibleTracks = if (activeFilter == "all") res.tracks.take(5) else res.tracks
        binding.songsHeaderRow.isVisible = visibleTracks.isNotEmpty()
        binding.btnSeeAllSongs.isVisible = activeFilter == "all" && res.tracks.size > 5
        binding.btnSeeAllSongs.setOnClickListener {
            activeFilter = "tracks"
            setupFilterChips()
            runSearch(lastQuery)
        }
        trackAdapter.submitList(visibleTracks)

        binding.searchArtistsHeader.isVisible = res.artists.isNotEmpty()
        binding.searchArtistsRecycler.isVisible = res.artists.isNotEmpty()
        artistAdapter.submitList(res.artists)

        binding.searchAlbumsHeader.isVisible = res.albums.isNotEmpty()
        binding.searchAlbumsRecycler.isVisible = res.albums.isNotEmpty()
        albumAdapter.submitList(res.albums)

        val any = visibleTracks.isNotEmpty() || res.artists.isNotEmpty() || res.albums.isNotEmpty()
        binding.emptyText.isVisible = !any
        if (!any) binding.emptyText.text = getString(R.string.empty_search)
    }

    override fun onDestroyView() {
        _binding = null
        super.onDestroyView()
    }
}
