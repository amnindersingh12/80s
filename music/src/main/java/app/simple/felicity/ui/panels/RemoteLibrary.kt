package app.simple.felicity.ui.panels

import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.KeyEvent
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import androidx.fragment.app.viewModels
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.recyclerview.widget.LinearLayoutManager
import app.simple.felicity.R
import app.simple.felicity.activities.MainActivity
import app.simple.felicity.adapters.remote.AdapterRemote
import app.simple.felicity.adapters.remote.ArtistCarouselItem
import app.simple.felicity.adapters.remote.RemoteItem
import app.simple.felicity.adapters.remote.RemoteTrackCallbacks
import app.simple.felicity.databinding.FragmentRemoteLibraryBinding
import app.simple.felicity.decorations.popups.PopupMenuItem
import app.simple.felicity.decorations.popups.SharedScrollViewPopup
import app.simple.felicity.dialogs.playlists.AddToPlaylistDialog.Companion.showAddToPlaylistDialog
import app.simple.felicity.engine.managers.MediaPlaybackManager
import app.simple.felicity.extensions.fragments.PanelFragment
import app.simple.felicity.preferences.RemoteServerPreferences
import app.simple.felicity.remote.PrepareState
import app.simple.felicity.remote.RecommendationSeed
import app.simple.felicity.remote.Recommendations
import app.simple.felicity.remote.RemoteIds
import app.simple.felicity.remote.RemoteTrack
import app.simple.felicity.remote.SearchResult
import app.simple.felicity.remote.SeedType
import app.simple.felicity.remote.ServerHealth
import app.simple.felicity.shared.utils.ViewUtils.gone
import app.simple.felicity.shared.utils.ViewUtils.visible
import app.simple.felicity.streaming.ArtworkColorHelper
import app.simple.felicity.streaming.RemoteEvent
import app.simple.felicity.ui.preferences.sub.StreamingServer
import app.simple.felicity.viewmodels.panels.Loadable
import app.simple.felicity.viewmodels.panels.RemoteLibraryViewModel
import app.simple.felicity.viewmodels.panels.RemoteTab
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * "Stream" panel: search the self-hosted `web/` server, play lossless tracks through the normal
 * Felicity player (prepare → stream with Range seeking), download them into the library, and
 * browse Discover / Track Radio recommendations. Only reachable when a server is configured.
 */
@AndroidEntryPoint
class RemoteLibrary : PanelFragment(), RemoteTrackCallbacks {

    private lateinit var binding: FragmentRemoteLibraryBinding
    private val viewModel: RemoteLibraryViewModel by viewModels({ requireActivity() })
    private val remote get() = viewModel.remote

    private var adapter: AdapterRemote? = null

    /** Last track the user asked to play, for the "Retry" action on the preparing banner. */
    private var lastRequested: RemoteTrack? = null

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        binding = FragmentRemoteLibraryBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        adapter = AdapterRemote(this)
        binding.recyclerView.layoutManager = LinearLayoutManager(requireContext())
        binding.recyclerView.adapter = adapter
        binding.recyclerView.requireAttachedMiniPlayer()

        binding.settings.setOnClickListener { openFragment(StreamingServer.newInstance(), StreamingServer.TAG) }
        binding.modeToggle.modeOnline.alpha = 1f
        binding.modeToggle.modeOffline.alpha = 0.5f
        binding.modeToggle.modeOffline.setOnClickListener {
            RemoteServerPreferences.setOnlineMode(false)
            (requireActivity() as? MainActivity)?.showHome()
        }
        binding.tabSearch.setOnClickListener { viewModel.setTab(RemoteTab.SEARCH) }
        binding.tabDiscover.setOnClickListener { viewModel.setTab(RemoteTab.DISCOVER) }
        binding.radioStatus.setOnClickListener { remote.stopRadio() }
        setupSearchInput()

