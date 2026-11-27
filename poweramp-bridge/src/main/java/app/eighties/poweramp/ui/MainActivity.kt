package app.eighties.poweramp.ui

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.isVisible
import androidx.fragment.app.Fragment
import androidx.fragment.app.FragmentManager
import androidx.lifecycle.lifecycleScope
import app.eighties.poweramp.R
import app.eighties.poweramp.data.BridgeAppGraph
import app.eighties.poweramp.data.LosslessTrack
import app.eighties.poweramp.databinding.ActivityMainBinding
import app.eighties.poweramp.poweramp.PowerampContract
import app.eighties.poweramp.poweramp.PowerampHelper
import app.eighties.poweramp.poweramp.PowerampNowPlaying
import app.eighties.poweramp.poweramp.PowerampStateMonitor
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding

    private val powerampReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            PowerampStateMonitor.onBroadcast(context, intent)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        BridgeAppGraph.db(this).ensureDefaultFolders()
        BridgeAppGraph.localLibrary(this).refreshAsync()

        setupMiniPlayer()

        binding.bottomNav.setOnItemSelectedListener { item ->
            supportFragmentManager.popBackStack(null, FragmentManager.POP_BACK_STACK_INCLUSIVE)
            when (item.itemId) {
                R.id.nav_discover -> showRootFragment(DiscoverFragment())
                R.id.nav_search -> showRootFragment(SearchDiscoverFragment())
                R.id.nav_settings -> showRootFragment(SettingsFragment())
                else -> false
            }
        }

        val focusSearch = intent?.getBooleanExtra(EXTRA_FOCUS_SEARCH, false) == true
        if (savedInstanceState == null) {
            if (focusSearch) {
                binding.bottomNav.selectedItemId = R.id.nav_search
                val searchFrag = SearchDiscoverFragment().apply {
                    arguments = Bundle().apply { putBoolean(EXTRA_FOCUS_SEARCH, true) }
                }
                showRootFragment(searchFrag)
            } else {
                binding.bottomNav.selectedItemId = R.id.nav_discover
                showRootFragment(DiscoverFragment())
            }
        }
    }

    override fun onStart() {
        super.onStart()
        val filter = IntentFilter().apply {
            addAction(PowerampContract.ACTION_TRACK_CHANGED)
            addAction(PowerampContract.ACTION_TRACK_CHANGED_EXPLICIT)
            addAction(PowerampContract.ACTION_STATUS_CHANGED)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(powerampReceiver, filter, RECEIVER_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            registerReceiver(powerampReceiver, filter)
        }
    }

    override fun onResume() {
        super.onResume()
        PowerampStateMonitor.readStickyState(this)
        BridgeAppGraph.localLibrary(this).refreshAsync()
    }

    override fun onStop() {
        runCatching { unregisterReceiver(powerampReceiver) }
        super.onStop()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.getBooleanExtra(EXTRA_FOCUS_SEARCH, false)) {
            binding.bottomNav.selectedItemId = R.id.nav_search
            supportFragmentManager.popBackStack(null, FragmentManager.POP_BACK_STACK_INCLUSIVE)
            val frag = SearchDiscoverFragment().apply {
                arguments = Bundle().apply { putBoolean(EXTRA_FOCUS_SEARCH, true) }
            }
            showRootFragment(frag)
            binding.root.post { frag.requestSearchFocus() }
        }
    }

    fun openArtist(id: String?, name: String) {
        if (name.isBlank()) return
        supportFragmentManager.beginTransaction()
            .replace(R.id.fragmentContainer, ArtistFragment.newInstance(id, name))
            .addToBackStack("artist")
            .commit()
    }

    fun openAlbum(id: String?, title: String, artist: String) {
        if (title.isBlank()) return
        supportFragmentManager.beginTransaction()
            .replace(R.id.fragmentContainer, AlbumFragment.newInstance(id, title, artist))
            .addToBackStack("album")
            .commit()
    }

    private fun setupMiniPlayer() {
        binding.miniPrev.setOnClickListener { PowerampHelper.sendCommand(this, PowerampContract.CMD_PREVIOUS) }
        binding.miniPlayPause.setOnClickListener { PowerampHelper.sendCommand(this, PowerampContract.CMD_TOGGLE_PLAY_PAUSE) }
        binding.miniNext.setOnClickListener { PowerampHelper.sendCommand(this, PowerampContract.CMD_NEXT) }
        binding.miniPlayerBar.setOnClickListener {
            val np = PowerampStateMonitor.state.value
            if (!np.hasTrack) {
                PowerampHelper.openPowerampApp(this)
                return@setOnClickListener
            }
            val track = np.track ?: LosslessTrack(
                id = LosslessTrack.resolveSeedId(np.artist, np.title, np.album),
                provider = "poweramp",
                title = np.title,
                artist = np.artist,
                album = np.album,
                durationSec = np.durationSec.takeIf { it > 0 },
            )
            LyricsSheetDialogFragment.newInstance(track).show(supportFragmentManager, "mini_lyrics")
        }

        lifecycleScope.launch {
            PowerampStateMonitor.state.collectLatest { np -> bindMiniPlayer(np) }
        }
    }

    private fun bindMiniPlayer(np: PowerampNowPlaying) {
        binding.miniPlayerBar.isVisible = np.hasTrack
        if (!np.hasTrack) return
        binding.miniTitle.text = np.title
        val badge = np.track?.badgeText?.let { " · $it" }.orEmpty()
        binding.miniSubtitle.text = "${np.artist}$badge"
        binding.miniPlayPause.setImageResource(if (np.paused) R.drawable.ic_play else R.drawable.ic_pause)
        CoverLoader.load(binding.miniCover, np.track?.artworkUrl, R.drawable.ic_music_note)
    }

    private fun showRootFragment(fragment: Fragment): Boolean {
        supportFragmentManager.beginTransaction()
            .replace(R.id.fragmentContainer, fragment)
            .commit()
        return true
    }

    companion object {
        const val EXTRA_FOCUS_SEARCH = "focus_search"
    }
}
