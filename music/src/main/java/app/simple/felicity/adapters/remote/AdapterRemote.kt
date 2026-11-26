package app.simple.felicity.adapters.remote

import android.annotation.SuppressLint
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import app.simple.felicity.R
import app.simple.felicity.databinding.AdapterRemoteCarouselBinding
import app.simple.felicity.databinding.AdapterRemoteChipsBinding
import app.simple.felicity.databinding.AdapterRemoteHeroBinding
import app.simple.felicity.databinding.AdapterRemoteMessageBinding
import app.simple.felicity.databinding.AdapterRemoteSectionBinding
import app.simple.felicity.databinding.AdapterRemoteTrackBinding
import app.simple.felicity.decorations.overscroll.VerticalListViewHolder
import app.simple.felicity.decorations.toggles.FelicityChipGroup
import app.simple.felicity.glide.transformation.RoundedCorners
import app.simple.felicity.remote.RemoteTrack
import app.simple.felicity.repository.models.Audio
import app.simple.felicity.shared.utils.TimeUtils.toDynamicTimeString
import app.simple.felicity.streaming.ArtworkColorHelper
import app.simple.felicity.streaming.DownloadState
import app.simple.felicity.utils.AdapterUtils.addAudioQualityIcon
import com.bumptech.glide.Glide
import com.bumptech.glide.load.engine.DiskCacheStrategy
import com.bumptech.glide.load.resource.bitmap.CenterCrop

/** Rows of the Online Mode panel. Every ViewHolder extends [VerticalListViewHolder] for overscroll. */
sealed interface RemoteItem {
    data class Hero(
            val item: Track,
            val badge: String,
    ) : RemoteItem

    data class TrackCarousel(
            val items: List<Track>,
    ) : RemoteItem

    data class ArtistCarousel(
            val artists: List<ArtistCarouselItem>,
    ) : RemoteItem

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
            val coverUrl: String? = null,
            val album: String? = null,
            val downloaded: Boolean = false,
            val isPlaying: Boolean = false,
    ) : RemoteItem

    data class Chips(val chips: List<Chip>, val selectedTag: Any? = null) : RemoteItem

    data class Chip(val label: String, val tag: Any, val onClick: () -> Unit)

    data class Message(val text: String, val actionText: String? = null, val action: (() -> Unit)? = null) : RemoteItem
}

