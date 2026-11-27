package app.eighties.poweramp.ui

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.core.view.isVisible
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import app.eighties.poweramp.R
import app.eighties.poweramp.data.LosslessTrack
import app.eighties.poweramp.databinding.ItemTrackBinding
import java.util.Locale

enum class DownloadState { IDLE, DOWNLOADING, DOWNLOADED }

class TrackAdapter(
    private val onPlayClick: (LosslessTrack) -> Unit,
    private val onDownloadClick: (LosslessTrack) -> Unit,
    private val onLyricsClick: (LosslessTrack) -> Unit,
    private val onMoreClick: (LosslessTrack) -> Unit = {},
    private val isOfflineDownloaded: (LosslessTrack) -> Boolean = { false },
    private val showTrackNumbers: Boolean = false,
) : ListAdapter<LosslessTrack, TrackAdapter.Holder>(DIFF) {

    private val downloadStates = HashMap<String, DownloadState>()

    fun setDownloadState(trackId: String, state: DownloadState) {
        downloadStates[trackId] = state
        val idx = currentList.indexOfFirst { it.id == trackId }
        if (idx >= 0) notifyItemChanged(idx)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
        val binding = ItemTrackBinding.inflate(LayoutInflater.from(parent.context), parent, false)
        return Holder(binding)
    }

    override fun onBindViewHolder(holder: Holder, position: Int) {
        val item = getItem(position)
        val offline = isOfflineDownloaded(item)
        val state = downloadStates[item.id] ?: if (offline) DownloadState.DOWNLOADED else DownloadState.IDLE
        holder.bind(item, position, state, offline)
    }

    inner class Holder(private val b: ItemTrackBinding) : RecyclerView.ViewHolder(b.root) {
        fun bind(track: LosslessTrack, position: Int, state: DownloadState, offline: Boolean) {
            if (showTrackNumbers) {
                b.trackIndex.isVisible = true
                b.trackIndex.text = "${track.trackNumber ?: (position + 1)}"
                b.trackCover.isVisible = false
            } else {
                b.trackIndex.isVisible = false
                b.trackCover.isVisible = true
                CoverLoader.load(b.trackCover, track.artworkUrl, R.drawable.ic_music_note)
            }

            b.trackTitle.text = track.title
            val yearSuffix = track.year?.let { " · $it" }.orEmpty()
            val albumPart = if (showTrackNumbers) "" else track.album?.takeIf { it.isNotBlank() }?.let { " · $it" }.orEmpty()
            b.trackSubtitle.text = "${track.artist}$albumPart$yearSuffix"
            b.trackBadge.text = track.badgeText
            b.downloadedBadge.isVisible = offline || state == DownloadState.DOWNLOADED
            val secs = (track.effectiveDurationMs / 1000L).toInt()
            b.trackDuration.text = String.format(Locale.US, "%d:%02d", secs / 60, secs % 60)

            b.root.setOnClickListener { onPlayClick(track) }
            b.btnLyrics.setOnClickListener { onLyricsClick(track) }
            b.btnMore.setOnClickListener { onMoreClick(track) }
            b.btnDownload.setOnClickListener {
                if (state == DownloadState.IDLE) onDownloadClick(track)
            }

            when (state) {
                DownloadState.IDLE -> {
                    b.downloadProgress.visibility = View.GONE
                    b.btnDownload.visibility = View.VISIBLE
                    b.btnDownload.setImageResource(R.drawable.ic_download)
                }
                DownloadState.DOWNLOADING -> {
                    b.btnDownload.visibility = View.INVISIBLE
                    b.downloadProgress.visibility = View.VISIBLE
                }
                DownloadState.DOWNLOADED -> {
                    b.downloadProgress.visibility = View.GONE
                    b.btnDownload.visibility = View.VISIBLE
                    b.btnDownload.setImageResource(R.drawable.ic_check)
                }
            }
        }
    }

    companion object {
        private val DIFF = object : DiffUtil.ItemCallback<LosslessTrack>() {
            override fun areItemsTheSame(oldItem: LosslessTrack, newItem: LosslessTrack) = oldItem.id == newItem.id
            override fun areContentsTheSame(oldItem: LosslessTrack, newItem: LosslessTrack) = oldItem == newItem
        }
    }
}
