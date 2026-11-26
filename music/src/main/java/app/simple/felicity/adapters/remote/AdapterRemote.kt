package app.simple.felicity.adapters.remote

import android.annotation.SuppressLint
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import app.simple.felicity.R
import app.simple.felicity.databinding.AdapterRemoteChipsBinding
import app.simple.felicity.databinding.AdapterRemoteMessageBinding
import app.simple.felicity.databinding.AdapterRemoteSectionBinding
import app.simple.felicity.databinding.AdapterRemoteTrackBinding
import app.simple.felicity.decorations.toggles.FelicityChipGroup
import app.simple.felicity.glide.util.AudioCoverUtils.loadArtCoverWithPayload
import app.simple.felicity.remote.RemoteTrack
import app.simple.felicity.repository.models.Audio
import app.simple.felicity.shared.utils.TimeUtils.toDynamicTimeString
import app.simple.felicity.streaming.DownloadState
import app.simple.felicity.utils.AdapterUtils.addAudioQualityIcon
import com.bumptech.glide.Glide

/** Rows of the Stream panel. Lists are short (≤ ~60 rows), so plain rebinds are fine. */
sealed interface RemoteItem {
    data class Section(
            val title: String,
            val subtitle: String? = null,
            val actionText: String? = null,
            val action: (() -> Unit)? = null,
    ) : RemoteItem

    /** A server track (playable) or a metadata-only recommendation ([track] == null). */
    data class Track(
            val title: String,
            val artist: String,
            val track: RemoteTrack?,
            val audio: Audio?,
            val detail: String?,
            val download: DownloadState? = null,
    ) : RemoteItem

    data class Chips(val chips: List<Chip>, val selectedTag: Any? = null) : RemoteItem

    data class Chip(val label: String, val tag: Any, val onClick: () -> Unit)

    data class Message(val text: String, val actionText: String? = null, val action: (() -> Unit)? = null) : RemoteItem
}

interface RemoteTrackCallbacks {
    fun onPlay(track: RemoteTrack)
    fun onMenu(track: RemoteTrack, anchor: View)
    fun onDownload(track: RemoteTrack)
}

class AdapterRemote(private val callbacks: RemoteTrackCallbacks) : RecyclerView.Adapter<RecyclerView.ViewHolder>() {

    private var items: List<RemoteItem> = emptyList()

    @SuppressLint("NotifyDataSetChanged")
    fun submit(newItems: List<RemoteItem>) {
        items = newItems
        notifyDataSetChanged()
    }

    override fun getItemCount() = items.size

    override fun getItemViewType(position: Int) = when (items[position]) {
        is RemoteItem.Section -> TYPE_SECTION
        is RemoteItem.Track -> TYPE_TRACK
        is RemoteItem.Chips -> TYPE_CHIPS
        is RemoteItem.Message -> TYPE_MESSAGE
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
        val inflater = LayoutInflater.from(parent.context)
        return when (viewType) {
            TYPE_SECTION -> SectionHolder(AdapterRemoteSectionBinding.inflate(inflater, parent, false))
            TYPE_TRACK -> TrackHolder(AdapterRemoteTrackBinding.inflate(inflater, parent, false))
            TYPE_CHIPS -> ChipsHolder(AdapterRemoteChipsBinding.inflate(inflater, parent, false))
            else -> MessageHolder(AdapterRemoteMessageBinding.inflate(inflater, parent, false))
        }
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
        when (val item = items[position]) {
            is RemoteItem.Section -> (holder as SectionHolder).bind(item)
            is RemoteItem.Track -> (holder as TrackHolder).bind(item)
            is RemoteItem.Chips -> (holder as ChipsHolder).bind(item)
            is RemoteItem.Message -> (holder as MessageHolder).bind(item)
        }
    }

    override fun onViewRecycled(holder: RecyclerView.ViewHolder) {
        super.onViewRecycled(holder)
        if (holder is TrackHolder) Glide.with(holder.binding.cover).clear(holder.binding.cover)
    }

