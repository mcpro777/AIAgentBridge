package com.agentbridge.android.data

import org.json.JSONObject
import java.net.URI

object BridgeProtocol {
    data class EventPage(
        val events: List<JSONObject>,
        val nextAfter: Long,
        val hasMore: Boolean
    )

    fun isValidHttpsUrl(value: String): Boolean {
        val uri = runCatching { URI(value.trim()) }.getOrNull() ?: return false
        return uri.isAbsolute &&
            uri.scheme.equals("https", ignoreCase = true) &&
            !uri.host.isNullOrBlank() &&
            uri.rawUserInfo == null &&
            uri.rawQuery == null &&
            uri.rawFragment == null
    }

    fun isCurrentSocketCallback(
        activeGeneration: Long,
        callbackGeneration: Long,
        isActiveSocket: Boolean
    ): Boolean = activeGeneration == callbackGeneration && isActiveSocket

    fun eventPage(response: JSONObject): EventPage {
        val array = response.getJSONArray("events")
        val events = (0 until array.length()).map { array.getJSONObject(it) }
        return EventPage(
            events = events,
            nextAfter = response.getLong("nextAfter"),
            hasMore = response.getBoolean("hasMore")
        )
    }

    fun nextReplayCursor(after: Long, page: EventPage): Long? {
        if (!page.hasMore) return null
        require(page.nextAfter > after) { "Event replay cursor did not advance" }
        return page.nextAfter
    }

    fun eventConversationId(event: JSONObject): String? =
        event.optString("conversationId").takeIf { it.isNotBlank() }

    fun eventSequence(event: JSONObject): Long? =
        event.optLong("sequence", -1).takeIf { it >= 0 }

    fun eventType(event: JSONObject): String = event.optString("type", "unknown")

    fun deviceId(device: JSONObject): String =
        device.optString("id").ifBlank { device.optString("deviceId") }

    fun deviceName(device: JSONObject): String =
        device.optString("name").ifBlank { device.optString("deviceName").ifBlank { "Android device" } }

    fun auth(token: String) = JSONObject()
        .put("type", "auth")
        .put("token", token)

    fun message(conversationId: String, text: String) = JSONObject()
        .put("type", "message.create")
        .put("conversationId", conversationId)
        .put("text", text)

    fun answer(questionId: String, answer: String) = JSONObject()
        .put("type", "question.answer")
        .put("questionId", questionId)
        .put("answer", answer)

    fun approval(approvalId: String, approve: Boolean) = JSONObject()
        .put("type", "approval.respond")
        .put("approvalId", approvalId)
        .put("decision", if (approve) "approve" else "deny")
}
