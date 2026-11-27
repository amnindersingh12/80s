package app.simple.felicity.remote

import okhttp3.Interceptor
import okhttp3.Response

/**
 * Adds `Authorization: Bearer <APP_ACCESS_KEY>` to requests for the configured server only.
 *
 * The config is read per request through [config], so editing the key in settings takes
 * effect immediately without rebuilding clients. Requests to any other origin (CDNs,
 * cover hosts, redirects) are left untouched so the key never leaves the user's server.
 */
class AccessKeyInterceptor(private val config: () -> ServerConfig?) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val headers = config()?.authHeadersFor(request.url.toString()).orEmpty()
        if (headers.isEmpty() || request.header(ServerConfig.AUTHORIZATION) != null) return chain.proceed(request)
        val builder = request.newBuilder()
        headers.forEach { (k, v) -> builder.header(k, v) }
        return chain.proceed(builder.build())
    }
}
