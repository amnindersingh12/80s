package app.simple.felicity.remote

import java.io.InterruptedIOException

/**
 * True for failures that look like a sleeping server still booting: a connect/read timeout,
 * or a 502/503 from a platform router (Heroku `H10`/`H20`, Render, Fly) rather than from `web/`
 * itself — those have no JSON error body, so their code is `HTTP_5xx`.
 */
val RemoteApiException.looksLikeColdStart: Boolean
    get() = (code == RemoteApiException.NETWORK && generateSequence(cause) { it.cause }.any { it is InterruptedIOException }) ||
            ((httpStatus == 502 || httpStatus == 503) && code.startsWith("HTTP_"))

/**
 * Runs [block] and, if the first attempt fails like a cold start, calls [onWaking] and tries
 * exactly once more (the dyno is usually up by then). Other errors are rethrown unchanged.
 */
suspend fun <T> withWakeRetry(onWaking: () -> Unit = {}, block: suspend () -> T): T = try {
    block()
} catch (e: RemoteApiException) {
    if (!e.looksLikeColdStart) throw e
    onWaking()
    block()
}
