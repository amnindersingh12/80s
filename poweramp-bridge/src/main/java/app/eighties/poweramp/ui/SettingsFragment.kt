package app.eighties.poweramp.ui

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import app.eighties.poweramp.R
import app.eighties.poweramp.data.BridgeAppGraph
import app.eighties.poweramp.data.BridgePrefs
import app.eighties.poweramp.databinding.FragmentSettingsBinding
import app.eighties.poweramp.poweramp.PowerampHelper
import com.google.android.material.chip.Chip
import kotlinx.coroutines.launch

class SettingsFragment : Fragment() {

    private var _binding: FragmentSettingsBinding? = null
    private val binding get() = _binding!!

    private val folderPicker = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        if (uri != null) {
            val ctx = requireContext()
            runCatching {
                ctx.contentResolver.takePersistableUriPermission(
                    uri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
                )
            }
            BridgeAppGraph.prefs(ctx).downloadTreeUri = uri.toString()
            updateFolderSummary()
        }
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentSettingsBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        val prefs = BridgeAppGraph.prefs(requireContext())

        binding.inputServerUrl.setText(prefs.serverUrl)
        binding.inputAccessKey.setText(prefs.accessKey)
        updateFolderSummary()
        setupPreferredGenreChips(prefs)

        binding.btnSaveSettings.setOnClickListener {
            saveFields()
            Toast.makeText(requireContext(), R.string.settings_saved, Toast.LENGTH_SHORT).show()
        }

        binding.btnPickFolder.setOnClickListener {
            folderPicker.launch(null)
        }

        binding.btnResetFolder.setOnClickListener {
            prefs.downloadTreeUri = null
            updateFolderSummary()
        }

        binding.btnTestConnection.setOnClickListener {
            saveFields()
            testConnection()
        }

        binding.btnRefreshFolders.setOnClickListener {
            saveFields()
            refreshPowerampFolders()
        }

        binding.btnOpenPowerampFolders.setOnClickListener {
            val opened = PowerampHelper.openPowerampMusicFolders(requireContext())
            if (!opened) {
                Toast.makeText(requireContext(), R.string.poweramp_not_found, Toast.LENGTH_LONG).show()
            }
        }
    }

    override fun onDestroyView() {
        _binding = null
        super.onDestroyView()
    }

    private fun saveFields() {
        val prefs = BridgeAppGraph.prefs(requireContext())
        prefs.serverUrl = binding.inputServerUrl.text?.toString().orEmpty()
        prefs.accessKey = binding.inputAccessKey.text?.toString().orEmpty()
        val selected = buildSet {
            for (i in 0 until binding.preferredGenresGroup.childCount) {
                val chip = binding.preferredGenresGroup.getChildAt(i) as? Chip
                if (chip?.isChecked == true) (chip.tag as? String)?.let(::add)
            }
        }
        if (selected.isNotEmpty()) prefs.preferredGenres = selected
    }

    private fun setupPreferredGenreChips(prefs: BridgePrefs) {
        val current = prefs.preferredGenres
        binding.preferredGenresGroup.removeAllViews()
        BridgePrefs.ALL_GENRES.filter { it.first != "mixed" }.forEach { (tag, label) ->
            val chip = Chip(requireContext()).apply {
                this.tag = tag
                text = label
                isCheckable = true
                isChecked = current.contains(tag)
            }
            binding.preferredGenresGroup.addView(chip)
        }
    }

    private fun updateFolderSummary() {
        val prefs = BridgeAppGraph.prefs(requireContext())
        val tree = prefs.downloadTreeUri
        binding.downloadFolderPath.text = if (tree != null) {
            "Custom SAF folder: ${Uri.decode(tree)}"
        } else {
            "Default: Music/${prefs.downloadSubdir}"
        }
    }

    private fun testConnection() {
        val ctx = requireContext()
        binding.healthStatusText.text = getString(R.string.testing_connection)
        viewLifecycleOwner.lifecycleScope.launch {
            runCatching { BridgeAppGraph.api(ctx).health() }
                .onSuccess { h ->
                    val authLabel = when {
                        !h.accessRequired -> "Open"
                        h.authenticated -> "Authenticated"
                        else -> "Wrong / Missing Access Key"
                    }
                    binding.healthStatusText.text = buildString {
                        appendLine("Connected (${if (h.demo) "demo" else "live"}, cache: ${h.cache ?: "memory"})")
                        appendLine("Auth: $authLabel")
                        append("Providers: ${h.providers.joinToString(", ")}")
                    }
                }
                .onFailure { err ->
                    binding.healthStatusText.text = "Connection failed: ${err.message}"
                }
        }
    }

    private fun refreshPowerampFolders() {
        val ctx = requireContext()
        binding.healthStatusText.text = getString(R.string.refreshing_folders)
        viewLifecycleOwner.lifecycleScope.launch {
            runCatching {
                val synced = BridgeAppGraph.syncManager(ctx).refreshAll()
                PowerampHelper.triggerRescan(ctx, null, fromUi = true)
                synced
            }.onSuccess { count ->
                binding.healthStatusText.text = getString(R.string.folders_refreshed, count)
            }.onFailure { err ->
                binding.healthStatusText.text = "Refresh failed: ${err.message}"
            }
        }
    }
}