interface RemoteTrackCallbacks {
    fun onPlay(track: RemoteTrack)
    fun onMenu(track: RemoteTrack, anchor: View)
    fun onDownload(track: RemoteTrack)
    fun onPlayMetadata(title: String, artist: String, album: String?) {}
    fun onDownloadMetadata(title: String, artist: String, album: String?) {}
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
        is RemoteItem.Hero -> TYPE_HERO
        is RemoteItem.TrackCarousel -> TYPE_TRACK_CAROUSEL
        is RemoteItem.ArtistCarousel -> TYPE_ARTIST_CAROUSEL
        is RemoteItem.Section -> TYPE_SECTION
        is RemoteItem.Track -> TYPE_TRACK
        is RemoteItem.Chips -> TYPE_CHIPS
        is RemoteItem.Message -> TYPE_MESSAGE
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
        val inflater = LayoutInflater.from(parent.context)
        return when (viewType) {
            TYPE_HERO -> HeroHolder(AdapterRemoteHeroBinding.inflate(inflater, parent, false))
            TYPE_TRACK_CAROUSEL -> TrackCarouselHolder(AdapterRemoteCarouselBinding.inflate(inflater, parent, false))
            TYPE_ARTIST_CAROUSEL -> ArtistCarouselHolder(AdapterRemoteCarouselBinding.inflate(inflater, parent, false))
            TYPE_SECTION -> SectionHolder(AdapterRemoteSectionBinding.inflate(inflater, parent, false))
            TYPE_TRACK -> TrackHolder(AdapterRemoteTrackBinding.inflate(inflater, parent, false))
            TYPE_CHIPS -> ChipsHolder(AdapterRemoteChipsBinding.inflate(inflater, parent, false))
            else -> MessageHolder(AdapterRemoteMessageBinding.inflate(inflater, parent, false))
        }
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
        when (val item = items[position]) {
            is RemoteItem.Hero -> (holder as HeroHolder).bind(item)
            is RemoteItem.TrackCarousel -> (holder as TrackCarouselHolder).bind(item)
            is RemoteItem.ArtistCarousel -> (holder as ArtistCarouselHolder).bind(item)
            is RemoteItem.Section -> (holder as SectionHolder).bind(item)
            is RemoteItem.Track -> (holder as TrackHolder).bind(item)
            is RemoteItem.Chips -> (holder as ChipsHolder).bind(item)
            is RemoteItem.Message -> (holder as MessageHolder).bind(item)
        }
    }

    override fun onViewRecycled(holder: RecyclerView.ViewHolder) {
        super.onViewRecycled(holder)
        when (holder) {
            is TrackHolder -> {
                holder.binding.eqBars.setAnimating(false)
                Glide.with(holder.binding.cover).clear(holder.binding.cover)
            }
            is HeroHolder -> Glide.with(holder.binding.heroCover).clear(holder.binding.heroCover)
        }
    }

    inner class HeroHolder(val binding: AdapterRemoteHeroBinding) : VerticalListViewHolder(binding.root) {
        fun bind(hero: RemoteItem.Hero) {
            val t = hero.item
            binding.heroBadge.text = hero.badge
            binding.heroTitle.text = t.title
            binding.heroArtist.text = t.artist
            val coverSource: Any? = t.audio ?: t.coverUrl
            if (coverSource != null) {
                Glide.with(binding.heroCover)
                    .asBitmap()
                    .load(coverSource)
                    .transform(CenterCrop(), RoundedCorners(28))
                    .diskCacheStrategy(DiskCacheStrategy.ALL)
                    .placeholder(R.drawable.ic_song)
                    .error(R.drawable.ic_song)
                    .into(binding.heroCover)
            } else {
                binding.heroCover.setImageResource(R.drawable.ic_song)
            }
            ArtworkColorHelper.tintFromUrl(context, t.coverUrl ?: t.track?.coverUrl, binding.heroContainer, 0.42f)

            val playClick = {
                val track = t.track
                if (track != null) callbacks.onPlay(track) else callbacks.onPlayMetadata(t.title, t.artist, t.album)
            }
            val dlClick = {
                val track = t.track
                if (track != null) callbacks.onDownload(track) else callbacks.onDownloadMetadata(t.title, t.artist, t.album)
            }
            val downloaded = t.downloaded || t.download?.finished == true
            binding.heroDownload.setText(if (downloaded) R.string.remote_downloaded else R.string.remote_download_flac)
            binding.heroDownload.isEnabled = !downloaded
            binding.heroContainer.setOnClickListener { playClick() }
            binding.heroPlay.setOnClickListener { playClick() }
            binding.heroDownload.setOnClickListener { dlClick() }
        }
    }

    inner class TrackCarouselHolder(val binding: AdapterRemoteCarouselBinding) : VerticalListViewHolder(binding.root) {
        private val cardAdapter = AdapterRemoteTrackCards { t ->
            val track = t.track
            if (track != null) callbacks.onPlay(track) else callbacks.onPlayMetadata(t.title, t.artist, t.album)
        }

        init {
            binding.carousel.adapter = cardAdapter
        }

        fun bind(item: RemoteItem.TrackCarousel) {
            cardAdapter.submit(item.items)
        }
    }

    class ArtistCarouselHolder(val binding: AdapterRemoteCarouselBinding) : VerticalListViewHolder(binding.root) {
        private val artistAdapter = AdapterRemoteArtists()

        init {
            binding.carousel.adapter = artistAdapter
        }

        fun bind(item: RemoteItem.ArtistCarousel) {
            artistAdapter.submit(item.artists)
        }
    }

    class SectionHolder(val binding: AdapterRemoteSectionBinding) : VerticalListViewHolder(binding.root) {
        fun bind(item: RemoteItem.Section) {
            binding.sectionTitle.text = item.title
            binding.sectionSubtitle.text = item.subtitle
            binding.sectionSubtitle.visibility = if (item.subtitle.isNullOrBlank()) View.GONE else View.VISIBLE
            binding.sectionAction.text = item.actionText
            binding.sectionAction.visibility = if (item.action != null && item.actionText != null) View.VISIBLE else View.GONE
            binding.sectionAction.setOnClickListener { item.action?.invoke() }
        }
    }

    inner class TrackHolder(val binding: AdapterRemoteTrackBinding) : VerticalListViewHolder(binding.root) {
        fun bind(item: RemoteItem.Track) {
            val ctx = binding.root.context
            val track = item.track
            binding.title.text = item.title
            binding.secondaryDetail.text = item.artist
            if (item.audio != null) binding.title.addAudioQualityIcon(item.audio) else binding.title.setCompoundDrawablesRelative(null, null, null, null)

            binding.qualityPill.text = track?.losslessBadge ?: "FLAC"
            binding.qualityPill.visibility = View.VISIBLE

            val dl = item.download
            val isDownloaded = item.downloaded || dl?.finished == true
            val isDownloading = dl != null && !dl.finished && dl.error == null
            binding.tertiaryDetail.text = when {
                dl?.error != null -> dl.error
                isDownloaded -> ctx.getString(R.string.remote_downloaded)
                isDownloading -> ctx.getString(R.string.remote_downloading, ((dl?.progress ?: 0f) * 100).toInt())
                track == null -> listOfNotNull(ctx.getString(R.string.remote_tap_to_play), item.detail).joinToString(" · ")
                else -> listOfNotNull(
                        track.durationSec?.takeIf { it > 0 }?.let { (it * 1000L).toDynamicTimeString() },
                        item.detail,
                ).joinToString(" · ")
            }

            binding.eqBars.visibility = if (item.isPlaying) View.VISIBLE else View.GONE
            binding.eqBars.setAnimating(item.isPlaying)
            binding.cover.alpha = if (item.isPlaying) 0.45f else 1f

            val coverSource: Any? = item.audio ?: item.coverUrl
            if (coverSource != null) {
                Glide.with(binding.cover)
                    .asBitmap()
                    .load(coverSource)
                    .transform(CenterCrop(), RoundedCorners(16))
                    .diskCacheStrategy(DiskCacheStrategy.ALL)
                    .placeholder(R.drawable.ic_song)
                    .error(R.drawable.ic_song)
                    .into(binding.cover)
            } else {
                binding.cover.setImageResource(R.drawable.ic_song)
            }

            binding.downloadProgress.visibility = if (isDownloading) View.VISIBLE else View.GONE
            binding.action.visibility = if (isDownloading) View.INVISIBLE else View.VISIBLE
            binding.action.setImageResource(if (isDownloaded) R.drawable.ic_check else R.drawable.ic_download)
            binding.action.contentDescription = ctx.getString(if (isDownloaded) R.string.remote_downloaded else R.string.remote_download)
            binding.action.isEnabled = !isDownloaded && !isDownloading

            if (track == null) {
                binding.action.setOnClickListener { callbacks.onDownloadMetadata(item.title, item.artist, item.album) }
                binding.container.setOnClickListener { callbacks.onPlayMetadata(item.title, item.artist, item.album) }
                binding.container.setOnLongClickListener(null)
                return
            }
            binding.action.setOnClickListener { callbacks.onDownload(track) }
            binding.container.setOnClickListener { callbacks.onPlay(track) }
            binding.container.setOnLongClickListener {
                callbacks.onMenu(track, binding.cover)
                true
            }
        }
    }

    class ChipsHolder(val binding: AdapterRemoteChipsBinding) : VerticalListViewHolder(binding.root) {
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

    class MessageHolder(val binding: AdapterRemoteMessageBinding) : VerticalListViewHolder(binding.root) {
        fun bind(item: RemoteItem.Message) {
            binding.message.text = item.text
            binding.messageAction.text = item.actionText
            binding.messageAction.visibility = if (item.action != null && item.actionText != null) View.VISIBLE else View.GONE
            binding.messageAction.setOnClickListener { item.action?.invoke() }
        }
    }

    companion object {
        private const val TYPE_HERO = 0
        private const val TYPE_TRACK_CAROUSEL = 1
        private const val TYPE_ARTIST_CAROUSEL = 2
        private const val TYPE_SECTION = 3
        private const val TYPE_TRACK = 4
        private const val TYPE_CHIPS = 5
        private const val TYPE_MESSAGE = 6
    }
}
