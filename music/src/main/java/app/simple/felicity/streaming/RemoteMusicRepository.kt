package app.simple.felicity.streaming

import android.content.Context
import android.util.Log
import app.simple.felicity.engine.managers.MediaPlaybackManager
import app.simple.felicity.engine.managers.RemoteDataSources
import app.simple.felicity.preferences.RemoteServerPreferences
import app.simple.felicity.remote.PreparePoller
import app.simple.felicity.remote.PrepareState
import app.simple.felicity.remote.RadioBatch
import app.simple.felicity.remote.RecommendationSeed
import app.simple.felicity.remote.Recommendations
import app.simple.felicity.remote.RemoteApiException
import app.simple.felicity.remote.RemoteCatalog
import app.simple.felicity.remote.RemoteIds
import app.simple.felicity.remote.RemoteTrack
import app.simple.felicity.remote.SearchResult
import app.simple.felicity.remote.ServerConfig
import app.simple.felicity.remote.ServerHealth
import app.simple.felicity.remote.WebApiClient
import app.simple.felicity.remote.withWakeRetry
import app.simple.felicity.repository.database.instances.AudioDatabase
import app.simple.felicity.repository.models.Audio
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import javax.inject.Inject
import javax.inject.Singleton

/** One-off messages for the UI (toasts / snackbars). */
sealed interface RemoteEvent {
    data class Message(val text: String) : RemoteEvent
    data class Error(val text: String) : RemoteEvent
    data object NeedsMusicFolder : RemoteEvent
}

data class DownloadState(val progress: Float?, val finished: Boolean = false, val error: String? = null)

/** An active "track/artist/genre radio" that keeps the Android queue topped up. */
data class RadioSession(val seed: RecommendationSeed, val label: String, val emptyRefills: Int = 0, val loading: Boolean = false)

/**
 * Data-source layer between Felicity and the `web/` server. Every network call in the app
 * goes through here, so with no server configured nothing else changes: [isConfigured] is
 * false, the Stream panel is hidden and the player only ever sees local URIs.
 */
@Singleton
class RemoteMusicRepository @Inject constructor(@ApplicationContext private val context: Context) {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    val api = WebApiClient({ config() })
    private val poller = PreparePoller(api)
    private val downloader = RemoteDownloader(context, api)

    private val _prepare = MutableStateFlow<PrepareState?>(null)

    /** State of the track the user just asked to play (drives the "preparing" indicator). */
    val prepare: StateFlow<PrepareState?> = _prepare.asStateFlow()

    private val _downloads = MutableStateFlow<Map<String, DownloadState>>(emptyMap())
    val downloads: StateFlow<Map<String, DownloadState>> = _downloads.asStateFlow()

    private val _radio = MutableStateFlow<RadioSession?>(null)
    val radio: StateFlow<RadioSession?> = _radio.asStateFlow()

    private val _events = MutableSharedFlow<RemoteEvent>(extraBufferCapacity = 16)
    val events: SharedFlow<RemoteEvent> = _events.asSharedFlow()

    private var prepareJob: Job? = null
    private var radioWatcher: Job? = null
    private val prewarmed = LinkedHashSet<String>()

    fun config(): ServerConfig? = RemoteServerPreferences.getServerConfig(context)

    fun isConfigured(): Boolean = config() != null

    // ------------------------------------------------------------- browse ---

    suspend fun health(onWaking: () -> Unit = {}): ServerHealth = withWakeRetry(onWaking) { api.health() }

    /**
     * Checks settings the user typed but hasn't saved yet: hits `GET /api/health` on [rawUrl]
     * with [accessKey]. Throws [app.simple.felicity.remote.InvalidServerUrlException] for an
     * unusable address and [RemoteApiException] for network/server errors.
     */
    suspend fun testConnection(rawUrl: String, accessKey: String?, onWaking: () -> Unit = {}): ServerHealth {
        val cfg = ServerConfig.from(rawUrl, accessKey)
            ?: throw app.simple.felicity.remote.InvalidServerUrlException("Enter the server address")
        val client = WebApiClient({ cfg })
        // A sleeping free-tier dyno (Heroku Eco …) can miss the first request: one retry.
        return withWakeRetry(onWaking) { client.health() }
    }

