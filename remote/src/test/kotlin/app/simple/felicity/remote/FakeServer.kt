package app.simple.felicity.remote

import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import java.io.IOException

/** In-process fake of the web/ server: the last interceptor answers instead of the network. */
class FakeServer : Interceptor {
    data class Recorded(val request: Request, val body: String?)

    val requests = mutableListOf<Recorded>()
    private val routes = mutableListOf<Pair<(Request) -> Boolean, (Request) -> Response>>()

    fun on(method: String, pathPrefix: String, respond: (Request) -> Response) {
        routes += ({ r: Request -> r.method == method && r.url.encodedPath.startsWith(pathPrefix) }) to respond
    }

    override fun intercept(chain: Interceptor.Chain): Response {
        val req = chain.request()
        val body = req.body?.let { b -> Buffer().also { b.writeTo(it) }.readUtf8() }
        requests += Recorded(req, body)
        val route = routes.lastOrNull { it.first(req) } ?: return json(req, 404, """{"error":{"code":"NOT_FOUND","message":"no route"}}""")
        return route.second(req)
    }

    fun client(): OkHttpClient = OkHttpClient.Builder().addInterceptor(this).build()

    companion object {
        fun json(req: Request, code: Int, body: String, headers: Map<String, String> = emptyMap()): Response =
            Response.Builder().request(req).protocol(Protocol.HTTP_1_1).code(code).message("x")
                .apply { headers.forEach { (k, v) -> header(k, v) } }
                .body(body.toResponseBody("application/json".toMediaType()))
                .build()

        fun bytes(req: Request, code: Int, bytes: ByteArray, headers: Map<String, String>): Response =
            Response.Builder().request(req).protocol(Protocol.HTTP_1_1).code(code).message("x")
                .apply { headers.forEach { (k, v) -> header(k, v) } }
                .body(bytes.toResponseBody((headers["content-type"] ?: "application/octet-stream").toMediaType()))
                .build()

        fun fail(): Response = throw IOException("connect failed: ECONNREFUSED")
    }
}