        val owner = viewLifecycleOwner
        owner.lifecycleScope.launch {
            owner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                launch { viewModel.health.collect(::showHealth) }
                launch {
                    viewModel.waking.collect {
                        showHealth(viewModel.health.value)
                        render()
                    }
                }
                launch { remote.prepare.collect(::showPrepare) }
                launch {
                    remote.radio.collect { radio ->
                        if (radio == null) {
                            binding.radioStatus.gone(true)
                        } else {
                            binding.radioStatus.text = getString(R.string.remote_radio_active, radio.label)
                            binding.radioStatus.visible(true)
                        }
                    }
                }
                launch { remote.events.collect(::onEvent) }
                launch {
                    combine(
                            viewModel.tab,
                            viewModel.search,
                            viewModel.recommendations,
                            viewModel.seed,
                            remote.downloads,
                            viewModel.localKeys,
                            viewModel.searchHistory,
                            remote.pendingResumable,
                    ) { arr ->
                        arr[0] as RemoteTab
                    }.collect { tab ->
                        showTab(tab)
                        render()
                    }
                }
                launch {
                    remote.downloads.collect { dls ->
                        if (dls.values.any { it.finished }) viewModel.refreshLocalKeys()
                    }
                }
                launch { MediaPlaybackManager.songPositionFlow.collect { render() } }
                launch { MediaPlaybackManager.playbackStateFlow.collect { render() } }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        // Coming back from the settings screen: pick up a new/removed server without hammering /api/health.
        viewModel.refreshHealth(force = false)
        render()
    }

    override fun onDestroyView() {
        adapter = null
        super.onDestroyView()
    }

    // ------------------------------------------------------------------ header ---

