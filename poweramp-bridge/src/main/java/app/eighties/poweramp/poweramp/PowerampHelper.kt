package app.eighties.poweramp.poweramp

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import app.eighties.poweramp.data.LosslessTrack

object PowerampHelper {
    private const val TAG = "PowerampHelper"

    fun providerAuthority(context: Context): String = "${context.packageName}.provider"

    fun resolvePowerampPackage(context: Context): String {
        val resolve = context.packageManager.resolveService(Intent(PowerampContract.ACTION_API_COMMAND), 0)
        return resolve?.serviceInfo?.packageName ?: PowerampContract.POWERAMP_PACKAGE
    }

    fun isPowerampInstalled(context: Context): Boolean {
        return runCatching {
            context.packageManager.getPackageInfo(resolvePowerampPackage(context), 0)
            true
        }.getOrDefault(false)
    }

    /** Opens and plays an untouched FLAC/ALAC stream directly inside Poweramp. */
    fun playUrlInPoweramp(context: Context, signedStreamUrl: String, track: LosslessTrack): Boolean {
        val pkg = resolvePowerampPackage(context)
        val uri = Uri.parse(signedStreamUrl)

        val apiIntent = Intent(PowerampContract.ACTION_API_COMMAND).apply {
            component = ComponentName(pkg, PowerampContract.API_ACTIVITY_NAME)
            data = uri
            putExtra(PowerampContract.EXTRA_COMMAND, PowerampContract.CMD_OPEN_TO_PLAY)
            putExtra(PowerampContract.EXTRA_PACKAGE, context.packageName)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        val launchedApi = runCatching {
            context.startActivity(apiIntent)
            true
        }.getOrDefault(false)
        if (launchedApi) return true

        val viewIntent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, track.mimeType)
            setPackage(pkg)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        val launchedView = runCatching {
            context.startActivity(viewIntent)
            true
        }.getOrDefault(false)
        if (launchedView) return true

        return runCatching {
            val fallback = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, track.mimeType)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(fallback)
            true
        }.getOrDefault(false)
    }

    fun openPowerampMusicFolders(context: Context): Boolean {
        val pkg = resolvePowerampPackage(context)
        val intent = Intent().apply {
            component = ComponentName(pkg, PowerampContract.ACTIVITY_SETTINGS)
            putExtra(PowerampContract.EXTRA_OPEN_PATH, "library/music_folders_button")
            putExtra(PowerampContract.EXTRA_NO_BACKSTACK, true)
            putExtra(PowerampContract.EXTRA_PACKAGE, context.packageName)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        return runCatching {
            context.startActivity(intent)
            true
        }.getOrDefault(false)
    }

    /**
     * Triggers a targeted Poweramp scan of this provider (or specific folderId).
     * Uses PowerampAPIReceiver broadcast when called from background so Android 8+
     * does not reject activity starts, or APIActivity when [fromUi] is true.
     */
    fun triggerRescan(context: Context, folderId: String? = null, fromUi: Boolean = false) {
        val pkg = resolvePowerampPackage(context)
        val auth = providerAuthority(context)
        val targetPath = if (folderId.isNullOrBlank() || folderId == "root") {
            "@$auth/"
        } else {
            "@$auth/${Uri.encode("root")}/${Uri.encode(folderId)}/"
        }
        val intent = Intent(PowerampContract.ACTION_SCAN_DIRS).apply {
            putExtra(PowerampContract.EXTRA_PATH, targetPath)
            putExtra(PowerampContract.EXTRA_SCAN_PROVIDERS, true)
            putExtra(PowerampContract.EXTRA_CAUSE, "${context.packageName} refresh")
            putExtra(PowerampContract.EXTRA_PACKAGE, context.packageName)
            if (fromUi) {
                component = ComponentName(pkg, PowerampContract.API_ACTIVITY_NAME)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            } else {
                component = ComponentName(pkg, PowerampContract.API_RECEIVER_NAME)
            }
        }
        runCatching {
            if (fromUi) context.startActivity(intent) else context.sendBroadcast(intent)
        }.onFailure {
            Log.w(TAG, "triggerRescan failed: ${it.message}")
        }
    }
}
