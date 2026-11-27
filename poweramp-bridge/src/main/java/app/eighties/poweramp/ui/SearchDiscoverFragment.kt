package app.eighties.poweramp.ui

import android.content.Context
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.Toast
import androidx.core.view.isVisible
import androidx.core.widget.doAfterTextChanged
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import app.eighties.poweramp.R
import app.eighties.poweramp.data.BridgeAppGraph
import app.eighties.poweramp.data.BridgePrefs
import app.eighties.poweramp.data.LosslessTrack
import app.eighties.poweramp.databinding.FragmentSearchDiscoverBinding
import app.eighties.poweramp.poweramp.PowerampHelper
import com.google.android.material.chip.Chip
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

class SearchDiscoverFragment : Fragment() {

    private var _binding: FragmentSearchDiscoverBinding? = null
    private val binding get() = _binding!!

    private lateinit var adapter: TrackAdapter
    private var activeGenre: String = "mixed"
    private var loadJob: Job? = null

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentSearchDiscoverBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        adapter = TrackAdapter(
            onPlayClick = ::playTrackInPoweramp,
            onDownloadClick = ::downloadTrack,
        )
        binding.recyclerTracks.layoutManager = LinearLayoutManager(requireContext())
        binding.recyclerTracks.adapter = adapter

        setupGenreChips()
        setupSearchBar()

        if (arguments?.getBoolean(MainActivity.EXTRA_FOCUS_SEARCH, false) == true) {
            requestSearchFocus()
        }
        loadHome(activeGenre)
    }

    override fun onDestroyView() {
        _binding = null
        super.onDestroyView()
    }

    fun requestSearchFocus() {
        val b = _binding ?: return
        b.searchInput.requestFocus()
        val imm = requireContext().getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
        imm?.showSoftInput(b.searchInput, InputMethodManager.SHOW_IMPLICIT)
    }

    private fun setupGenreChips() {
        binding.genreChips.removeAllViews()
        BridgePrefs.ALL_GENRES.forEach { (tag, label) ->
            val chip = Chip(requireContext()).apply {
                text = label
                isCheckable = true
                isChecked = tag == activeGenre
                setOnClickListener {
                    activeGenre = tag
                    binding.searchInput.text?.clear()
                    loadHome(tag)
                }
            }
            binding.genreChips.addView(chip)
        }
    }

    private fun setupSearchBar() {
        binding.searchInput.doAfterTextChanged { text ->
            binding.btnClear.isVisible = !text.isNullOrBlank()
        }
        binding.searchInput.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEARCH) {
                val q = binding.searchInput.text?.toString()?.trim().orEmpty()
                if (q.isNotEmpty()) runSearch(q) else loadHome(activeGenre)
                true
            } else false
        }
        binding.btnSearch.setOnClickListener {
            val q = binding.searchInput.text?.toString()?.trim().orEmpty()
            if (q.isNotEmpty()) runSearch(q) else loadHome(activeGenre)
        }
        binding.btnClear.setOnClickListener {
            binding.searchInput.text?.clear()
            loadHome(activeGenre)
        }
    }

    private fun loadHome(genre: String) {
        val ctx = requireContext()
        loadJob?.cancel()
        loadJob = viewLifecycleOwner.lifecycleScope.launch {
            setLoading(true)
            runCatching { BridgeAppGraph.api(ctx).home(genre = genre, limit = 25) }
                .onSuccess { tracks ->
                    setLoading(false)
                    adapter.submitList(tracks)
                    showEmpty(tracks.isEmpty(), getString(R.string.empty_tracks))
                }
                .onFailure { err ->
                    setLoading(false)
                    showEmpty(adapter.currentList.isEmpty(), err.message ?: getString(R.string.connection_error))
                }
        }
    }

    private fun runSearch(query: String) {
        val ctx = requireContext()
        loadJob?.cancel()
        loadJob = viewLifecycleOwner.lifecycleScope.launch {
            setLoading(true)
            runCatching { BridgeAppGraph.api(ctx).search(query, limit = 30) }
                .onSuccess { tracks ->
                    setLoading(false)
                    adapter.submitList(tracks)
                    showEmpty(tracks.isEmpty(), getString(R.string.empty_search))
                }
                .onFailure { err ->
                    setLoading(false)
                    showEmpty(true, err.message ?: getString(R.string.connection_error))
                }
        }
    }

    private fun playTrackInPoweramp(track: LosslessTrack) {
        val ctx = requireContext()
        viewLifecycleOwner.lifecycleScope.launch {
            binding.statusBanner.isVisible = true
            binding.statusBanner.text = getString(R.string.preparing_stream, track.title)
            runCatching {
                val prepared = BridgeAppGraph.api(ctx).prepareOrResolve(track)
                BridgeAppGraph.db(ctx).addRecentSearchTrack(prepared.track)
                prepared
            }.onSuccess { prepared ->
                binding.statusBanner.isVisible = false
                val ok = PowerampHelper.playUrlInPoweramp(ctx, prepared.signedStreamUrl, prepared.track)
                if (!ok) {
                    Toast.makeText(ctx, R.string.poweramp_not_found, Toast.LENGTH_LONG).show()
                }
            }.onFailure { err ->
                binding.statusBanner.isVisible = false
                Toast.makeText(ctx, err.message ?: "Stream unavailable", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun downloadTrack(track: LosslessTrack) {
        val ctx = requireContext()
        adapter.setDownloadState(track.id, DownloadState.DOWNLOADING)
        viewLifecycleOwner.lifecycleScope.launch {
            runCatching { BridgeAppGraph.downloads(ctx).downloadToLibrary(track) }
                .onSuccess { savedPath ->
                    adapter.setDownloadState(track.id, DownloadState.DOWNLOADED)
                    Toast.makeText(ctx, getString(R.string.download_saved, savedPath), Toast.LENGTH_SHORT).show()
                }
                .onFailure { err ->
                    adapter.setDownloadState(track.id, DownloadState.IDLE)
                    Toast.makeText(ctx, err.message ?: "Download failed", Toast.LENGTH_LONG).show()
                }
        }
    }

    private fun setLoading(loading: Boolean) {
        binding.loadingBar.isVisible = loading
    }

    private fun showEmpty(show: Boolean, message: String) {
        binding.emptyText.isVisible = show
        binding.emptyText.text = message
    }
}
