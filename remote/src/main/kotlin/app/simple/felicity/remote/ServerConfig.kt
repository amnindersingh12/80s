package app.simple.felicity.remote

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** Thrown when the user-entered server address cannot be used. */
class InvalidServerUrlException(message: String) : IllegalArgumentException(message)

/**
 * Where the `web/` server lives and how to authenticate against it.
 *
 * Nothing here is hard-coded: both values come from the user's settings. The access key
 * (the server's `APP_ACCESS_KEY`) is only ever attached to requests that go to this exact
 * origin, so it can never leak to a CDN, a cover-art host or any other server.
 */
class ServerConfig private constructor(
        /** Normalised base URL, always ending in `/` (may include a reverse-proxy sub-path). */
        val baseUrl: HttpUrl,
        val accessKey: String?,
) {

    val hasAccessKey: Boolean get() = !accessKey.isNullOrBlank()

    /** `https://host:port/sub/path/api/<segments...>` with each segment percent-encoded. */
    fun api(vararg segments: String): HttpUrl.Builder {
        val builder = baseUrl.newBuilder().addPathSegment("api")
        for (segment in segments) builder.addPathSegment(segment)
        return builder
    }

    /**
     * Resolves a URL the server returned. Absolute `http(s)` URLs (CDN covers) are kept,
     * root-relative paths such as `/api/cover/…` or `/__mock/cover/…` are resolved against
     * the server origin while keeping any reverse-proxy prefix in [baseUrl].
     */
    fun resolve(pathOrUrl: String?): HttpUrl? {
        if (pathOrUrl.isNullOrBlank()) return null
        pathOrUrl.toHttpUrlOrNull()?.let { return it }
        val relative = pathOrUrl.trim().removePrefix("/")
        return baseUrl.resolve(relative)
    }

    fun isSameOrigin(url: HttpUrl): Boolean =
        url.scheme == baseUrl.scheme && url.host.equals(baseUrl.host, ignoreCase = true) && url.port == baseUrl.port

    fun isSameOrigin(url: String): Boolean = url.toHttpUrlOrNull()?.let(::isSameOrigin) ?: false

    /**
     * Headers `web/` expects for gated requests (`Authorization: Bearer <APP_ACCESS_KEY>`).
     * Empty for other origins or when no key is configured.
     */
    fun authHeadersFor(url: String): Map<String, String> =
        if (hasAccessKey && isSameOrigin(url)) mapOf(AUTHORIZATION to "Bearer ${accessKey!!.trim()}") else emptyMap()

    override fun equals(other: Any?): Boolean =
        other is ServerConfig && other.baseUrl == baseUrl && other.accessKey == accessKey

    override fun hashCode(): Int = baseUrl.hashCode() * 31 + (accessKey?.hashCode() ?: 0)

    /** Never prints the access key. */
    override fun toString(): String = "ServerConfig(baseUrl=$baseUrl, accessKey=${if (hasAccessKey) "***" else "none"})"

    companion object {
        const val AUTHORIZATION = "Authorization"

        /**
         * Builds a config from raw settings. Returns `null` when no server is configured
         * (blank URL), which is the signal for the app to behave exactly as before.
         *
         * @throws InvalidServerUrlException when a URL is present but unusable.
         */
        fun from(rawUrl: String?, accessKey: String?): ServerConfig? {
            if (rawUrl.isNullOrBlank()) return null
            return ServerConfig(normalizeBaseUrl(rawUrl), accessKey?.trim()?.takeIf { it.isNotEmpty() })
        }

        /** Like [from] but returns `null` instead of throwing for invalid URLs. */
        fun fromOrNull(rawUrl: String?, accessKey: String?): ServerConfig? =
            runCatching { from(rawUrl, accessKey) }.getOrNull()

        /**
         * Accepts what people actually type: `music.example.com`, `192.168.1.20:8787`,
         * `https://example.com/80s/`, or a URL copied with a trailing `/api`.
         * LAN / localhost addresses without a scheme default to `http`, everything else to `https`.
         */
        fun normalizeBaseUrl(raw: String): HttpUrl {
            val trimmed = raw.trim()
            if (trimmed.isEmpty()) throw InvalidServerUrlException("Enter the server address")
            if (trimmed.any { it.isWhitespace() }) throw InvalidServerUrlException("The address must not contain spaces")

            val withScheme = when {
                trimmed.startsWith("http://", true) || trimmed.startsWith("https://", true) -> trimmed
                "://" in trimmed -> throw InvalidServerUrlException("Only http:// and https:// addresses are supported")
                looksLocal(trimmed) -> "http://$trimmed"
                else -> "https://$trimmed"
            }
            val parsed = withScheme.toHttpUrlOrNull() ?: throw InvalidServerUrlException("“$raw” is not a valid address")
            if (parsed.host.isBlank()) throw InvalidServerUrlException("The address has no host name")
            if (parsed.username.isNotEmpty() || parsed.password.isNotEmpty()) {
                throw InvalidServerUrlException("Put the access key in its own field, not in the address")
            }

            // Drop query/fragment, trailing slashes and a trailing "/api" so both
            // "https://host/80s" and "https://host/80s/api/" mean the same server.
            val segments = parsed.pathSegments.filter { it.isNotEmpty() }.toMutableList()
            if (segments.lastOrNull().equals("api", ignoreCase = true)) segments.removeAt(segments.lastIndex)

            val builder = parsed.newBuilder().query(null).fragment(null).encodedPath("/")
            segments.forEach { builder.addPathSegment(it) }
            if (segments.isNotEmpty()) builder.addPathSegment("") // keep a trailing slash for resolve()
            return builder.build()
        }

        private val PRIVATE_V4 = Regex("""^(10|127)\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^169\.254\.""")

        private fun looksLocal(hostAndMore: String): Boolean {
            val host = hostAndMore.substringBefore('/').substringBefore('?').let {
                if (it.startsWith("[")) it.substringBefore(']') + "]" else it.substringBefore(':')
            }.lowercase()
            return host == "localhost" || host.endsWith(".local") || host.endsWith(".lan") ||
                    host.startsWith("[") || PRIVATE_V4.containsMatchIn(host) || !host.contains('.')
        }
    }
}
