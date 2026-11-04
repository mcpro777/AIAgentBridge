package com.agentbridge.android.data

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

class BridgeClient(
    private val baseUrl: String,
    private val token: () -> String?
) {
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS)
        .build()
    private val root = baseUrl.trim().trimEnd('/').replaceFirst(
        Regex("^https://", RegexOption.IGNORE_CASE),
        "https://"
    )

    init {
        require(BridgeProtocol.isValidHttpsUrl(baseUrl)) {
            "Server address must be an HTTPS URL with a host and no credentials, query, or fragment"
        }
    }

    fun pair(code: String, deviceName: String): JSONObject =
        request("/api/pair", "POST", JSONObject().put("code", code).put("deviceName", deviceName), authenticated = false)

    fun conversations(): JSONObject = request("/api/conversations")

    fun createConversation(): JSONObject = request("/api/conversations", "POST", JSONObject())

    fun deleteConversation(conversationId: String): JSONObject =
        request("/api/conversations/${path(conversationId)}", method = "DELETE")

    fun events(conversationId: String, after: Long): JSONObject =
        request("/api/conversations/${path(conversationId)}/events?after=$after")

    fun devices(): JSONObject = request("/api/devices")

    fun revokeDevice(deviceId: String): JSONObject =
        request("/api/devices/${path(deviceId)}", method = "DELETE")

    fun summarize(text: String): String {
        val result = request("/api/voice/summary", "POST", JSONObject().put("text", text))
        return result.getString("text").also { check(it.isNotBlank()) { "Host returned an empty spoken summary" } }
    }

    fun transcribe(file: File): String {
        val body = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart(
                "audio",
                "recording.m4a",
                file.asRequestBody("audio/mp4".toMediaType())
            )
            .build()
        val credential = token() ?: error("Not paired")
        val request = Request.Builder()
            .url("$root/api/voice/transcribe")
            .header("Authorization", listOf("Bearer", credential).joinToString(" "))
            .post(body)
            .build()
        http.newCall(request).execute().use { response ->
            check(response.isSuccessful) { "Voice upload failed (${response.code})" }
            return JSONObject(response.body?.string().orEmpty()).optString("text")
        }
    }

    fun openSocket(listener: WebSocketListener): WebSocket =
        http.newWebSocket(
            Request.Builder().url(root.replaceFirst("https://", "wss://") + "/api/ws").build(),
            listener
        )

    private fun request(
        path: String,
        method: String = "GET",
        json: JSONObject? = null,
        authenticated: Boolean = true
    ): JSONObject {
        val builder = Request.Builder().url(root + path).header("Accept", "application/json")
        if (authenticated) {
            val credential = token() ?: error("Not paired")
            builder.header("Authorization", listOf("Bearer", credential).joinToString(" "))
        }
        val body = json?.toString()?.toRequestBody("application/json; charset=utf-8".toMediaType())
        builder.method(method, if (method == "GET") null else body ?: "{}".toRequestBody("application/json".toMediaType()))
        http.newCall(builder.build()).execute().use { response ->
            val responseBody = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                val serverError = runCatching { JSONObject(responseBody).optString("error") }.getOrNull()
                    ?.takeIf { it.isNotBlank() }
                error(serverError ?: "Request failed (${response.code})")
            }
            return JSONObject(responseBody.ifBlank { "{}" })
        }
    }

    private fun path(value: String) = java.net.URLEncoder.encode(value, "UTF-8")
}
