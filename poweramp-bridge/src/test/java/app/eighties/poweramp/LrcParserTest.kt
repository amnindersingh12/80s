package app.eighties.poweramp

import app.eighties.poweramp.data.LrcParser
import org.junit.Assert.assertEquals
import org.junit.Test

class LrcParserTest {
    @Test
    fun `parses timestamps and resolves active line index`() {
        val raw = """
            [ar:AP Dhillon]
            [00:05.00] First line
            [00:12.50][00:45.00] Chorus line
            [00:20.00] Second verse
        """.trimIndent()
        val lines = LrcParser.parse(raw)
        assertEquals(4, lines.size)
        assertEquals(5000L, lines[0].timeMs)
        assertEquals("Chorus line", lines[1].text)
        assertEquals(45000L, lines[3].timeMs)

        assertEquals(-1, LrcParser.activeIndex(lines, 2000L))
        assertEquals(0, LrcParser.activeIndex(lines, 8000L))
        assertEquals(1, LrcParser.activeIndex(lines, 15000L))
        assertEquals(3, LrcParser.activeIndex(lines, 46000L))
    }
}
