package app.simple.felicity.remote

import java.io.IOException

/**
 * Every failure of the remote API surfaces as this exception, carrying the server's
 * error `code` (e.g. `JOB_TIMEOUT`, `UPSTREAM_UNAVAILABLE`, `ACCESS_REQUIRED`) or one of the
 * client-side codes below.
 */
class RemoteApiException(
        val httpStatus: Int,
        val code: String,
        override val message: String,
        val retryable: Boolean,
        cause: Throwable? = null,
) : IOException(message, cause) {

    val isAccessDenied: Boolean get() = code == ACCESS_REQUIRED || httpStatus == 401

    companion object {
        const val NETWORK = "NETWORK"
        const val NOT_CONFIGURED = "NOT_CONFIGURED"
        const val BAD_RESPONSE = "BAD_RESPONSE"
        const val ACCESS_REQUIRED = "ACCESS_REQUIRED"
        const val TIMEOUT = "PREPARE_TIMEOUT"

        fun notConfigured() = RemoteApiException(0, NOT_CONFIGURED, "No streaming server is configured", false)
    }
}
