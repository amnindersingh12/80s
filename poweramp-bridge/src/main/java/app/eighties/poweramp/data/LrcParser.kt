package app.eighties.poweramp.data

data class LrcLine(
    val timeMs: Long,
    val text: String,
)

object LrcParser {
    private val TIMESTAMP_REGEX = Regex("\\[(\\d{1,3}):(\\d{2})(?:[.:](\\d{1,3}))?]")

    fun parse(raw: String?): List<LrcLine> {
        if (raw.isNullOrBlank()) return emptyList()
        val out = ArrayList<LrcLine>()
        for (line in raw.lineSequence()) {
            val matches = TIMESTAMP_REGEX.findAll(line).toList()
            if (matches.isEmpty()) continue
            val text = line.substring(matches.last().range.last + 1).trim()
            if (text.isEmpty()) continue
            for (m in matches) {
                val min = m.groupValues[1].toLongOrNull() ?: continue
                val sec = m.groupValues[2].toLongOrNull() ?: continue
                val fracRaw = m.groupValues[3]
                val msFrac = when (fracRaw.length) {
                    0 -> 0L
                    1 -> (fracRaw.toLongOrNull() ?: 0L) * 100L
                    2 -> (fracRaw.toLongOrNull() ?: 0L) * 10L
                    else -> fracRaw.take(3).toLongOrNull() ?: 0L
                }
                out.add(LrcLine((min * 60L + sec) * 1000L + msFrac, text))
            }
        }
        return out.sortedBy { it.timeMs }
    }

    fun activeIndex(lines: List<LrcLine>, positionMs: Long): Int {
        if (lines.isEmpty() || positionMs < lines[0].timeMs) return -1
        var lo = 0
        var hi = lines.size - 1
        var ans = 0
        val target = positionMs + 120L
        while (lo <= hi) {
            val mid = (lo + hi) ushr 1
            if (lines[mid].timeMs <= target) {
                ans = mid
                lo = mid + 1
            } else {
                hi = mid - 1
            }
        }
        return ans
    }
}
