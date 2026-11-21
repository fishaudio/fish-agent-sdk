package com.fishaudio.agent.internal

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

internal class HttpResponse(val status: Int, val body: String)

/** The one HTTP call the SDK makes: creating a session for a public agent. A seam for tests. */
internal fun interface HttpClient {
    /** @throws IOException when no response arrives. */
    suspend fun post(url: String, headers: Map<String, String>, body: String): HttpResponse
}

/** `HttpURLConnection`, so the SDK adds no HTTP library to the app. */
internal class UrlConnectionHttpClient(
    private val connectTimeoutMs: Int = 15_000,
    private val readTimeoutMs: Int = 30_000,
) : HttpClient {
    override suspend fun post(url: String, headers: Map<String, String>, body: String): HttpResponse =
        withContext(Dispatchers.IO) {
            val connection = URL(url).openConnection() as HttpURLConnection
            try {
                connection.requestMethod = "POST"
                connection.connectTimeout = connectTimeoutMs
                connection.readTimeout = readTimeoutMs
                connection.doOutput = true
                for ((name, value) in headers) connection.setRequestProperty(name, value)
                connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                val status = connection.responseCode
                val stream = if (status in 200..299) connection.inputStream else connection.errorStream
                HttpResponse(status, stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty())
            } finally {
                connection.disconnect()
            }
        }
}