    suspend fun search(query: String): SearchResult = api.search(query)

    suspend fun recommendations(seed: RecommendationSeed): Recommendations = api.recommendations(seed)

    suspend fun home(genre: String? = null, seedArtist: String? = null): Recommendations = api.home(genre, seedArtist)

    suspend fun localLibraryKeys(): Set<String> = withContext(Dispatchers.IO) {
        runCatching {
            AudioDatabase.getInstance(context).audioDao()?.getAllAudioListAll().orEmpty()
                .mapNotNull { normKey(it.title, it.artist) }
                .toSet()
        }.getOrDefault(emptySet())
    }

    suspend fun findLocalAudio(title: String, artist: String): Audio? = withContext(Dispatchers.IO) {
        val target = normKey(title, artist) ?: return@withContext null
        runCatching {
            AudioDatabase.getInstance(context).audioDao()?.getAllAudioListAll().orEmpty()
                .firstOrNull { normKey(it.title, it.artist) == target }
        }.getOrNull()
    }

    private fun normKey(title: String?, artist: String?): String? {
        val t = title?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
        val a = artist?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
        return "$a|$t"
    }

    fun trackKey(title: String, artist: String): String = "${artist.trim().lowercase()}|${title.trim().lowercase()}"

    // ----------------------------------------------------------- playback ---

    /**
     * Plays [track] now. The server first has to make the file streamable (an upstream job that
     * can take tens of seconds), so this polls `/api/tracks/:id/prepare` and only hands the
     * track to the player once it is ready — the UI shows [prepare] in the meantime.
     */
    fun play(track: RemoteTrack, onReady: (() -> Unit)? = null) {
        if (!track.isLosslessSupported) {
            _events.tryEmit(RemoteEvent.Error("Only lossless FLAC/ALAC tracks are supported"))
            return
        }
        prepareJob?.cancel()
        prepareJob = scope.launch {
            findLocalAudio(track.title, track.artist)?.let { local ->
                MediaPlaybackManager.insertAndPlay(local)
                onReady?.invoke()
                return@launch
            }
            poller.prepare(track.id).collect { state ->
                _prepare.value = state
                when (state) {
                    is PrepareState.Ready -> {
                        MediaPlaybackManager.insertAndPlay(toHydratedAudio(track))
                        if (state.fallback) _events.tryEmit(RemoteEvent.Message("Streaming from fallback server (${state.servedBy})"))
                        onReady?.invoke()
                        prewarmUpcoming()
                    }
                    is PrepareState.Failed -> _events.tryEmit(RemoteEvent.Error(state.message))
                    else -> Unit
                }
            }
        }
    }

    fun resolveAndPlay(title: String, artist: String, album: String? = null) {
        prepareJob?.cancel()
        prepareJob = scope.launch {
            findLocalAudio(title, artist)?.let { local ->
                MediaPlaybackManager.insertAndPlay(local)
                return@launch
            }
            _prepare.value = PrepareState.Starting("resolve:$artist|$title")
            try {
                val res = api.resolve(title, artist, album)
                val ready = res.prepare
                if (ready.state == "ready") {
                    _prepare.value = PrepareState.Ready(res.track.id, ready.servedBy, ready.fallback)
                    MediaPlaybackManager.insertAndPlay(toHydratedAudio(res.track))
                    prewarmUpcoming()
                } else {
                    play(res.track)
                }
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                val msg = e.message ?: "Could not resolve track"
                _prepare.value = PrepareState.Failed("resolve:$artist|$title", "RESOLVE_FAILED", msg, retryable = true)
                _events.tryEmit(RemoteEvent.Error(msg))
            }
        }
    }

    fun resolveAndDownload(title: String, artist: String, album: String? = null) {
        scope.launch {
            try {
                val res = api.resolve(title, artist, album)
                download(res.track)
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                _events.tryEmit(RemoteEvent.Error(e.message ?: "Download failed"))
            }
        }
    }

