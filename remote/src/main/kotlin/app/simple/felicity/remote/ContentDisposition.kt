package app.simple.felicity.remote

import java.net.URLDecoder
import java.nio.charset.StandardCharsets

/** Parses the download filename `web/` sends (`filename*=UTF-8''…` wins over `filename="…"`). */
object ContentDisposition {

    private val EXTENDED = Regex("""filename\*\s*=\s*([^']*)'[^']*'([^;]+)""", RegexOption.IGNORE_CASE)
    private val QUOTED = Regex("""filename\s*=\s*"((?:\\.|[^"\\])*)"""", RegexOption.IGNORE_CASE)
    private val TOKEN = Regex("""filename\s*=\s*([^;"\s]+)""", RegexOption.IGNORE_CASE)
    private val UNSAFE = Regex("""[\u0000-\u001f\u007f<>:"/\\|?*]+""")

    fun filename(header: String?): String? {
        if (header.isNullOrBlank()) return null
        val extended = EXTENDED.find(header)?.let { m ->
            val charset = m.groupValues[1].ifBlank { "UTF-8" }
            runCatching { URLDecoder.decode(m.groupValues[2].trim().replace("+", "%2B"), charset) }.getOrNull()
        }
        val plain = QUOTED.find(header)?.groupValues?.get(1)?.replace(Regex("""\\(.)"""), "$1")
            ?: TOKEN.find(header)?.groupValues?.get(1)
        // Strip any directory part a hostile server might send ("../../etc/passwd").
        val raw = (extended ?: plain ?: return null).substringAfterLast('/').substringAfterLast('\\')
        return sanitize(raw)
    }

    /** Safe single path component; never empty, never a hidden file, keeps the extension. */
    fun sanitize(name: String): String? {
        val cleaned = name
            .replace(UNSAFE, " ")
            .replace(Regex("""\s+"""), " ")
            .trim()
            .trim('.', ' ')
        return cleaned.takeIf { it.isNotEmpty() }?.let { if (it.length > 200) it.take(200) else it }
    }

    /** "Artist - Title.ext" built locally when the server sends no usable header. */
    fun fallback(artist: String?, title: String?, extension: String = "flac"): String {
        val base = listOfNotNull(artist?.takeIf { it.isNotBlank() }, title?.takeIf { it.isNotBlank() }).joinToString(" - ")
        return sanitize("${base.ifBlank { "track" }}.$extension") ?: "track.$extension"
    }
}
