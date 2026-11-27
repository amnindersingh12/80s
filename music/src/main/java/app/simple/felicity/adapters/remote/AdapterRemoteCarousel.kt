package app.simple.felicity.adapters.remote

import android.annotation.SuppressLint
import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import app.simple.felicity.R
import app.simple.felicity.databinding.ItemRemoteArtistBinding
import app.simple.felicity.databinding.ItemRemoteCardBinding
import app.simple.felicity.decorations.overscroll.HorizontalListViewHolder
import app.simple.felicity.glide.transformation.RoundedCorners
import com.bumptech.glide.Glide
import com.bumptech.glide.load.engine.DiskCacheStrategy
import com.bumptech.glide.load.resource.bitmap.CenterCrop
import com.bumptech.glide.load.resource.bitmap.CircleCrop

/** Horizontal square-art cards ("Picked For You / Trending") extending [HorizontalListViewHolder]. */
class AdapterRemoteTrackCards(
        private val onClick: (RemoteItem.Track) -> Unit
) : RecyclerView.Adapter<AdapterRemoteTrackCards.CardHolder>() {

    private var items: List<RemoteItem.Track> = emptyList()

    @SuppressLint("NotifyDataSetChanged")
    fun submit(newItems: List<RemoteItem.Track>) {
        if (items == newItems) return
        items = newItems
        notifyDataSetChanged()
    }

    override fun getItemCount() = items.size

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): CardHolder {
        val binding = ItemRemoteCardBinding.inflate(LayoutInflater.from(parent.context), parent, false)
        return CardHolder(binding)
    }

    override fun onBindViewHolder(holder: CardHolder, position: Int) = holder.bind(items[position])

    override fun onViewRecycled(holder: CardHolder) {
        super.onViewRecycled(holder)
        Glide.with(holder.binding.cardCover).clear(holder.binding.cardCover)
    }

    inner class CardHolder(val binding: ItemRemoteCardBinding) : HorizontalListViewHolder(binding.root) {
        fun bind(item: RemoteItem.Track) {
            binding.cardTitle.text = item.title
            binding.cardArtist.text = item.artist
            binding.cardBadge.text = item.track?.losslessBadge ?: "FLAC"
            val coverSource: Any? = item.audio ?: item.coverUrl
            if (coverSource != null) {
                Glide.with(binding.cardCover)
                    .asBitmap()
                    .load(coverSource)
                    .transform(CenterCrop(), RoundedCorners(28))
                    .diskCacheStrategy(DiskCacheStrategy.ALL)
                    .placeholder(R.drawable.ic_song)
                    .error(R.drawable.ic_song)
                    .into(binding.cardCover)
            } else {
                binding.cardCover.setImageResource(R.drawable.ic_song)
            }
            binding.cardRoot.setOnClickListener { onClick(item) }
        }
    }
}

data class ArtistCarouselItem(val name: String, val imageUrl: String?, val onClick: () -> Unit)

/** Horizontal circular-avatar artist carousel extending [HorizontalListViewHolder]. */
class AdapterRemoteArtists : RecyclerView.Adapter<AdapterRemoteArtists.ArtistHolder>() {

    private var items: List<ArtistCarouselItem> = emptyList()

    @SuppressLint("NotifyDataSetChanged")
    fun submit(newItems: List<ArtistCarouselItem>) {
        if (items == newItems) return
        items = newItems
        notifyDataSetChanged()
    }

    override fun getItemCount() = items.size

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ArtistHolder {
        val binding = ItemRemoteArtistBinding.inflate(LayoutInflater.from(parent.context), parent, false)
        return ArtistHolder(binding)
    }

    override fun onBindViewHolder(holder: ArtistHolder, position: Int) = holder.bind(items[position])

    override fun onViewRecycled(holder: ArtistHolder) {
        super.onViewRecycled(holder)
        Glide.with(holder.binding.artistAvatar).clear(holder.binding.artistAvatar)
    }

    inner class ArtistHolder(val binding: ItemRemoteArtistBinding) : HorizontalListViewHolder(binding.root) {
        fun bind(item: ArtistCarouselItem) {
            binding.artistName.text = item.name
            if (!item.imageUrl.isNullOrBlank()) {
                Glide.with(binding.artistAvatar)
                    .asBitmap()
                    .load(item.imageUrl)
                    .transform(CenterCrop(), CircleCrop())
                    .diskCacheStrategy(DiskCacheStrategy.ALL)
                    .placeholder(R.drawable.ic_people)
                    .error(R.drawable.ic_people)
                    .into(binding.artistAvatar)
            } else {
                binding.artistAvatar.setImageResource(R.drawable.ic_people)
            }
            binding.artistRoot.setOnClickListener { item.onClick() }
        }
    }
}
