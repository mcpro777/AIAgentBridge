package com.agentbridge.android.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeProtocolTest {
    @Test
    fun messagePacketMatchesHostContract() {
        val packet = BridgeProtocol.message("conversation-1", "hello")
        assertEquals("message.create", packet.getString("type"))
        assertEquals("conversation-1", packet.getString("conversationId"))
        assertEquals("hello", packet.getString("text"))
        assertEquals(3, packet.length())
    }

    @Test
    fun responsePacketsUseExactQuestionAndApprovalFields() {
        val answer = BridgeProtocol.answer("question-2", "yes")
        assertEquals("question.answer", answer.getString("type"))
        assertEquals("question-2", answer.getString("questionId"))
        assertEquals("yes", answer.getString("answer"))

        val approval = BridgeProtocol.approval("approval-3", false)
        assertEquals("approval.respond", approval.getString("type"))
        assertEquals("approval-3", approval.getString("approvalId"))
        assertEquals("deny", approval.getString("decision"))
    }

    @Test
    fun acceptsOnlyHttpsServerUrlsWithoutCredentialsOrQuery() {
        assertTrue(BridgeProtocol.isValidHttpsUrl("https://bridge.lan:8443"))
        assertTrue(BridgeProtocol.isValidHttpsUrl("HTTPS://bridge.example/private/path"))
        assertFalse(BridgeProtocol.isValidHttpsUrl("http://bridge.lan"))
        assertFalse(BridgeProtocol.isValidHttpsUrl("wss://bridge.lan"))
        assertFalse(BridgeProtocol.isValidHttpsUrl("https://user:pass@bridge.lan"))
        assertFalse(BridgeProtocol.isValidHttpsUrl("https://bridge.lan?token=secret"))
        assertFalse(BridgeProtocol.isValidHttpsUrl("https:///missing-host"))
    }

    @Test
    fun callbacksFromSupersededSocketCannotBeTreatedAsCurrent() {
        assertTrue(BridgeProtocol.isCurrentSocketCallback(8, 8, true))
        assertFalse(BridgeProtocol.isCurrentSocketCallback(9, 8, true))
        assertFalse(BridgeProtocol.isCurrentSocketCallback(9, 9, false))
    }

    @Test
    fun eventPagesKeepFlattenedEventFieldsAndPaginationCursor() {
        val flattenedEvent = org.json.JSONObject()
            .put("sequence", 12)
            .put("conversationId", "conversation-1")
            .put("type", "message.delta")
            .put("messageId", "message-2")
            .put("delta", "hello")
        val page = BridgeProtocol.eventPage(
            org.json.JSONObject()
                .put("events", org.json.JSONArray().put(flattenedEvent))
                .put("nextAfter", 12)
                .put("hasMore", true)
        )

        assertTrue(page.hasMore)
        assertEquals(12L, page.nextAfter)
        assertEquals("conversation-1", BridgeProtocol.eventConversationId(page.events.single()))
        assertEquals(12L, BridgeProtocol.eventSequence(page.events.single()))
        assertEquals("message.delta", BridgeProtocol.eventType(page.events.single()))
        assertEquals("hello", page.events.single().getString("delta"))
        assertNull(page.events.single().optJSONObject("event"))
        assertNull(BridgeProtocol.eventConversationId(org.json.JSONObject().put("sequence", 13)))
        assertEquals(12L, BridgeProtocol.nextReplayCursor(0, page))

        val lastPage = BridgeProtocol.eventPage(
            org.json.JSONObject()
                .put("events", org.json.JSONArray())
                .put("nextAfter", 12)
                .put("hasMore", false)
        )
        assertNull(BridgeProtocol.nextReplayCursor(12, lastPage))
        assertEquals("device-2", BridgeProtocol.deviceId(org.json.JSONObject().put("id", "device-2")))
    }

    @Test
    fun deviceParserSupportsHostDeviceNameAndIdFields() {
        val device = org.json.JSONObject()
            .put("deviceId", "device-1")
            .put("deviceName", "My phone")
            .put("lastUsedAt", "today")

        assertEquals("device-1", BridgeProtocol.deviceId(device))
        assertEquals("My phone", BridgeProtocol.deviceName(device))
        assertFalse(BridgeProtocol.deviceId(org.json.JSONObject().put("id", "device-2")).isBlank())
    }

    @Test(expected = IllegalArgumentException::class)
    fun replayRejectsNonAdvancingCursorWhenMorePagesRemain() {
        BridgeProtocol.nextReplayCursor(
            12,
            BridgeProtocol.EventPage(emptyList(), nextAfter = 12, hasMore = true)
        )
    }
}
