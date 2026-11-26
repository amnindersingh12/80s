package app.simple.felicity.remote

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PreparePollerTest {

    /** Scripted server: each call pops the next answer (a status or an exception). */
    private class ScriptedApi(vararg script: Any) : PrepareApi {
        private val queue = ArrayDeque(script.toList())
        val calls = mutableListOf<String>()
        val callTimes = mutableListOf<Long>()
        var clock: () -> Long = { 0 }

        private fun next(kind: String): PrepareStatus {
            calls += kind
            callTimes += clock()
            return when (val n = queue.removeFirstOrNull() ?: error("script exhausted after $calls")) {
                is PrepareStatus -> n
                is RemoteApiException -> throw n
                else -> error("bad script item $n")
            }
        }

        override suspend fun prepare(id: String) = next("POST")
        override suspend fun prepareStatus(id: String) = next("GET")
    }

    private fun st(state: String, stage: String? = null, progress: Float? = null, error: RemoteError? = null) =
        PrepareStatus("remote:t1", state, stage, progress, error = error)

    private fun TestScope.poller(api: ScriptedApi, policy: PollPolicy = PollPolicy()): PreparePoller {
        val clock = { testScheduler.currentTime }
        api.clock = clock
        return PreparePoller(api, policy, clock)
    }

    @Test
    fun `immediate 200 ready needs no polling`() = runTest {
        val api = ScriptedApi(st("ready").copy(servedBy = "remote"))
        val states = poller(api).prepare("remote:t1").toList()
        assertEquals(listOf(PrepareState.Starting("remote:t1"), PrepareState.Ready("remote:t1", "remote", false)), states)
        assertEquals(listOf("POST"), api.calls)
    }

    @Test
    fun `202 preparing polls with backoff until ready and reports progress`() = runTest {
        val api = ScriptedApi(
                st("preparing", "queued"),
                st("preparing", "packaging", 0.25f),
                st("preparing", "uploading", 0.75f),
                st("ready").copy(servedBy = "subsonic", fallback = true),
        )
        val states = poller(api).prepare("remote:t1").toList()
        assertEquals(listOf("POST", "GET", "GET", "GET"), api.calls)
        assertEquals(listOf(0L, 600L, 1410L, 2503L), api.callTimes) // 600 → 810 → 1093 ms backoff
        val preparing = states.filterIsInstance<PrepareState.Preparing>()
        assertEquals(listOf("queued", "packaging", "uploading"), preparing.map { it.stage })
        assertEquals(0.75f, preparing.last().progress!!, 0f)
        assertEquals(PrepareState.Ready("remote:t1", "subsonic", true), states.last())
    }

    @Test
    fun `backoff is capped`() = runTest {
        val api = ScriptedApi(*Array(12) { st("preparing") }, st("ready"))
        poller(api).prepare("remote:t1").toList()
        val gaps = api.callTimes.zipWithNext { a, b -> b - a }
        assertTrue(gaps.all { it <= 2000 })
        assertEquals(2000L, gaps.last())
    }

    @Test
    fun `job error status becomes Failed with the server code`() = runTest {
        val api = ScriptedApi(
                st("preparing"),
                st("error", error = RemoteError("JOB_FAILED", "R2 upload rejected", retryable = false)),
        )
        val last = poller(api).prepare("remote:t1").toList().last()
        assertEquals(PrepareState.Failed("remote:t1", "JOB_FAILED", "R2 upload rejected", false), last)
    }

    @Test
    fun `idle status (server restarted) re-posts the job`() = runTest {
        val api = ScriptedApi(st("preparing"), st("idle"), st("preparing"), st("ready"))
        poller(api).prepare("remote:t1").toList()
        assertEquals(listOf("POST", "GET", "POST", "GET"), api.calls)
    }

    @Test
    fun `tolerates transient network errors while polling`() = runTest {
        val net = RemoteApiException(0, RemoteApiException.NETWORK, "blip", true)
        val api = ScriptedApi(st("preparing"), net, net, st("ready"))
        val last = poller(api).prepare("remote:t1").toList().last()
        assertTrue(last is PrepareState.Ready)
    }

    @Test
    fun `gives up after repeated network errors`() = runTest {
        val net = RemoteApiException(0, RemoteApiException.NETWORK, "offline", true)
        val api = ScriptedApi(st("preparing"), net, net, net)
        val last = poller(api).prepare("remote:t1").toList().last() as PrepareState.Failed
        assertEquals(RemoteApiException.NETWORK, last.code)
        assertEquals(4, api.calls.size)
    }

    @Test
    fun `non-retryable errors fail immediately, including on the first POST`() = runTest {
        val denied = RemoteApiException(401, RemoteApiException.ACCESS_REQUIRED, "Unlock first", false)
        val states = poller(ScriptedApi(denied)).prepare("remote:t1").toList()
        assertEquals(listOf(PrepareState.Starting("remote:t1"), PrepareState.Failed("remote:t1", "ACCESS_REQUIRED", "Unlock first", false)), states)
    }

    @Test
    fun `client-side cap fails a job that never finishes`() = runTest {
        val api = ScriptedApi(*Array(200) { st("preparing") })
        val last = poller(api, PollPolicy(maxWaitMs = 10_000)).prepare("remote:t1").toList().last() as PrepareState.Failed
        assertEquals(RemoteApiException.TIMEOUT, last.code)
        assertTrue(last.retryable)
        assertTrue(testScheduler.currentTime in 10_000..12_000)
    }

    @Test
    fun `awaitReady reports states and throws on failure`() = runTest {
        val seen = mutableListOf<PrepareState>()
        val ready = poller(ScriptedApi(st("preparing"), st("ready"))).awaitReady("remote:t1") { seen += it }
        assertEquals("remote:t1", ready.trackId)
        assertEquals(3, seen.size)

        val err = runCatching {
            poller(ScriptedApi(st("error", error = RemoteError("JOB_TIMEOUT", "slow", true)))).awaitReady("remote:t1")
        }.exceptionOrNull() as RemoteApiException
        assertEquals("JOB_TIMEOUT", err.code)
        assertTrue(err.retryable)
    }
}
