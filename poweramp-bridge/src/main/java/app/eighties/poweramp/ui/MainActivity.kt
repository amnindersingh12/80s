package app.eighties.poweramp.ui

import android.content.Intent
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.fragment.app.Fragment
import app.eighties.poweramp.R
import app.eighties.poweramp.data.BridgeAppGraph
import app.eighties.poweramp.databinding.ActivityMainBinding

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        BridgeAppGraph.db(this).ensureDefaultFolders()

        binding.bottomNav.setOnItemSelectedListener { item ->
            when (item.itemId) {
                R.id.nav_search -> showFragment(SearchDiscoverFragment::class.java, focusSearch = false)
                R.id.nav_settings -> showFragment(SettingsFragment::class.java, focusSearch = false)
                else -> false
            }
        }

        val focusSearch = intent?.getBooleanExtra(EXTRA_FOCUS_SEARCH, false) == true
        if (savedInstanceState == null) {
            if (BridgeAppGraph.prefs(this).accessKey.isBlank() && !focusSearch) {
                // Keep Search & Discover as initial screen so user can explore or tap Settings badge cleanly.
                showFragment(SearchDiscoverFragment::class.java, focusSearch = false)
            } else {
                showFragment(SearchDiscoverFragment::class.java, focusSearch = focusSearch)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.getBooleanExtra(EXTRA_FOCUS_SEARCH, false)) {
            binding.bottomNav.selectedItemId = R.id.nav_search
            showFragment(SearchDiscoverFragment::class.java, focusSearch = true)
        }
    }

    private fun showFragment(clazz: Class<out Fragment>, focusSearch: Boolean): Boolean {
        val tag = clazz.simpleName
        val existing = supportFragmentManager.findFragmentByTag(tag)
        val frag = existing ?: clazz.getDeclaredConstructor().newInstance().apply {
            if (focusSearch) {
                arguments = Bundle().apply { putBoolean(EXTRA_FOCUS_SEARCH, true) }
            }
        }
        supportFragmentManager.beginTransaction()
            .replace(R.id.fragmentContainer, frag, tag)
            .commit()
        if (focusSearch && frag is SearchDiscoverFragment) {
            binding.root.post { frag.requestSearchFocus() }
        }
        return true
    }

    companion object {
        const val EXTRA_FOCUS_SEARCH = "focus_search"
    }
}
