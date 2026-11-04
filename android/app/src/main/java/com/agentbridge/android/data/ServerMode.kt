package com.agentbridge.android.data

enum class ServerMode(val key: String, val label: String) {
    LIVE("live", "Live VS Code"),
    COPILOT("copilot", "Copilot API");

    companion object {
        fun fromKey(key: String?) = entries.firstOrNull { it.key == key } ?: LIVE
        fun legacyMode(url: String) =
            if (url.trimEnd('/').endsWith(":8443")) COPILOT else LIVE
    }
}
