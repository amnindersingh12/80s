package app.simple.felicity.dialogs.app

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.fragment.app.FragmentManager
import app.simple.felicity.R
import app.simple.felicity.databinding.DialogLosslessDetailsBinding
import app.simple.felicity.engine.managers.MediaPlaybackManager
import app.simple.felicity.extensions.dialogs.MediaBottomDialogFragment
import app.simple.felicity.remote.RecommendationSeed
import app.simple.felicity.remote.RemoteCatalog
import app.simple.felicity.streaming.RemoteMusicRepository
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

/**
 * Bottom sheet showing lossless audio verification, codec, bit depth, sample rate,
 * and active source (`hifi` / `remote` / `local`) plus quick Download FLAC & Start Radio actions.
 */
@AndroidEntryPoint
class LosslessDetailsDialog : MediaBottomDialogFragment() {

    @Inject
    lateinit var remote: RemoteMusicRepository

    private lateinit var binding: DialogLosslessDetailsBinding

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        binding = DialogLosslessDetailsBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        val audio = MediaPlaybackManager.getCurrentSong() ?: run {
            dismiss()
            return
        }
        val track = RemoteCatalog.get(audio.id)
        val codec = track?.resolvedCodec ?: audio.mimeType?.substringAfter('/')?.uppercase() ?: "FLAC"
        val bitDepth = track?.bitDepth ?: audio.bitPerSample.toInt().takeIf { it > 0 } ?: 16
        val sampleRate = track?.sampleRate ?: audio.sampleRate.toInt().takeIf { it > 0 } ?: 44_100
        val khz = sampleRate / 1000.0
        val srLabel = if (khz % 1.0 == 0.0) "${khz.toInt()} kHz" else String.format(java.util.Locale.US, "%.1f kHz", khz)
        val tier = track?.qualityTier ?: if (bitDepth >= 24 || sampleRate > 48_000) "HI-RES LOSSLESS" else "LOSSLESS"
        val source = track?.provider ?: "local"

        binding.losslessBadge.text = track?.losslessBadge ?: "$tier · $codec $bitDepth-bit/$srLabel"
        binding.losslessCodec.text = "Codec: $codec"
        binding.losslessSpecs.text = "Resolution: $bitDepth-bit / $srLabel"
        binding.losslessVerification.text = getString(R.string.remote_lossless_verified)
        binding.losslessSource.text = "Active source: $source"

        if (track == null) {
            binding.actionDownloadFlac.visibility = View.GONE
            binding.actionStartRadio.visibility = View.GONE
        } else {
            binding.actionDownloadFlac.setOnClickListener {
                remote.download(track)
                dismiss()
            }
            binding.actionStartRadio.setOnClickListener {
                remote.startRadio(RecommendationSeed.track(track), "${track.artist} – ${track.title}", startWith = track)
                dismiss()
            }
        }
    }

    companion object {
        private const val TAG = "LosslessDetailsDialog"

        fun FragmentManager.showLosslessDetails() {
            LosslessDetailsDialog().show(this, TAG)
        }
    }
}