    fun cancelPrepare() {
        prepareJob?.cancel()
        _prepare.value = null
    }

    fun dismissPrepareState() {
        if (_prepare.value?.isTerminal == true) _prepare.value = null
    }

    /** Queues [track] right after the current song; the stream is warmed up in the background. */
    fun playNext(track: RemoteTrack) {
        MediaPlaybackManager.playNext(toAudio(track))
        prewarm(track)
        _events.tryEmit(RemoteEvent.Message("“${track.title}” plays next"))
    }

    fun enqueue(tracks: List<RemoteTrack>, announce: Boolean = true) {
        if (tracks.isEmpty()) return
        tracks.forEach { MediaPlaybackManager.addToQueue(toAudio(it)) }
        tracks.take(2).forEach(::prewarm)
        if (announce) {
            _events.tryEmit(RemoteEvent.Message(if (tracks.size == 1) "Added “${tracks[0].title}” to the queue" else "Added ${tracks.size} tracks to the queue"))
        }
    }

    /** Plays [tracks] immediately (optionally shuffled) and queues the rest. */
    fun playAll(tracks: List<RemoteTrack>, shuffle: Boolean = false) {
        val list = if (shuffle) tracks.shuffled() else tracks
        val first = list.firstOrNull() ?: return
        val rest = list.drop(1)
        play(first) {
            if (rest.isNotEmpty()) enqueue(rest, announce = false)
        }
        _events.tryEmit(RemoteEvent.Message(if (shuffle) "Shuffling ${list.size} lossless tracks" else "Playing ${list.size} lossless tracks"))
    }

    fun toAudio(track: RemoteTrack) = RemoteAudioMapper.toAudio(track, api.streamUrl(track.id))

    private suspend fun toHydratedAudio(track: RemoteTrack): Audio = withContext(Dispatchers.IO) {
        val audio = toAudio(track)
        val savedFav = runCatching { AudioDatabase.getInstance(context).audioDao()?.getAudioById(audio.id)?.isFavorite == true }.getOrDefault(false)
        if (savedFav) audio.isFavorite = true
        audio
    }

    // -------------------------------------------------------------- radio ---

    /**
     * Starts a radio station. For a track seed the seed itself plays first; then playable
     * recommendations are appended to the active queue, and the queue is topped up again
     * whenever fewer than three tracks are left (re-seeding from the latest radio track
     * when the station runs dry, like the web player).
     */
    fun startRadio(seed: RecommendationSeed, label: String, startWith: RemoteTrack? = null) {
        scope.launch {
            _radio.value = RadioSession(seed, label, loading = true)
            if (startWith != null) {
                val ready = runCatching { poller.awaitReady(startWith.id) { _prepare.value = it } }
                if (ready.isFailure) {
                    _radio.value = null
                    _events.tryEmit(RemoteEvent.Error(ready.exceptionOrNull()?.message ?: "Couldn't start radio"))
                    return@launch
                }
                MediaPlaybackManager.insertAndPlay(toAudio(startWith))
            }
            val batch = fetchRadio(seed) ?: run { _radio.value = null; return@launch }
            if (batch.tracks.isEmpty()) {
                _radio.value = null
                _events.tryEmit(RemoteEvent.Error("No playable tracks found for “$label” on your server"))
                return@launch
            }
            enqueue(batch.tracks, announce = false)
            _radio.value = RadioSession(seed, batch.seedLabel.ifBlank { label })
            _events.tryEmit(RemoteEvent.Message("Radio started: ${batch.seedLabel.ifBlank { label }} (${batch.tracks.size} tracks)"))
            watchQueueForRadio()
        }
    }

    fun stopRadio() {
        radioWatcher?.cancel()
        _radio.value = null
    }

    private fun watchQueueForRadio() {
        radioWatcher?.cancel()
        radioWatcher = scope.launch {
            MediaPlaybackManager.songPositionFlow.collect { position ->
                val session = _radio.value ?: return@collect
                val remaining = MediaPlaybackManager.getQueueSize() - position - 1
                if (remaining >= 3 || session.loading) return@collect
                refillRadio(session)
            }
        }
    }

