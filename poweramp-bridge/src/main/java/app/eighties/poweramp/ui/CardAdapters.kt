package app.eighties.poweramp.ui

import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import app.eighties.poweramp.R
import app.eighties.poweramp.data.AlbumSummary
import app.eighties.poweramp.data.ArtistSummary
import app.eighties.poweramp.databinding.ItemAlbumCardBinding
import app.eighties.poweramp.databinding.ItemArtistCardBinding

class ArtistCarouselAdapter(
    private val onClick: (ArtistSummary) -> Unit,
) : ListAdapter<ArtistSummary, ArtistCarouselAdapter.Holder>(DIFF) {

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder =
        Holder(ItemArtistCardBinding.inflate(LayoutInflater.from(parent.context), parent, false))

    override fun onBindViewHolder(holder: Holder, position: Int) {
        val item = getItem(position)
        CoverLoader.load(holder.b.artistImage, item.imageUrl, R.drawable.ic_music_note)
        holder.b.artistName.text = item.name
        holder.b.root.setOnClickListener { onClick(item) }
    }

    class Holder(val b: ItemArtistCardBinding) : RecyclerView.ViewHolder(b.root)

    companion object {
        private val DIFF = object : DiffUtil.ItemCallback<ArtistSummary>() {
            override fun areItemsTheSame(a: ArtistSummary, b: ArtistSummary) = a.id == b.id && a.name == b.name
            override fun areContentsTheSame(a: ArtistSummary, b: ArtistSummary) = a == b
        }
    }
}

class AlbumCarouselAdapter(
    private val onClick: (AlbumSummary) -> Unit,
) : ListAdapter<AlbumSummary, AlbumCarouselAdapter.Holder>(DIFF) {

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder =
        Holder(ItemAlbumCardBinding.inflate(LayoutInflater.from(parent.context), parent, false))

    override fun onBindViewHolder(holder: Holder, position: Int) {
        val item = getItem(position)
        CoverLoader.load(holder.b.albumCover, item.coverUrl, R.drawable.ic_music_note)
        holder.b.albumTitle.text = item.title
        holder.b.albumSubtitle.text = listOfNotNull(item.artist, item.year?.toString()).joinToString(" · ")
        holder.b.root.setOnClickListener { onClick(item) }
    }

    class Holder(val b: ItemAlbumCardBinding) : RecyclerView.ViewHolder(b.root)

    companion object {
        private val DIFF = object : DiffUtil.ItemCallback<AlbumSummary>() {
            override fun areItemsTheSame(a: AlbumSummary, b: AlbumSummary) = a.id == b.id && a.title == b.title
            override fun areContentsTheSame(a: AlbumSummary, b: AlbumSummary) = a == b
        }
    }
}