    class SectionHolder(val binding: AdapterRemoteSectionBinding) : RecyclerView.ViewHolder(binding.root) {
        fun bind(item: RemoteItem.Section) {
            binding.sectionTitle.text = item.title
            binding.sectionSubtitle.text = item.subtitle
            binding.sectionSubtitle.visibility = if (item.subtitle.isNullOrBlank()) View.GONE else View.VISIBLE
            binding.sectionAction.text = item.actionText
            binding.sectionAction.visibility = if (item.action != null && item.actionText != null) View.VISIBLE else View.GONE
            binding.sectionAction.setOnClickListener { item.action?.invoke() }
        }
    }

    inner class TrackHolder(val binding: AdapterRemoteTrackBinding) : RecyclerView.ViewHolder(binding.root) {
        fun bind(item: RemoteItem.Track) {
            val ctx = binding.root.context
            val track = item.track
            binding.title.text = item.title
            binding.secondaryDetail.text = item.artist
            if (item.audio != null) binding.title.addAudioQualityIcon(item.audio) else binding.title.setCompoundDrawablesRelative(null, null, null, null)

            val dl = item.download
            binding.tertiaryDetail.text = when {
                track == null -> listOfNotNull(ctx.getString(R.string.remote_not_in_library), item.detail).joinToString(" · ")
                dl?.error != null -> dl.error
                dl?.finished == true -> ctx.getString(R.string.remote_downloaded)
                dl != null -> ctx.getString(R.string.remote_downloading, ((dl.progress ?: 0f) * 100).toInt())
                else -> listOfNotNull(
                        track.durationSec?.takeIf { it > 0 }?.let { (it * 1000L).toDynamicTimeString() },
                        track.qualityLabel.takeIf { it.isNotBlank() },
                        item.detail,
                ).joinToString(" · ")
            }

            binding.root.alpha = if (track == null) 0.55f else 1f
            if (item.audio != null) binding.cover.loadArtCoverWithPayload(item.audio) else binding.cover.setImageResource(R.drawable.ic_song)

            if (track == null) {
                binding.action.visibility = View.INVISIBLE
                binding.container.setOnClickListener(null)
                binding.container.setOnLongClickListener(null)
                return
            }
            binding.action.visibility = View.VISIBLE
            binding.action.setImageResource(if (dl?.finished == true) R.drawable.ic_check else R.drawable.ic_download)
            binding.action.contentDescription = ctx.getString(R.string.remote_download)
            binding.action.isEnabled = dl == null || dl.error != null
            binding.action.setOnClickListener { callbacks.onDownload(track) }
            binding.container.setOnClickListener { callbacks.onPlay(track) }
            binding.container.setOnLongClickListener {
                callbacks.onMenu(track, binding.cover)
                true
            }
        }
    }

    class ChipsHolder(val binding: AdapterRemoteChipsBinding) : RecyclerView.ViewHolder(binding.root) {
        private var shown: List<Any>? = null

        fun bind(item: RemoteItem.Chips) {
            // Rebuilding resets the horizontal scroll, so only do it when the chips changed.
            val tags = item.chips.map { it.tag }
            if (tags == shown) {
                binding.chips.setSelectedByTag(item.selectedTag, animate = true, notifyListener = false)
                return
            }
            shown = tags
            val buttons = item.chips.map { chip ->
                FelicityChipGroup.ChipButton(
                        textResId = 0,
                        tag = chip.tag,
                        text = chip.label,
                        onSelectionChanged = { selected -> if (selected) chip.onClick() },
                )
            }
            binding.chips.setChips(buttons)
            binding.chips.setSelectedByTag(item.selectedTag, animate = false, notifyListener = false)
        }
    }

    class MessageHolder(val binding: AdapterRemoteMessageBinding) : RecyclerView.ViewHolder(binding.root) {
        fun bind(item: RemoteItem.Message) {
            binding.message.text = item.text
            binding.messageAction.text = item.actionText
            binding.messageAction.visibility = if (item.action != null && item.actionText != null) View.VISIBLE else View.GONE
            binding.messageAction.setOnClickListener { item.action?.invoke() }
        }
    }

    companion object {
        private const val TYPE_SECTION = 0
        private const val TYPE_TRACK = 1
        private const val TYPE_CHIPS = 2
        private const val TYPE_MESSAGE = 3
    }
}
