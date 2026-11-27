package app.eighties.poweramp.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.core.view.isVisible
import app.eighties.poweramp.R
import app.eighties.poweramp.data.LosslessTrack
import com.google.android.material.bottomsheet.BottomSheetDialogFragment
import com.google.android.material.button.MaterialButton
import com.google.gson.Gson

class TrackActionBottomSheet : BottomSheetDialogFragment() {

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View =
        inflater.inflate(R.layout.bottom_sheet_track, container, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        val raw = arguments?.getString(ARG_TRACK_JSON) ?: run { dismiss(); return }
        val track = runCatching { Gson().fromJson(raw, LosslessTrack::class.java) }.getOrNull() ?: run { dismiss(); return }
        val host = parentFragment

        CoverLoader.load(view.findViewById<ImageView>(R.id.sheetCover), track.artworkUrl, R.drawable.ic_music_note)
        view.findViewById<TextView>(R.id.sheetTitle).text = track.title
        view.findViewById<TextView>(R.id.sheetSubtitle).text = "${track.artist} · ${track.badgeText}"

        view.findViewById<MaterialButton>(R.id.actionPlay).setOnClickListener {
            dismiss()
            if (host != null) BridgePlayerActions.playTrack(host, track)
        }
        view.findViewById<MaterialButton>(R.id.actionPlayNext).setOnClickListener {
            dismiss()
            BridgePlayerActions.queueTrack(requireContext(), track, playNext = true)
        }
        view.findViewById<MaterialButton>(R.id.actionQueue).setOnClickListener {
            dismiss()
            BridgePlayerActions.queueTrack(requireContext(), track, playNext = false)
        }
        view.findViewById<MaterialButton>(R.id.actionSave).setOnClickListener {
            dismiss()
            if (host != null) BridgePlayerActions.downloadTrack(host, track)
        }
        view.findViewById<MaterialButton>(R.id.actionLyrics).setOnClickListener {
            dismiss()
            if (host != null) BridgePlayerActions.openLyrics(host, track)
        }
        view.findViewById<MaterialButton>(R.id.actionArtist).setOnClickListener {
            dismiss()
            (activity as? MainActivity)?.openArtist(track.artistId, track.artist)
        }

        val albumBtn = view.findViewById<MaterialButton>(R.id.actionAlbum)
        albumBtn.isVisible = !track.album.isNullOrBlank()
        albumBtn.setOnClickListener {
            dismiss()
            (activity as? MainActivity)?.openAlbum(track.albumId, track.album.orEmpty(), track.artist)
        }

        view.findViewById<MaterialButton>(R.id.actionInfo).setOnClickListener {
            val sizeMb = track.fileSize?.let { String.format("%.1f MB", it / (1024.0 * 1024.0)) } ?: "Unknown"
            val info = buildString {
                appendLine("Title: ${track.title}")
                appendLine("Artist: ${track.artist}")
                track.album?.let { appendLine("Album: $it") }
                appendLine("Codec: ${track.codec} (${track.qualityTier})")
                appendLine("Spec: ${track.bitDepth ?: 16}-bit / ${(track.sampleRate ?: 44_100) / 1000.0} kHz")
                track.bitrateKbps?.let { appendLine("Bitrate: $it kbps") }
                appendLine("Size: $sizeMb")
                appendLine("Provider: ${track.provider}")
            }
            AlertDialog.Builder(requireContext())
                .setTitle("Track Info")
                .setMessage(info.trim())
                .setPositiveButton("OK", null)
                .show()
        }
    }

    companion object {
        private const val ARG_TRACK_JSON = "track_json"

        fun newInstance(track: LosslessTrack): TrackActionBottomSheet {
            return TrackActionBottomSheet().apply {
                arguments = Bundle().apply {
                    putString(ARG_TRACK_JSON, Gson().toJson(track))
                }
            }
        }
    }
}