    private suspend fun refillRadio(session: RadioSession) {
        _radio.value = session.copy(loading = true)
        val lastRadioTrack = MediaPlaybackManager.getSongs().lastOrNull { RemoteIds.isRemoteAudioId(it.id) }?.let { RemoteCatalog.get(it.id) }
        val seed = if (session.emptyRefills > 0 && lastRadioTrack != null) RecommendationSeed.track(lastRadioTrack) else session.seed
        val batch = fetchRadio(seed)
        when {
            batch == null -> _radio.value = null
            batch.tracks.isNotEmpty() -> {
                enqueue(batch.tracks, announce = false)
                _radio.value = session.copy(loading = false, emptyRefills = 0)
            }
            session.emptyRefills >= 2 -> {
                _radio.value = null
                _events.tryEmit(RemoteEvent.Message("Radio ran out of new tracks"))
            }
            else -> _radio.value = session.copy(loading = false, emptyRefills = session.emptyRefills + 1)
        }
    }

    private suspend fun fetchRadio(seed: RecommendationSeed): RadioBatch? {
        val exclude = MediaPlaybackManager.getSongs()
            .filter { RemoteIds.isRemoteAudioId(it.id) }
            .mapNotNull { RemoteCatalog.get(it.id) }
            .flatMap { listOfNotNull(it.id, it.key) }
        return try {
            api.radio(seed, exclude, limit = 12)
        } catch (e: RemoteApiException) {
            _events.tryEmit(RemoteEvent.Error("Radio: ${e.message}"))
            null
        }
    }

    // ---------------------------------------------------------- downloads ---

    fun download(track: RemoteTrack) {
        if (!track.isLosslessSupported) {
            _events.tryEmit(RemoteEvent.Error("Only lossless FLAC/ALAC downloads are supported"))
            return
        }
        if (_downloads.value[track.id]?.let { !it.finished && it.error == null } == true) return
        _downloads.update { it + (track.id to DownloadState(progress = null)) }
        scope.launch {
            val result = downloader.download(track) { p ->
                _downloads.update { it + (track.id to DownloadState(progress = p)) }
            }
            when (result) {
                is DownloadResult.Saved -> {
                    _downloads.update { it + (track.id to DownloadState(1f, finished = true)) }
                    _events.tryEmit(RemoteEvent.Message("Saved “${result.displayName}” to ${result.folderName}"))
                }
                is DownloadResult.AlreadyExists -> {
                    _downloads.update { it + (track.id to DownloadState(1f, finished = true)) }
                    _events.tryEmit(RemoteEvent.Message("“${result.displayName}” is already in your library"))
                }
                is DownloadResult.Failed -> {
                    _downloads.update { it + (track.id to DownloadState(null, error = result.message)) }
                    _events.tryEmit(if (result.needsFolder) RemoteEvent.NeedsMusicFolder else RemoteEvent.Error("Download failed: ${result.message}"))
                }
            }
        }
    }

    // ------------------------------------------------------------ helpers ---

    /** Ask the server to start packaging upcoming remote tracks so they start without a wait. */
    private fun prewarmUpcoming() {
        val songs = MediaPlaybackManager.getSongs()
        val from = MediaPlaybackManager.getCurrentSongPosition() + 1
        songs.drop(from).take(2).mapNotNull { RemoteCatalog.get(it.id) }.forEach(::prewarm)
    }

    private fun prewarm(track: RemoteTrack) {
        if (!prewarmed.add(track.id)) return
        if (prewarmed.size > 200) prewarmed.remove(prewarmed.first())
        scope.launch(Dispatchers.IO) {
            runCatching {
                val status = api.prepare(track.id)
                if (status.state == "ready") {
                    RemoteDataSources.prefetchStream(context, api.streamUrl(track.id))
                }
            }.onFailure { Log.d(TAG, "prewarm ${track.id} failed: ${it.message}") }
        }
    }

    companion object {
        private const val TAG = "RemoteMusicRepository"
    }
}