    private fun setupSearchInput() {
        binding.searchInput.setText(viewModel.currentQuery())
        binding.clear.visibility = if (viewModel.currentQuery().isEmpty()) View.GONE else View.VISIBLE
        binding.searchInput.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) {
                val q = s?.toString().orEmpty()
                if (q.isEmpty()) binding.clear.gone(true) else binding.clear.visible(true)
                viewModel.setQuery(q)
            }
        })
        binding.searchInput.setOnEditorActionListener { _, actionId, event ->
            if (actionId == EditorInfo.IME_ACTION_SEARCH || event?.keyCode == KeyEvent.KEYCODE_ENTER) {
                viewModel.retrySearch()
                binding.searchInput.hideInput()
                true
            } else false
        }
        binding.clear.setOnClickListener { binding.searchInput.setText("") }
    }

    private fun showTab(tab: RemoteTab) {
        val search = tab == RemoteTab.SEARCH
        binding.tabSearch.alpha = if (search) 1f else 0.5f
        binding.tabDiscover.alpha = if (search) 0.5f else 1f
        binding.searchRow.visible(false)
    }

    private fun showHealth(state: Loadable<ServerHealth>) {
        binding.serverStatus.text = when (state) {
            Loadable.Idle -> if (remote.isConfigured()) "" else getString(R.string.remote_not_configured)
            Loadable.Loading -> loadingText()
            is Loadable.Failed -> if (state.accessDenied) getString(R.string.remote_status_locked) else "✗ ${state.message}"
            is Loadable.Loaded -> {
                val h = state.value
                when {
                    h.accessRequired && !h.authenticated -> getString(R.string.remote_status_locked)
                    h.demo -> getString(R.string.remote_status_demo)
                    h.primary?.circuitOpen == true && h.fallback != null -> getString(R.string.remote_status_fallback, h.fallback!!.name)
                    else -> getString(R.string.remote_status_ok, h.primary?.name ?: "")
                }
            }
        }
    }

    private fun showPrepare(state: PrepareState?) {
        when (state) {
            null, is PrepareState.Ready -> {
                binding.prepareBanner.gone(true)
                binding.prepareProgress.gone(false)
                if (state != null) remote.dismissPrepareState()
            }
            is PrepareState.Starting, is PrepareState.Preparing -> {
                val title = lastRequested?.takeIf { it.id == state.trackId }?.title
                val stage = (state as? PrepareState.Preparing)?.stage
                val progress = (state as? PrepareState.Preparing)?.progress
                val label = when {
                    stage != null && progress != null -> getString(R.string.remote_preparing_progress, stage, (progress * 100).toInt())
                    stage != null -> getString(R.string.remote_preparing_stage, stage)
                    else -> getString(R.string.remote_preparing)
                }
                binding.prepareText.text = if (title != null) "$label\n$title" else label
                binding.prepareSpinner.visible(false)
                binding.prepareAction.text = getString(R.string.remote_cancel)
                binding.prepareAction.setOnClickListener { remote.cancelPrepare() }
                binding.prepareBanner.visible(true)
                if (progress != null) {
                    binding.prepareProgress.isIndeterminate = false
                    binding.prepareProgress.progress = (progress * 100).toInt()
                } else {
                    binding.prepareProgress.isIndeterminate = true
                }
                binding.prepareProgress.visible(false)
            }
            is PrepareState.Failed -> {
                binding.prepareText.text = state.message
                binding.prepareSpinner.gone(false)
                binding.prepareProgress.gone(false)
                val retry = lastRequested?.takeIf { it.id == state.trackId && state.retryable }
                binding.prepareAction.text = getString(if (retry != null) R.string.remote_retry else R.string.close)
                binding.prepareAction.setOnClickListener {
                    if (retry != null) onPlay(retry) else remote.dismissPrepareState()
                }
                binding.prepareBanner.visible(true)
            }
        }
    }

    private fun onEvent(event: RemoteEvent) {
        when (event) {
            is RemoteEvent.Message -> showWarning(event.text)
            is RemoteEvent.Error -> showWarning(event.text)
            RemoteEvent.NeedsMusicFolder -> {
                showWarning(R.string.remote_download_folder_none)
                openFragment(StreamingServer.newInstance(), StreamingServer.TAG)
            }
        }
    }

    // ------------------------------------------------------------------- list ---

    private fun render() {
        val adapter = adapter ?: return
        if (!remote.isConfigured()) {
            adapter.submit(listOf(RemoteItem.Message(getString(R.string.remote_not_configured), getString(R.string.remote_connect_server)) {
                openFragment(StreamingServer.newInstance(), StreamingServer.TAG)
            }))
            return
        }
        adapter.submit(if (viewModel.tab.value == RemoteTab.SEARCH) searchItems() else discoverItems())
    }

    private fun searchItems(): List<RemoteItem> = when (val s = viewModel.search.value) {
        Loadable.Idle -> {
            val items = mutableListOf<RemoteItem>()
            val pending = remote.pendingResumable.value
            if (pending.isNotEmpty()) {
                items += RemoteItem.Section(
                        getString(R.string.remote_pending_downloads),
                        actionText = getString(R.string.remote_resume_all),
                ) { remote.resumePendingDownloads() }
                items += pending.map { trackItem(it) }
            }
            val history = viewModel.searchHistory.value
            if (history.isNotEmpty()) {
                items += RemoteItem.Section(
                        getString(R.string.remote_recent_searches),
                        actionText = getString(R.string.remote_clear_history),
                ) { viewModel.clearSearchHistory() }
                items += RemoteItem.Chips(
                        history.map { q ->
                            RemoteItem.Chip(q, q) {
                                binding.searchInput.setText(q)
                                binding.searchInput.setSelection(q.length)
                            }
                        },
                )
            }
            items += RemoteItem.Section(getString(R.string.remote_suggestions))
            items += RemoteItem.Chips(
                    SEARCH_SUGGESTIONS.map { q ->
                        RemoteItem.Chip(q, q) {
                            binding.searchInput.setText(q)
                            binding.searchInput.setSelection(q.length)
                        }
                    },
            )
            items
        }
        Loadable.Loading -> {
            val q = viewModel.currentQuery()
            val matches = SEARCH_SUGGESTIONS.filter { it.contains(q, ignoreCase = true) }
            if (matches.isEmpty()) {
                listOf(RemoteItem.Message(loadingText()))
            } else {
                listOf(
                        RemoteItem.Message(loadingText()),
                        RemoteItem.Section(getString(R.string.remote_suggestions)),
                        RemoteItem.Chips(
                                matches.map { sQuery ->
                                    RemoteItem.Chip(sQuery, sQuery) {
                                        binding.searchInput.setText(sQuery)
                                        binding.searchInput.setSelection(sQuery.length)
                                    }
                                },
                        ),
                )
            }
        }
        is Loadable.Failed -> listOf(failure(s) { viewModel.retrySearch() })
        is Loadable.Loaded -> searchResults(s.value)
    }

    private fun searchResults(result: SearchResult): List<RemoteItem> {
        if (result.tracks.isEmpty()) return listOf(RemoteItem.Message(getString(R.string.remote_no_results)))
        val subtitle = listOfNotNull(result.provider, if (result.fallback) "fallback" else null).joinToString(" · ").ifBlank { null }
        return listOf(RemoteItem.Section("${result.tracks.size} · ${result.query}", subtitle, getString(R.string.remote_shuffle_play)) {
            remote.playAll(result.tracks, shuffle = true)
        }) + result.tracks.map(::trackItem)
    }

    private fun discoverItems(): List<RemoteItem> {
        val seed = viewModel.seed.value
        val items = mutableListOf<RemoteItem>()
        val pending = remote.pendingResumable.value
        if (pending.isNotEmpty()) {
            items += RemoteItem.Section(
                    getString(R.string.remote_pending_downloads),
                    actionText = getString(R.string.remote_resume_all),
            ) { remote.resumePendingDownloads() }
            items += pending.map { trackItem(it) }
        }
        items += RemoteItem.Section(getString(R.string.remote_genres), actionText = getString(R.string.remote_follow_now_playing)) {
            if (!viewModel.followNowPlaying()) showWarning(R.string.remote_nothing_playing)
        }
        items += RemoteItem.Chips(
                RemoteLibraryViewModel.GENRES.map { (label, tag) ->
                    RemoteItem.Chip(label, tag) { viewModel.loadHome(tag) }
                },
                selectedTag = seed?.takeIf { it.type == SeedType.TAG }?.tag,
        )
        when (val r = viewModel.recommendations.value) {
            Loadable.Idle -> Unit
            Loadable.Loading -> items += RemoteItem.Message(loadingText())
            is Loadable.Failed -> items += failure(r) { seed?.let(viewModel::discover) }
            is Loadable.Loaded -> items += recommendationItems(r.value)
        }
        return items
    }

    private fun recommendationItems(rec: Recommendations): List<RemoteItem> {
        val items = mutableListOf<RemoteItem>()
        val playable = rec.relatedTracks.mapNotNull { it.track }
        val subtitle = listOfNotNull(
                rec.sources.keys.takeIf { it.isNotEmpty() }?.let { getString(R.string.remote_status_sources, it.joinToString(", ")) },
                rec.warnings.firstOrNull(),
        ).joinToString("\n").ifBlank { null }

        val local = viewModel.localKeys.value
        val trackItems = rec.relatedTracks.map { r ->
            if (r.track != null) {
                trackItem(r.track!!, r.reason)
            } else {
                val playing = isTrackPlaying(null, r.title, r.artist)
                RemoteItem.Track(
                        title = r.title,
                        artist = r.artist,
                        track = null,
                        audio = null,
                        detail = r.reason,
                        coverUrl = r.coverUrl,
                        album = r.album,
                        downloaded = local.contains(remote.trackKey(r.title, r.artist)),
                        isPlaying = playing,
                )
            }
        }

        val heroTrack = trackItems.firstOrNull { !it.coverUrl.isNullOrBlank() || it.audio != null } ?: trackItems.firstOrNull()
        if (heroTrack != null) {
            ArtworkColorHelper.tintFromUrl(requireContext(), heroTrack.coverUrl ?: heroTrack.track?.coverUrl, binding.root, 0.22f)
            items += RemoteItem.Hero(heroTrack, heroTrack.track?.losslessBadge ?: "HI-RES LOSSLESS · FLAC")
        }

        items += RemoteItem.Section(
                if (rec.seed.type == SeedType.TRACK) getString(R.string.remote_because_playing, rec.seedLabel) else rec.seedLabel,
                subtitle,
                getString(if (rec.seed.type == SeedType.TRACK) R.string.remote_start_track_radio else R.string.remote_start_radio),
        ) { remote.startRadio(rec.seed, rec.seedLabel) }

        if (trackItems.size >= 3) {
            items += RemoteItem.Section(getString(R.string.remote_picked_for_you))
            items += RemoteItem.TrackCarousel(trackItems.take(8))
        }

        if (rec.similarArtists.isNotEmpty()) {
            items += RemoteItem.Section(getString(R.string.remote_similar_artists))
            items += RemoteItem.ArtistCarousel(rec.similarArtists.map { a ->
                ArtistCarouselItem(a.name, a.imageUrl) { viewModel.loadHome(seedArtist = a.name) }
            })
        }

        if (trackItems.isNotEmpty()) {
            items += RemoteItem.Section(
                    getString(R.string.remote_recommended_songs),
                    "${trackItems.size} lossless tracks",
                    if (playable.isNotEmpty()) getString(R.string.remote_shuffle_play) else null,
            ) { remote.playAll(playable, shuffle = true) }
            items += trackItems
        } else {
            items += RemoteItem.Message(getString(R.string.remote_no_results))
        }
        return items
    }

    private fun isTrackPlaying(track: RemoteTrack?, title: String, artist: String): Boolean {
        val current = MediaPlaybackManager.getCurrentSong() ?: return false
        if (!MediaPlaybackManager.isPlaying()) return false
        if (track != null && current.id == RemoteIds.audioIdFor(track.id)) return true
        return current.title.equals(title, ignoreCase = true) && current.artist.equals(artist, ignoreCase = true)
    }

    private fun loadingText(): String =
        getString(if (viewModel.waking.value) R.string.remote_waking else R.string.remote_loading)

    private fun trackItem(track: RemoteTrack, reason: String? = track.reason): RemoteItem.Track {
        // Mapping registers the track in RemoteCatalog (covers, notification artwork).
        val audio = remote.toAudio(track)
        val downloaded = viewModel.localKeys.value.contains(remote.trackKey(track.title, track.artist))
        return RemoteItem.Track(
                title = track.title,
                artist = track.artist,
                track = track,
                audio = audio,
                detail = reason,
                download = remote.downloads.value[track.id],
                coverUrl = track.coverUrl,
                album = track.album,
                downloaded = downloaded,
                isPlaying = isTrackPlaying(track, track.title, track.artist),
        )
    }

    private fun failure(state: Loadable.Failed, retry: () -> Unit): RemoteItem.Message = if (state.accessDenied) {
        RemoteItem.Message(getString(R.string.remote_status_locked), getString(R.string.remote_open_settings)) {
            openFragment(StreamingServer.newInstance(), StreamingServer.TAG)
        }
    } else {
        RemoteItem.Message(state.message, getString(R.string.remote_retry), retry)
    }

    // -------------------------------------------------------------- callbacks ---

    override fun onPlay(track: RemoteTrack) {
        lastRequested = track
        remote.play(track)
    }

    override fun onDownload(track: RemoteTrack) = remote.download(track)

    override fun onPlayMetadata(title: String, artist: String, album: String?) =
        remote.resolveAndPlay(title, artist, album)

    override fun onDownloadMetadata(title: String, artist: String, album: String?) =
        remote.resolveAndDownload(title, artist, album)

    override fun onMenu(track: RemoteTrack, anchor: View) {
        SharedScrollViewPopup(
                container = requireActivity().findViewById(R.id.app_container),
                anchorView = anchor,
                menuItems = listOf(
                        PopupMenuItem(title = R.string.remote_play_now, icon = R.drawable.ic_play),
                        PopupMenuItem(title = R.string.remote_play_next, icon = R.drawable.ic_queue),
                        PopupMenuItem(title = R.string.remote_add_to_queue, icon = R.drawable.ic_add_to_queue),
                        PopupMenuItem(title = R.string.remote_add_to_playlist, icon = R.drawable.ic_add_to_playlist),
                        PopupMenuItem(title = R.string.remote_start_track_radio, icon = R.drawable.ic_radio),
                        PopupMenuItem(title = R.string.remote_similar_artists, icon = R.drawable.ic_people),
                        PopupMenuItem(title = R.string.remote_download, icon = R.drawable.ic_download),
                ),
                onMenuItemClick = { id ->
                    when (id) {
                        R.string.remote_play_now -> onPlay(track)
                        R.string.remote_play_next -> remote.playNext(track)
                        R.string.remote_add_to_queue -> remote.enqueue(listOf(track))
                        R.string.remote_add_to_playlist -> parentFragmentManager.showAddToPlaylistDialog(remote.toAudio(track))
                        R.string.remote_start_track_radio -> {
                            lastRequested = track
                            remote.startRadio(RecommendationSeed.track(track), "${track.artist} – ${track.title}", startWith = track)
                        }
                        R.string.remote_similar_artists -> {
                            viewModel.discover(RecommendationSeed.track(track))
                            viewModel.setTab(RemoteTab.DISCOVER)
                        }
                        R.string.remote_download -> remote.download(track)
                    }
                },
        ).show()
    }

    companion object {
        fun newInstance(): RemoteLibrary = RemoteLibrary()

        const val TAG = "RemoteLibrary"

        private val SEARCH_SUGGESTIONS = listOf(
                "AP Dhillon",
                "Harnoor",
                "Diljit Dosanjh",
                "Karan Aujla",
                "Sidhu Moose Wala",
                "Shubh",
                "Punjabi Pop",
                "Bollywood",
                "Synthwave",
                "Indie",
        )
    }
}
