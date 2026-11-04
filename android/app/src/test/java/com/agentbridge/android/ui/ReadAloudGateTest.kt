package com.agentbridge.android.ui

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ReadAloudGateTest {
    private fun response(id: String = "chat", sequence: Long = 1) = JSONObject()
        .put("conversationId", id).put("sequence", sequence)
        .put("type", "message.completed").put("text", "Full detailed response. Warning: check the door.")

    @Test fun onlyNewCompletedRepliesInTheSelectedForegroundChatAreAccepted() {
        val gate = ReadAloudGate()
        val packet = response()
        assertNull(gate.accept(packet, false, true, "chat"))
        assertNull(gate.accept(packet, true, false, "chat"))
        assertNull(gate.accept(packet, true, true, "other"))
        assertNull(gate.accept(packet, true, true, null))
        assertEquals(packet.getString("text"), gate.accept(packet, true, true, "chat"))
        assertNull(gate.accept(packet, true, true, "chat"))
    }

    @Test fun ignoresDeltasEmptyResponsesAndMissingIdentities() {
        val gate = ReadAloudGate()
        assertNull(gate.accept(response().put("type", "message.delta"), true, true, "chat"))
        assertNull(gate.accept(response().put("text", "  "), true, true, "chat"))
        assertNull(gate.accept(response().also { it.remove("sequence") }, true, true, "chat"))
        assertNotNull(gate.accept(response(), true, true, "chat"))
    }

    @Test fun separateConversationsAndProfilesDoNotShareSpeechIdentities() {
        val gate = ReadAloudGate()
        assertNotNull(gate.accept(response(), true, true, "chat"))
        assertNotNull(gate.accept(response("other"), true, true, "other"))
        gate.clear()
        assertNotNull(gate.accept(response(), true, true, "chat"))
    }
}
