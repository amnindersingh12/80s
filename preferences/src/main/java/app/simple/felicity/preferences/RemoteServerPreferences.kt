package app.simple.felicity.preferences

import android.content.Context
import androidx.core.content.edit
import app.simple.felicity.manager.SharedPreferences
import app.simple.felicity.remote.ServerConfig

/**
 * Settings for the optional `web/` streaming server.
 *
 * - The base URL lives in the regular preferences file.
 * - The `APP_ACCESS_KEY` lives in the AES-256 encrypted preferences file and is never logged.
 * - When the URL is blank, [getServerConfig] returns `null` and the app behaves exactly as a
 *   local-only player: no panel, no network calls, no player changes.
 */
object RemoteServerPreferences {

    const val SERVER_URL = "remote_server_url"
    const val DOWNLOAD_TREE_URI = "remote_server_download_tree_uri"
    const val HOME_MODE = "remote_home_mode"
    private const val SEARCH_HISTORY = "remote_search_history"
    private const val MODE_ONLINE = "online"
    private const val MODE_OFFLINE = "offline"
    private const val ACCESS_KEY = "remote_server_access_key"
    private const val HISTORY_SEP = "\u001F"
    private const val MAX_HISTORY = 8

    @Volatile
    private var cached: Pair<Pair<String, String>, ServerConfig?>? = null

    fun getServerUrl(): String = SharedPreferences.getSharedPreferences().getString(SERVER_URL, "").orEmpty()

    fun isConfigured(): Boolean = runCatching { getServerUrl().isNotBlank() }.getOrDefault(false)

    /** Persisted Online/Offline home mode; defaults to Online when a streaming server URL is saved. */
    fun isOnlineMode(): Boolean {
        val stored = runCatching { SharedPreferences.getSharedPreferences().getString(HOME_MODE, null) }.getOrNull()
        return when (stored) {
            MODE_ONLINE -> true
            MODE_OFFLINE -> false
            else -> isConfigured()
        }
    }

    fun setOnlineMode(online: Boolean) {
        SharedPreferences.getSharedPreferences().edit {
            putString(HOME_MODE, if (online) MODE_ONLINE else MODE_OFFLINE)
        }
    }

    /**
     * Saves both values. The URL is stored already normalised, the key encrypted.
     * Pass an empty URL to disconnect (the key is cleared too).
     */
    fun save(context: Context, normalizedUrl: String, accessKey: String?) {
        ensureEncrypted(context)
        SharedPreferences.getEncryptedSharedPreferences().edit {
            if (normalizedUrl.isBlank() || accessKey.isNullOrBlank()) remove(ACCESS_KEY) else putString(ACCESS_KEY, accessKey.trim())
        }
        // Written last: listeners keyed on SERVER_URL see the new key already in place.
        SharedPreferences.getSharedPreferences(context).edit { putString(SERVER_URL, normalizedUrl.trim()) }
        cached = null
    }

    fun clear(context: Context) = save(context, "", null)

    fun getAccessKey(context: Context): String? {
        ensureEncrypted(context)
        return runCatching { SharedPreferences.getEncryptedSharedPreferences().getString(ACCESS_KEY, null) }.getOrNull()
    }

    /**
     * Current server settings, or `null` when none are configured (or the stored URL is
     * unusable). Safe from any thread and any process (e.g. the playback service started by
     * a media button): it initialises the preference stores it needs on first use.
     */
    fun getServerConfig(context: Context): ServerConfig? {
        val url = runCatching { SharedPreferences.getSharedPreferences(context).getString(SERVER_URL, "").orEmpty() }.getOrDefault("")
        if (url.isBlank()) return null
        val key = getAccessKey(context).orEmpty()
        val signature = url to key
        cached?.let { (sig, cfg) -> if (sig == signature) return cfg }
        val cfg = ServerConfig.fromOrNull(url, key)
        cached = signature to cfg
        return cfg
    }

    fun getDownloadTreeUri(): String? =
        SharedPreferences.getSharedPreferences().getString(DOWNLOAD_TREE_URI, null)?.takeIf { it.isNotBlank() }

    fun setDownloadTreeUri(uri: String?) {
        SharedPreferences.getSharedPreferences().edit {
            if (uri.isNullOrBlank()) remove(DOWNLOAD_TREE_URI) else putString(DOWNLOAD_TREE_URI, uri)
        }
    }

    fun getSearchHistory(): List<String> =
        runCatching { SharedPreferences.getSharedPreferences().getString(SEARCH_HISTORY, "").orEmpty() }
            .getOrDefault("")
            .split(HISTORY_SEP)
            .map { it.trim() }
            .filter { it.isNotEmpty() }

    fun addSearchHistory(query: String): List<String> {
        val clean = query.replace(HISTORY_SEP, " ").trim()
        if (clean.length < 2) return getSearchHistory()
        val updated = (listOf(clean) + getSearchHistory().filterNot { it.equals(clean, ignoreCase = true) }).take(MAX_HISTORY)
        SharedPreferences.getSharedPreferences().edit {
            putString(SEARCH_HISTORY, updated.joinToString(HISTORY_SEP))
        }
        return updated
    }

    fun clearSearchHistory() {
        SharedPreferences.getSharedPreferences().edit { remove(SEARCH_HISTORY) }
    }

    private fun ensureEncrypted(context: Context) {
        if (runCatching { SharedPreferences.getEncryptedSharedPreferences() }.isFailure) {
            SharedPreferences.initEncrypted(context.applicationContext)
        }
    }
}
