package app.simple.felicity.remote

import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.last
import kotlinx.coroutines.flow.onEach

/** What the UI shows while a remote track is being made streamable. */
sealed interface PrepareState {
    val trackId: String

    data class Starting(override val trackId: String) : PrepareState

    data class Preparing(
            override val trackId: String,
            /** Upstream stage, e.g. `queued`, `packaging`, `uploading`. */
            val stage: String?,
            /** 0..1 when the server reports it. */
            val progress: Float?,
            val elapsedMs: Long,
    ) : PrepareState

    data class Ready(override val trackId: String, val servedBy: String?, val fallback: Boolean) : PrepareState

    data class Failed(
            override val trackId: String,
            val code: String,
            val message: String,
            val retryable: Boolean,
    ) : PrepareState

    val isTerminal: Boolean get() = this is Ready || this is Failed
}

data class PollPolicy(
        val initialDelayMs: Long = 600,
        val backoffFactor: Double = 1.35,
        val maxDelayMs: Long = 2_000,
        /** Client-side cap; the server itself gives up after MEDIA_JOB_MAX_WAIT_MS (45 s). */
        val maxWaitMs: Long = 90_000,
        /** Transient network errors tolerated in a row while polling. */
        val maxConsecutiveErrors: Int = 3,
)

/**
 * State machine for `/api/tracks/:id/prepare`:
 *
 * ```
 * Starting ─POST─▶ 200 ready ───────────────────────────▶ Ready
 *                  202 preparing ─▶ Preparing ─(backoff)─GET─┬▶ Ready
 *                                       ▲                    ├▶ Failed (job error / 5xx status body)
 *                                       └── preparing ───────┤
 *                  idle (server restarted) ─POST again       └▶ Failed (timeout / repeated network errors)
 * ```
 */
class PreparePoller(
        private val api: PrepareApi,
        private val policy: PollPolicy = PollPolicy(),
        private val clock: () -> Long = System::currentTimeMillis,
) {

    fun prepare(trackId: String): Flow<PrepareState> = flow {
        emit(PrepareState.Starting(trackId))
        val startedAt = clock()
        val elapsed = { clock() - startedAt }

        var status = try {
            api.prepare(trackId)
        } catch (e: RemoteApiException) {
            emit(PrepareState.Failed(trackId, e.code, e.message, e.retryable))
            return@flow
        }

        var wait = policy.initialDelayMs
        var errors = 0
        while (true) {
            when (status.state) {
                "ready" -> {
                    emit(PrepareState.Ready(trackId, status.servedBy, status.fallback))
                    return@flow
                }
                "error" -> {
                    val e = status.error
                    emit(PrepareState.Failed(trackId, e?.code ?: "JOB_FAILED", e?.message ?: "The server could not prepare this track", e?.retryable ?: true))
                    return@flow
                }
                else -> emit(PrepareState.Preparing(trackId, status.stage, status.progress, status.elapsedMs ?: elapsed()))
            }

            if (elapsed() >= policy.maxWaitMs) {
                emit(PrepareState.Failed(trackId, RemoteApiException.TIMEOUT, "Still preparing after ${policy.maxWaitMs / 1000} s — try again shortly", true))
                return@flow
            }

            delay(wait)
            wait = (wait * policy.backoffFactor).toLong().coerceAtMost(policy.maxDelayMs)

            status = try {
                // "idle" means the server forgot the job (e.g. restarted): kick it again.
                val next = if (status.state == "idle") api.prepare(trackId) else api.prepareStatus(trackId)
                errors = 0
                next
            } catch (e: RemoteApiException) {
                errors++
                if (!e.retryable || errors >= policy.maxConsecutiveErrors) {
                    emit(PrepareState.Failed(trackId, e.code, e.message, e.retryable))
                    return@flow
                }
                status // keep polling from the last known state
            }
        }
    }

    /** Suspends until ready; reports intermediate states; throws on failure. */
    suspend fun awaitReady(trackId: String, onState: (PrepareState) -> Unit = {}): PrepareState.Ready {
        return when (val last = prepare(trackId).onEach(onState).last()) {
            is PrepareState.Ready -> last
            is PrepareState.Failed -> throw RemoteApiException(0, last.code, last.message, last.retryable)
            else -> throw IllegalStateException("prepare flow ended in $last")
        }
    }
}
