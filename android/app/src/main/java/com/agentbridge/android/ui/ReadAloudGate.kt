package com.agentbridge.android.ui

import org.json.JSONObject

class ReadAloudGate {
    private val seen = mutableSetOf<String>()

    fun accept(packet: JSONObject, live: Boolean, enabled: Boolean, selectedId: String?): String? {
        if (!live || !enabled || selectedId == null ||
            packet.optString("type") != "message.completed" ||
            packet.optString("conversationId") != selectedId) return null
        val text = packet.optString("text").trim()
        val sequence = packet.optLong("sequence", -1)
        if (text.isEmpty() || sequence < 0) return null
        return text.takeIf { seen.add("$selectedId:$sequence") }
    }

    fun clear() = seen.clear()
}
