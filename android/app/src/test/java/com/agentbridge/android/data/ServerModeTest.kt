package com.agentbridge.android.data

import org.junit.Assert.*
import org.junit.Test

class ServerModeTest {
    @Test fun retainsExistingLiveAndApiProfiles() {
        assertEquals(ServerMode.LIVE, ServerMode.legacyMode("https://192.168.1.18:8444"))
        assertEquals(ServerMode.COPILOT, ServerMode.legacyMode("https://192.168.1.18:8443/"))
        assertEquals(ServerMode.LIVE, ServerMode.legacyMode(""))
        assertNotEquals(ServerMode.LIVE.key, ServerMode.COPILOT.key)
        for (mode in ServerMode.entries) assertEquals(mode, ServerMode.fromKey(mode.key))
        assertEquals(ServerMode.LIVE, ServerMode.fromKey(null))
    }
}
