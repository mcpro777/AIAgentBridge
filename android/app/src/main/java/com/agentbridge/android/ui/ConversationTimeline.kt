package com.agentbridge.android.ui

import com.agentbridge.android.data.EventRow
import org.json.JSONObject

sealed interface TimelineItem {
    val key: String

    data class Message(
        override val key: String,
        val role: String,
        val content: String,
        val streaming: Boolean
    ) : TimelineItem

    data class Tool(
        override val key: String,
        val toolName: String,
        val status: String,
        val summary: String
    ) : TimelineItem

    data class Server(
        override val key: String,
        val type: String,
        val packet: JSONObject
    ) : TimelineItem
}

fun buildConversationTimeline(events: List<EventRow>): List<TimelineItem> {
    val result = mutableListOf<TimelineItem>()
    val assistantPositions = mutableMapOf<String, Int>()
    val toolPositions = mutableMapOf<String, Int>()

    for (event in events) {
        val packet = runCatching { JSONObject(event.payload) }.getOrElse { JSONObject() }
        when (event.type) {
            "message.user" -> {
                val text = packet.optString("text")
                if (text.isNotBlank()) {
                    result += TimelineItem.Message("user:${event.sequence}", "You", text, false)
                }
            }
            "message.delta" -> {
                val messageId = packet.optString("messageId").ifBlank { "sequence-${event.sequence}" }
                val delta = packet.optString("delta")
                val position = assistantPositions[messageId]
                if (position == null) {
                    assistantPositions[messageId] = result.size
                    result += TimelineItem.Message("assistant:$messageId", "Mcpro ai bridge", delta, true)
                } else {
                    val previous = result[position] as TimelineItem.Message
                    result[position] = previous.copy(content = previous.content + delta, streaming = true)
                }
            }
            "message.completed" -> {
                val messageId = packet.optString("messageId").ifBlank { "sequence-${event.sequence}" }
                val content = packet.optString("text")
                val position = assistantPositions[messageId]
                if (position == null) {
                    if (content.isNotBlank()) {
                        assistantPositions[messageId] = result.size
                        result += TimelineItem.Message("assistant:$messageId", "Mcpro ai bridge", content, false)
                    }
                } else {
                    val previous = result[position] as TimelineItem.Message
                    result[position] = previous.copy(
                        content = content.ifBlank { previous.content },
                        streaming = false
                    )
                }
            }
            "tool.status" -> {
                val toolCallId = packet.optString("toolCallId").ifBlank { "sequence-${event.sequence}" }
                val item = TimelineItem.Tool(
                    key = "tool:$toolCallId",
                    toolName = packet.optString("toolName", "Tool"),
                    status = packet.optString("status"),
                    summary = packet.opt("summary")?.toString()?.takeIf { it != "null" }.orEmpty()
                )
                val position = toolPositions[toolCallId]
                if (position == null) {
                    toolPositions[toolCallId] = result.size
                    result += item
                } else {
                    result[position] = item
                }
            }
            "question.asked", "question.answered", "question.expired",
            "approval.requested", "approval.completed", "error" -> {
                result += TimelineItem.Server("${event.type}:${event.sequence}", event.type, packet)
            }
        }
    }
    return result
}
