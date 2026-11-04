package com.agentbridge.android.ui

import com.agentbridge.android.data.EventRow
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class ConversationTimelineTest {
    @Test
    fun combinesStreamingDeltasWithTheCompletedAssistantMessage() {
        val timeline = buildConversationTimeline(
            listOf(
                event(1, "message.user", """{"text":"Turn on the office light"}"""),
                event(2, "message.delta", """{"messageId":"m1","delta":"The office "}"""),
                event(3, "message.delta", """{"messageId":"m1","delta":"light is on."}"""),
                event(4, "message.completed", """{"messageId":"m1","text":"The office light is on."}""")
            )
        )

        assertEquals(2, timeline.size)
        val user = timeline[0] as TimelineItem.Message
        assertEquals("You", user.role)
        assertEquals("Turn on the office light", user.content)
        val assistant = timeline[1] as TimelineItem.Message
        assertEquals("The office light is on.", assistant.content)
        assertFalse(assistant.streaming)
    }

    @Test
    fun collapsesToolStartAndCompletionAndOmitsUnknownProtocolEvents() {
        val timeline = buildConversationTimeline(
            listOf(
                event(1, "tool.status", """{"toolCallId":"t1","toolName":"ha_get_states","status":"started","summary":"{}"}"""),
                event(2, "tool.status", """{"toolCallId":"t1","toolName":"ha_get_states","status":"completed","summary":"Completed"}"""),
                event(3, "conversation.created", """{"title":"New conversation"}""")
            )
        )

        assertEquals(1, timeline.size)
        val tool = timeline.single() as TimelineItem.Tool
        assertEquals("ha_get_states", tool.toolName)
        assertEquals("completed", tool.status)
        assertEquals("Completed", tool.summary)
        assertEquals("tool:t1", tool.key)
    }

    private fun event(sequence: Long, type: String, payload: String) = EventRow(
        conversationId = "conversation-id",
        sequence = sequence,
        type = type,
        payload = JSONObject(payload).toString()
    )
}
