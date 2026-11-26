package app.simple.felicity.ui.preferences.sub

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.net.toUri
import androidx.documentfile.provider.DocumentFile
import androidx.lifecycle.lifecycleScope
import app.simple.felicity.R
import app.simple.felicity.databinding.FragmentStreamingServerBinding
import app.simple.felicity.extensions.fragments.MediaFragment
import app.simple.felicity.preferences.RemoteServerPreferences
import app.simple.felicity.preferences.SAFPreferences
import app.simple.felicity.remote.InvalidServerUrlException
import app.simple.felicity.remote.RemoteApiException
import app.simple.felicity.remote.ServerConfig
import app.simple.felicity.remote.ServerHealth
import app.simple.felicity.shared.utils.ViewUtils.gone
import app.simple.felicity.shared.utils.ViewUtils.visible
import app.simple.felicity.streaming.RemoteMusicRepository
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Settings for the optional self-hosted `web/` server (Preferences → Library → Streaming server).
 *
 * The URL is stored in the regular preferences, the access key in the encrypted store
 * ([RemoteServerPreferences]). "Test connection" checks the values as typed, before saving.
 */
@AndroidEntryPoint
class StreamingServer : MediaFragment() {

    private lateinit var binding: FragmentStreamingServerBinding

    @Inject
    lateinit var remote: RemoteMusicRepository

    private var testJob: Job? = null

    private val folderPicker = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri: Uri? ->
        if (uri != null) {
            requireContext().contentResolver.takePersistableUriPermission(
                    uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            // Downloads must land in a folder Felicity scans, so it becomes a music folder too.
            SAFPreferences.addTreeUri(uri.toString())
            RemoteServerPreferences.setDownloadTreeUri(uri.toString())
            showDownloadFolder()
        }
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        binding = FragmentStreamingServerBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        postponeEnterTransition()
        requireHiddenMiniPlayer()

        if (savedInstanceState == null) {
            binding.urlInput.setText(RemoteServerPreferences.getServerUrl())
            binding.keyInput.setText(RemoteServerPreferences.getAccessKey(requireContext()).orEmpty())
        }
        updateDisconnectVisibility()
        showDownloadFolder()

        binding.test.setOnClickListener { testConnection() }
        binding.save.setOnClickListener { save() }
        binding.disconnect.setOnClickListener {
            testJob?.cancel()
            RemoteServerPreferences.clear(requireContext())
            binding.urlInput.setText("")
            binding.keyInput.setText("")
            binding.status.gone()
            updateDisconnectVisibility()
            showWarning(R.string.remote_disconnected)
        }
        binding.downloadFolder.setOnClickListener { folderPicker.launch(null) }

        view.startTransitionOnPreDraw()
    }

    private fun typedUrl() = binding.urlInput.text?.toString().orEmpty().trim()
    private fun typedKey() = binding.keyInput.text?.toString().orEmpty().trim().ifEmpty { null }

    private fun save() {
        val raw = typedUrl()
        if (raw.isEmpty()) {
            binding.disconnect.performClick()
            return
        }
        val normalized = try {
            ServerConfig.normalizeBaseUrl(raw).toString()
        } catch (e: InvalidServerUrlException) {
            showStatus(e.message ?: getString(R.string.remote_server_url))
            return
        }
        RemoteServerPreferences.save(requireContext(), normalized, typedKey())
        binding.urlInput.setText(normalized)
        updateDisconnectVisibility()
        showWarning(R.string.remote_saved)
        testConnection()
    }

    private fun testConnection() {
        val raw = typedUrl()
        val key = typedKey()
        testJob?.cancel()
        showStatus(getString(R.string.remote_testing))
        binding.test.isEnabled = false
        testJob = viewLifecycleOwner.lifecycleScope.launch {
            val text = try {
                describe(remote.testConnection(raw, key), key != null)
            } catch (e: InvalidServerUrlException) {
                "✗ ${e.message}"
            } catch (e: RemoteApiException) {
                "✗ ${e.message}" + if (e.code == RemoteApiException.NETWORK) "\n${getString(R.string.remote_network_hint)}" else ""
            } finally {
                binding.test.isEnabled = true
            }
            showStatus(text)
        }
    }

    /** Human-readable `/api/health` summary: gate, providers, recommendation sources. */
    private fun describe(health: ServerHealth, sentKey: Boolean): String = buildString {
        when {
            health.accessRequired && !health.authenticated ->
                appendLine("✗ " + getString(if (sentKey) R.string.remote_status_wrong_key else R.string.remote_status_locked))
            health.demo -> appendLine("✓ " + getString(R.string.remote_status_demo))
            else -> appendLine("✓ " + getString(R.string.remote_status_ok, health.primary?.name ?: "?"))
        }
        for (p in health.providers) {
            val state = when {
                p.circuitOpen -> getString(R.string.remote_provider_down)
                p.lastError != null -> p.lastError
                else -> getString(R.string.remote_provider_ok)
            }
            appendLine("• ${p.role ?: "provider"} · ${p.name}${p.kind?.let { " ($it)" }.orEmpty()}: $state")
        }
        val sources = health.recommendationSources.filterValues { it }.keys
        if (sources.isNotEmpty()) appendLine("• " + getString(R.string.remote_status_sources, sources.joinToString(", ")))
        health.cache?.let { appendLine("• cache: $it") }
    }.trimEnd()

    private fun showStatus(text: String) {
        binding.status.text = text
        binding.status.visible(animate = false)
    }

    private fun updateDisconnectVisibility() {
        if (RemoteServerPreferences.isConfigured()) binding.disconnect.visible(false) else binding.disconnect.gone(false)
    }

    private fun showDownloadFolder() {
        val chosen = RemoteServerPreferences.getDownloadTreeUri()
        val fallback = SAFPreferences.getTreeUris().firstOrNull()
        val uri = chosen ?: fallback
        val name = uri?.let { runCatching { DocumentFile.fromTreeUri(requireContext(), it.toUri())?.name }.getOrNull() ?: it }
        binding.downloadFolder.text = when {
            uri == null -> getString(R.string.remote_download_folder_none)
            chosen == null -> "${getString(R.string.remote_download_folder_default)} · $name"
            else -> name
        }
    }

    override fun getTransitionType(): TransitionType = TransitionType.DRIFT

    override val wantsMiniPlayerVisible: Boolean
        get() = false

    companion object {
        fun newInstance(): StreamingServer = StreamingServer()

        const val TAG = "StreamingServer"
    }
}
