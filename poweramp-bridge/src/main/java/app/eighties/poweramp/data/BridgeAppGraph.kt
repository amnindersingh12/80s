package app.eighties.poweramp.data

import android.content.Context
import app.eighties.poweramp.download.FlacDownloadManager
import app.eighties.poweramp.download.LocalLibraryIndex

object BridgeAppGraph {
    @Volatile
    private var prefsInstance: BridgePrefs? = null

    @Volatile
    private var dbInstance: BridgeDatabase? = null

    @Volatile
    private var apiInstance: BridgeApiClient? = null

    @Volatile
    private var syncInstance: FolderSyncManager? = null

    @Volatile
    private var downloadInstance: FlacDownloadManager? = null

    @Volatile
    private var localLibraryInstance: LocalLibraryIndex? = null

    fun prefs(context: Context): BridgePrefs =
        prefsInstance ?: synchronized(this) {
            prefsInstance ?: BridgePrefs(context.applicationContext).also { prefsInstance = it }
        }

    fun db(context: Context): BridgeDatabase =
        dbInstance ?: synchronized(this) {
            dbInstance ?: BridgeDatabase(context.applicationContext).also { dbInstance = it }
        }

    fun api(context: Context): BridgeApiClient =
        apiInstance ?: synchronized(this) {
            apiInstance ?: run {
                val p = prefs(context)
                BridgeApiClient(
                    serverUrlProvider = { p.serverUrl },
                    accessKeyProvider = { p.accessKey },
                ).also { apiInstance = it }
            }
        }

    fun syncManager(context: Context): FolderSyncManager =
        syncInstance ?: synchronized(this) {
            syncInstance ?: FolderSyncManager(
                context.applicationContext,
                prefs(context),
                db(context),
                api(context),
            ).also { syncInstance = it }
        }

    fun downloads(context: Context): FlacDownloadManager =
        downloadInstance ?: synchronized(this) {
            downloadInstance ?: FlacDownloadManager(
                context.applicationContext,
                prefs(context),
                api(context),
            ).also { downloadInstance = it }
        }

    fun localLibrary(context: Context): LocalLibraryIndex =
        localLibraryInstance ?: synchronized(this) {
            localLibraryInstance ?: LocalLibraryIndex(context.applicationContext).also { localLibraryInstance = it }
        }
}
