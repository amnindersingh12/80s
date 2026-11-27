package app.eighties.poweramp.ui

import android.content.Context
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import app.eighties.poweramp.R
import app.eighties.poweramp.data.BridgeAppGraph
import app.eighties.poweramp.data.LosslessTrack
import app.eighties.poweramp.poweramp.PowerampHelper
import app.eighties.poweramp.poweramp.PowerampStateMonitor
import kotlinx.coroutines.launch

/** Shared playback, queue, download, and navigation actions used across Discover, Search, Artist, and Album views. */
object BridgePlayerActions {

    fun playTrack(fragment: Fragment, track: LosslessTrack, onBusyMessage: ((String?) -> Unit)? = null) {
        val ctx = fragment.requireContext()
        val localUri = BridgeAppGraph.localLibrary(ctx).findLocalUri(track.artist, track.title)
        if (localUri != null) {
            PowerampStateMonitor.setOptimisticPlaying(ctx, track)
            if (!PowerampHelper.playLocalUriInPoweramp(ctx, localUri, track)) {
                Toast.makeText(ctx, R.string.poweramp_not_found, Toast.LENGTH_LONG).show()
            }
            return
        }
        fragment.viewLifecycleOwner.lifecycleScope.launch {
            onBusyMessage?.invoke(ctx.getString(R.string.preparing_stream, track.title))
            runCatching {
                val prepared = BridgeAppGraph.api(ctx).prepareOrResolve(track)
                BridgeAppGraph.db(ctx).addRecentSearchTrack(prepared.track)
                prepared
            }.onSuccess { prepared ->
                onBusyMessage?.invoke(null)
                PowerampStateMonitor.setOptimisticPlaying(ctx, prepared.track)
                if (!PowerampHelper.playUrlInPoweramp(ctx, prepared.signedStreamUrl, prepared.track)) {
                    Toast.makeText(ctx, R.string.poweramp_not_found, Toast.LENGTH_LONG).show()
                }
            }.onFailure { err ->
                onBusyMessage?.invoke(null)
                Toast.makeText(ctx, err.message ?: "Stream unavailable", Toast.LENGTH_LONG).show()
            }
        }
    }

    fun playList(fragment: Fragment, tracks: List<LosslessTrack>, onBusyMessage: ((String?) -> Unit)? = null) {
        val first = tracks.firstOrNull() ?: return
        val ctx = fragment.requireContext()
        PowerampHelper.queueTracksInBridge(ctx, tracks, playNext = true)
        playTrack(fragment, first, onBusyMessage)
    }

    fun queueTrack(context: Context, track: LosslessTrack, playNext: Boolean) {
        PowerampHelper.queueTracksInBridge(context, listOf(track), playNext = playNext)
        Toast.makeText(
            context,
            if (playNext) "\"${track.title}\" queued next in Bridge Queue" else "Added \"${track.title}\" to Bridge Queue",
            Toast.LENGTH_SHORT,
        ).show()
    }

    fun downloadTrack(fragment: Fragment, track: LosslessTrack, onState: ((DownloadState) -> Unit)? = null) {
        val ctx = fragment.requireContext()
        onState?.invoke(DownloadState.DOWNLOADING)
        fragment.viewLifecycleOwner.lifecycleScope.launch {
            runCatching { BridgeAppGraph.downloads(ctx).downloadToLibrary(track) }
                .onSuccess { savedPath ->
                    onState?.invoke(DownloadState.DOWNLOADED)
                    Toast.makeText(ctx, ctx.getString(R.string.download_saved, savedPath), Toast.LENGTH_SHORT).show()
                }
                .onFailure { err ->
                    onState?.invoke(DownloadState.IDLE)
                    Toast.makeText(ctx, err.message ?: "Download failed", Toast.LENGTH_LONG).show()
                }
        }
    }

    fun openLyrics(fragment: Fragment, track: LosslessTrack) {
        LyricsSheetDialogFragment.newInstance(track).show(fragment.parentFragmentManager, "lyrics_sheet")
    }

    fun openArtist(fragment: Fragment, id: String?, name: String) {
        (fragment.activity as? MainActivity)?.openArtist(id, name)
    }

    fun openAlbum(fragment: Fragment, id: String?, title: String, artist: String) {
        (fragment.activity as? MainActivity)?.openAlbum(id, title, artist)
    }
}
