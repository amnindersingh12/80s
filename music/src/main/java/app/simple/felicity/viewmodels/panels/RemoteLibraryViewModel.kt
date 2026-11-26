package app.simple.felicity.viewmodels.panels

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.simple.felicity.engine.managers.MediaPlaybackManager
import app.simple.felicity.remote.RecommendationSeed
import app.simple.felicity.remote.Recommendations
import app.simple.felicity.remote.RemoteApiException
import app.simple.felicity.remote.RemoteCatalog
import app.simple.felicity.remote.SearchResult
import app.simple.felicity.remote.ServerHealth
import app.simple.felicity.remote.withWakeRetry
import app.simple.felicity.streaming.RemoteMusicRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import javax.inject.Inject

/** Generic loading state for one request. */
sealed interface Loadable<out T> {
    data object Idle : Loadable<Nothing>
    data object Loading : Loadable<Nothing>
    data class Loaded<T>(val value: T) : Loadable<T>
    data class Failed(val message: String, val accessDenied: Boolean = false) : Loadable<Nothing>
}

enum class RemoteTab { SEARCH, DISCOVER }

/**
 * State for the Stream panel: server status, debounced remote search and Discover/Radio
 * recommendations. All network work goes through [RemoteMusicRepository].
 */
@OptIn(FlowPreview::class)
@HiltViewModel
class RemoteLibraryViewModel @Inject constructor(val remote: RemoteMusicRepository) : ViewModel() {

    private val _tab = MutableStateFlow(RemoteTab.SEARCH)
    val tab: StateFlow<RemoteTab> = _tab.asStateFlow()

    private val _health = MutableStateFlow<Loadable<ServerHealth>>(Loadable.Idle)
    val health: StateFlow<Loadable<ServerHealth>> = _health.asStateFlow()

    private val query = MutableStateFlow("")
    private val _search = MutableStateFlow<Loadable<SearchResult>>(Loadable.Idle)
    val search: StateFlow<Loadable<SearchResult>> = _search.asStateFlow()

    private val _seed = MutableStateFlow<RecommendationSeed?>(null)
    val seed: StateFlow<RecommendationSeed?> = _seed.asStateFlow()

    private val _recommendations = MutableStateFlow<Loadable<Recommendations>>(Loadable.Idle)
    val recommendations: StateFlow<Loadable<Recommendations>> = _recommendations.asStateFlow()

    private var recJob: Job? = null

    private val _waking = MutableStateFlow(false)

    /** True while a request is slow enough that the server is probably waking from sleep. */
    val waking: StateFlow<Boolean> = _waking.asStateFlow()

    init {
        refreshHealth()
        viewModelScope.launch {
            query.debounce(350).distinctUntilChanged().collectLatest { q ->
                if (q.isBlank()) {
                    _search.value = Loadable.Idle
                    return@collectLatest
                }
                _search.value = Loadable.Loading
                _search.value = load { remote.search(q) }
            }
        }
    }

    fun setQuery(q: String) {
        query.value = q.trim()
    }

    fun currentQuery(): String = query.value

    fun retrySearch() {
        val q = query.value
        if (q.isBlank()) return
        viewModelScope.launch {
            _search.value = Loadable.Loading
            _search.value = load { remote.search(q) }
        }
    }

    fun setTab(tab: RemoteTab) {
        _tab.value = tab
        if (tab == RemoteTab.DISCOVER && _seed.value == null) discover(nowPlayingSeed() ?: RecommendationSeed.tag(DEFAULT_GENRE))
    }

    fun refreshHealth() {
        if (!remote.isConfigured()) {
            _health.value = Loadable.Idle
            return
        }
        viewModelScope.launch {
            _health.value = Loadable.Loading
            _health.value = load { remote.health() }
        }
    }

    /** Loads recommendations for [seed] (a track, an artist or a genre/scene tag). */
    fun discover(seed: RecommendationSeed) {
        _seed.value = seed
        recJob?.cancel()
        recJob = viewModelScope.launch {
            _recommendations.value = Loadable.Loading
            _recommendations.value = load { remote.recommendations(seed) }
        }
    }

    fun followNowPlaying(): Boolean {
        val seed = nowPlayingSeed() ?: return false
        discover(seed)
        return true
    }

    /** Seed from whatever is playing — a server track or a local file (artist + title). */
    fun nowPlayingSeed(): RecommendationSeed? {
        val audio = MediaPlaybackManager.getCurrentSong() ?: return null
        RemoteCatalog.get(audio.id)?.let { return RecommendationSeed.track(it) }
        val artist = audio.artist?.takeIf { it.isNotBlank() && !it.equals("<unknown>", true) } ?: return null
        val title = audio.title?.takeIf { it.isNotBlank() } ?: return RecommendationSeed.artist(artist)
        return RecommendationSeed.track(artist, title)
    }

    private suspend fun <T> load(block: suspend () -> T): Loadable<T> {
        val hint = viewModelScope.launch {
            delay(WAKE_HINT_MS)
            _waking.value = true
        }
        return try {
            Loadable.Loaded(withWakeRetry({ _waking.value = true }) { block() })
        } catch (e: CancellationException) {
            throw e
        } catch (e: RemoteApiException) {
            Loadable.Failed(e.message, e.isAccessDenied)
        } catch (e: Exception) {
            Loadable.Failed(e.message ?: e.javaClass.simpleName)
        } finally {
            hint.cancel()
            _waking.value = false
        }
    }

    companion object {
        const val DEFAULT_GENRE = "punjabi pop"
        private const val WAKE_HINT_MS = 2_500L

        /** Genre / regional chips shown on Discover (same set as the web player); value = tag seed. */
        val GENRES = listOf(
                "Punjabi Pop" to "punjabi pop",
                "Bhangra" to "bhangra",
                "Hip-Hop" to "hip-hop",
                "Indie" to "indie",
                "Synthwave" to "synthwave",
                "80s" to "80s",
                "Lo-fi" to "lo-fi",
                "Bollywood" to "bollywood",
                "R&B" to "r&b",
                "Electronic" to "electronic",
                "Jazz" to "jazz",
                "Classical" to "classical",
        )
    }
}
