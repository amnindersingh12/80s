package app.simple.felicity.streaming

import app.simple.felicity.remote.RemoteCatalog
import app.simple.felicity.remote.RemoteIds
import app.simple.felicity.remote.RemoteTrack
import app.simple.felicity.repository.models.Audio

/**
 * Turns a server track into Felicity's [Audio] model so it flows through the normal player,
 * queue, mini player and notification untouched.
 *
 * - `id` is a stable negative number ([RemoteIds]) so it never collides with local rows.
 * - `uri` is the `/api/stream/:id` URL; ExoPlayer streams it with Range requests.
 * - MIME type, sample rate and bit depth are filled in so the existing LOSSLESS / HI-RES
 *   badges (`AdapterUtils.addAudioQualityIcon`) work exactly like for local files.
 * - The track is registered in [RemoteCatalog] so covers and notification artwork resolve.
 */
object RemoteAudioMapper {

    fun toAudio(track: RemoteTrack, streamUrl: String): Audio {
        val audio = Audio()
        audio.id = RemoteCatalog.register(track)
        audio.hash = RemoteIds.hashFor(track.id)
        audio.name = "${track.artist} - ${track.title}"
        audio.title = track.title
        audio.artist = track.artist
        audio.albumArtist = track.artist
        audio.album = track.album
        audio.uri = streamUrl
        audio.path = null
        audio.duration = (track.durationSec ?: 0) * 1000L
        audio.mimeType = mimeFor(track)
        audio.sampleRate = (track.sampleRate ?: 0).toLong()
        audio.bitPerSample = (track.bitDepth ?: 0).toLong()
        audio.bitrate = (track.bitrateKbps ?: 0).toLong()
        audio.year = track.year?.toString()
        audio.trackNumber = track.trackNumber?.toString()
        audio.dateAdded = System.currentTimeMillis() / 1000
        audio.setAvailable(true)
        return audio
    }

    fun mimeFor(track: RemoteTrack): String = when (track.format?.lowercase()) {
        "flac" -> "audio/flac"
        "wav", "wave" -> "audio/wav"
        "alac", "m4a" -> "audio/mp4"
        "mp3" -> "audio/mpeg"
        "ogg", "opus" -> "audio/ogg"
        "aiff", "aif" -> "audio/aiff"
        null -> if (track.lossless) "audio/flac" else "audio/mpeg"
        else -> "audio/${track.format}"
    }

    fun extensionFor(track: RemoteTrack): String = when (val fmt = track.format?.lowercase()) {
        null -> "flac"
        "alac" -> "m4a"
        "wave" -> "wav"
        else -> fmt
    }
}
