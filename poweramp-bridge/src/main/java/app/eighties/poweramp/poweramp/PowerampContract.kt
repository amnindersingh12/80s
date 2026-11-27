package app.eighties.poweramp.poweramp

/** Constants aligned with `maxmpz/powerampapi` (`TrackProviderConsts` & `PowerampAPI`). */
object PowerampContract {
    const val POWERAMP_PACKAGE = "com.maxmpz.audioplayer"
    const val API_RECEIVER_NAME = "com.maxmpz.audioplayer.player.PowerampAPIReceiver"
    const val API_ACTIVITY_NAME = "com.maxmpz.audioplayer.PowerampAPIActivity"
    const val ACTIVITY_SETTINGS = "com.maxmpz.audioplayer.preference.SettingsActivity"

    // TrackProviderConsts
    const val COLUMN_ALBUM_ARTIST = "album_artist"
    const val COLUMN_GENRE = "genre"
    const val COLUMN_TRACK_ALT = "track_alt"
    const val COLUMN_BITS_PER_SAMPLE = "bits_per_sample"
    const val COLUMN_URL = "url"
    const val COLUMN_TRACK_LYRICS = "lyrics"
    const val COLUMN_TRACK_LYRICS_SYNCED = "lyrics_synced"
    const val COLUMN_TRACK_WAVE = "track_wave"
    const val COLUMN_HEADERS = "headers"
    const val COLUMN_HTTP_METHOD = "method"
    const val COLUMN_FLAGS = "__flags"

    const val FLAG_NO_SUBDIRS = 0x0001
    const val FLAG_HAS_SUBDIRS = 0x0002
    const val FLAG_HAS_LYRICS = 0x0004

    const val DYNAMIC_URL = "__dynamic_url"

    const val CALL_GET_URL = "com.maxmpz.audioplayer:get_url"
    const val CALL_RESCAN = "com.maxmpz.audioplayer:rescan"
    const val CALL_GET_DIR_METADATA = "com.maxmpz.audioplayer:get_dir_metadata"
    const val EXTRA_ANCESTORS = "ancestors"

    // Playback / Track Changed / Scanner intents
    const val ACTION_API_COMMAND = "com.maxmpz.audioplayer.API_COMMAND"
    const val EXTRA_COMMAND = "cmd"
    const val CMD_OPEN_TO_PLAY = 20
    const val EXTRA_PACKAGE = "pak"

    const val ACTION_TRACK_CHANGED = "com.maxmpz.audioplayer.TRACK_CHANGED"
    const val ACTION_TRACK_CHANGED_EXPLICIT = "com.maxmpz.audioplayer.TRACK_CHANGED_EXPLICIT"
    const val EXTRA_TRACK = "track"
    const val TRACK_TITLE = "title"
    const val TRACK_ARTIST = "artist"
    const val TRACK_ALBUM = "album"

    const val ACTION_SCAN_DIRS = "com.maxmpz.audioplayer.ACTION_SCAN_DIRS"
    const val EXTRA_SCAN_PROVIDERS = "scanProviders"
    const val EXTRA_FAST_SCAN = "fastScan"
    const val EXTRA_PATH = "path"
    const val EXTRA_CAUSE = "cause"

    const val EXTRA_OPEN_PATH = "open_path"
    const val EXTRA_NO_BACKSTACK = "no_backstack"
}
