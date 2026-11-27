package app.eighties.poweramp.data

import android.content.Context
import android.content.SharedPreferences

class BridgePrefs(context: Context) {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences("eighties_bridge_prefs", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = prefs.getString(KEY_SERVER_URL, DEFAULT_SERVER_URL)?.trim()?.trimEnd('/') ?: DEFAULT_SERVER_URL
        set(value) = prefs.edit().putString(KEY_SERVER_URL, value.trim().trimEnd('/')).apply()

    var accessKey: String
        get() = prefs.getString(KEY_ACCESS_KEY, "")?.trim() ?: ""
        set(value) = prefs.edit().putString(KEY_ACCESS_KEY, value.trim()).apply()

    var preferredGenres: Set<String>
        get() = prefs.getStringSet(KEY_PREFERRED_GENRES, DEFAULT_GENRES)?.toSet() ?: DEFAULT_GENRES
        set(value) = prefs.edit().putStringSet(KEY_PREFERRED_GENRES, value.toSet()).apply()

    var downloadTreeUri: String?
        get() = prefs.getString(KEY_DOWNLOAD_TREE_URI, null)?.takeIf { it.isNotBlank() }
        set(value) = prefs.edit().putString(KEY_DOWNLOAD_TREE_URI, value).apply()

    var downloadSubdir: String
        get() = prefs.getString(KEY_DOWNLOAD_SUBDIR, DEFAULT_DOWNLOAD_SUBDIR)?.trim()?.ifBlank { DEFAULT_DOWNLOAD_SUBDIR }
            ?: DEFAULT_DOWNLOAD_SUBDIR
        set(value) = prefs.edit().putString(KEY_DOWNLOAD_SUBDIR, value.trim().ifBlank { DEFAULT_DOWNLOAD_SUBDIR }).apply()

    var lastRadioSeedKey: String?
        get() = prefs.getString(KEY_LAST_RADIO_SEED, null)
        set(value) = prefs.edit().putString(KEY_LAST_RADIO_SEED, value).apply()

    var lastRadioUpdatedAt: Long
        get() = prefs.getLong(KEY_LAST_RADIO_AT, 0L)
        set(value) = prefs.edit().putLong(KEY_LAST_RADIO_AT, value).apply()

    var recentSearches: List<String>
        get() = prefs.getString(KEY_RECENT_SEARCHES, "")
            ?.split("\n")
            ?.map { it.trim() }
            ?.filter { it.isNotEmpty() }
            ?: emptyList()
        set(value) = prefs.edit().putString(KEY_RECENT_SEARCHES, value.take(8).joinToString("\n")).apply()

    fun addRecentSearch(query: String) {
        val clean = query.trim()
        if (clean.length < 2) return
        recentSearches = (listOf(clean) + recentSearches.filterNot { it.equals(clean, ignoreCase = true) }).take(8)
    }

    companion object {
        const val DEFAULT_SERVER_URL = "https://felicity-80s-b4c25417da9e.herokuapp.com"
        const val DEFAULT_DOWNLOAD_SUBDIR = "80s FLAC"
        val ALL_GENRES = listOf(
            "mixed" to "For You (Mixed)",
            "pop" to "Pop",
            "hip-hop" to "Hip-Hop",
            "rock" to "Rock",
            "indie" to "Indie",
            "electronic" to "Electronic",
            "rnb" to "R&B",
            "jazz" to "Jazz",
            "punjabi" to "Punjabi & Desi",
            "bollywood" to "Bollywood",
        )
        val DEFAULT_GENRES = setOf("pop", "hip-hop", "rock", "indie", "punjabi")

        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_ACCESS_KEY = "access_key"
        private const val KEY_PREFERRED_GENRES = "preferred_genres"
        private const val KEY_DOWNLOAD_TREE_URI = "download_tree_uri"
        private const val KEY_DOWNLOAD_SUBDIR = "download_subdir"
        private const val KEY_LAST_RADIO_SEED = "last_radio_seed"
        private const val KEY_LAST_RADIO_AT = "last_radio_at"
        private const val KEY_RECENT_SEARCHES = "recent_searches"
    }
}
