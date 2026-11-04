package com.agentbridge.android.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.agentbridge.android.data.BridgeRepository
import com.agentbridge.android.data.ConversationRow
import com.agentbridge.android.data.EventRow
import com.agentbridge.android.data.PairedDevice
import com.agentbridge.android.data.BridgeProtocol
import com.agentbridge.android.data.ServerMode
import com.agentbridge.android.security.DeviceTokenStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File

class BridgeViewModel(application: Application) : AndroidViewModel(application) {
    private val _state = MutableStateFlow(BridgeState())
    val state: StateFlow<BridgeState> = _state.asStateFlow()
    private var eventCollection: kotlinx.coroutines.Job? = null
    private val preferences = application.getSharedPreferences("server", 0)
    private var mode = ServerMode.fromKey(preferences.getString("mode", null))
    private var generation = 0
    private var profileScope = newProfileScope()
    private var currentUrl = ""
    private lateinit var repository: BridgeRepository
    private val _speech = MutableSharedFlow<String>()
    val speech = _speech.asSharedFlow()
    private var summaryJob: Job? = null
    private val readAloudGate = ReadAloudGate()
    private var foreground = false

    private inline fun <T> runCatching(block: () -> T): Result<T> = try {
        Result.success(block())
    } catch (error: kotlinx.coroutines.CancellationException) {
        throw error
    } catch (error: Exception) {
        Result.failure(error)
    }

    init {
        migrateLegacyProfile()
        openProfile()
    }

    private fun newProfileScope() = CoroutineScope(
        viewModelScope.coroutineContext + SupervisorJob(viewModelScope.coroutineContext[Job])
    )

    private fun migrateLegacyProfile() {
        if (preferences.contains("legacy_mode")) return
        val url = preferences.getString("url", "").orEmpty()
        val initial = ServerMode.legacyMode(url)
        val legacy = DeviceTokenStore(getApplication())
        val token = legacy.read()
        val id = legacy.readDeviceId()
        if (token != null && id != null) {
            DeviceTokenStore(getApplication(), initial.key).save(token, id)
        }
        check(preferences.edit().putString("legacy_mode", initial.key).putString("mode", initial.key)
            .putString("url_${initial.key}", url).commit()) { "Could not migrate the saved server profile." }
        legacy.revokeLocally()
        mode = initial
    }

    private fun openProfile() {
        val thisGeneration = ++generation
        currentUrl = preferences.getString("url_${mode.key}", "").orEmpty()
        val databaseName = if (preferences.getString("legacy_mode", null) == mode.key)
            "agentbridge.db" else "agentbridge-${mode.key}.db"
        repository = BridgeRepository(getApplication(), mode.key, databaseName,
            { packet, live -> viewModelScope.launch { if (generation == thisGeneration) onEvent(packet, live) } },
            { connected, message -> viewModelScope.launch { if (generation == thisGeneration) onConnection(connected, message) } }
        )
        _state.value = BridgeState(
            mode = mode,
            liveRead = preferences.getBoolean("live_read", false),
            serverUrl = currentUrl,
            paired = repository.paired(),
            localDeviceId = repository.localDeviceId()
        )
        if (currentUrl.isNotBlank()) repository.configure(currentUrl)
        profileScope.launch {
            repository.conversations.collectLatest { rows ->
                val selectedId = _state.value.selectedId
                _state.value = _state.value.copy(conversations = rows)
                if (selectedId != null && rows.none { it.id == selectedId }) {
                    eventCollection?.cancel()
                    _state.value = _state.value.copy(selectedId = null, events = emptyList())
                }
                if (_state.value.selectedId == null && rows.isNotEmpty()) {
                    val preferred = preferences.getString("selected_${mode.key}", null)
                    select(rows.firstOrNull { it.id == preferred }?.id ?: rows.first().id)
                }
            }
        }
        refresh()
    }

    fun switchMode(next: ServerMode) {
        if (next == mode) return
        stopReading()
        profileScope.cancel()
        eventCollection?.cancel()
        repository.close()
        profileScope = newProfileScope()
        mode = next
        preferences.edit().putString("mode", mode.key).apply()
        readAloudGate.clear()
        openProfile()
    }

    fun setLiveRead(enabled: Boolean) {
        preferences.edit().putBoolean("live_read", enabled).apply()
        _state.value = _state.value.copy(liveRead = enabled)
        if (!enabled) stopReading()
    }

    fun stopReading() {
        summaryJob?.cancel()
        summaryJob = null
        _state.value = _state.value.copy(summarizing = false)
    }

    fun setForeground(active: Boolean) {
        foreground = active
        if (!active) stopReading()
    }

    fun setServer(url: String): Boolean {
        if (!BridgeProtocol.isValidHttpsUrl(url)) {
            _state.value = _state.value.copy(error = "Enter a valid HTTPS server URL (no credentials, query, or fragment).")
            return false
        }
        val nextUrl = url.trim().trimEnd('/')
        if (nextUrl == currentUrl) return true
        if (_state.value.paired) {
            showError("Unpair this mode before changing its server address. The other mode's pairing is kept.")
            return false
        }
        currentUrl = nextUrl
        preferences.edit().putString("url_${mode.key}", currentUrl).apply()
        _state.value = _state.value.copy(serverUrl = currentUrl, error = null)
        repository.configure(currentUrl)
        return true
    }

    fun pair(code: String) {
        val url = currentUrl
        if (!BridgeProtocol.isValidHttpsUrl(url)) {
            _state.value = _state.value.copy(error = "Use an HTTPS server address on your private LAN or VPN.")
            return
        }
        _state.value = _state.value.copy(busy = true, error = null)
        profileScope.launch {
            val result = runCatching {
                repository.pair(url, code.trim(), android.os.Build.MODEL ?: "Android phone")
            }
            result.onSuccess {
                _state.value = _state.value.copy(paired = true, busy = false, pairingCode = "")
                _state.value = _state.value.copy(localDeviceId = repository.localDeviceId())
                runCatching { repository.refreshConversations() }
                    .onFailure { error -> _state.value = _state.value.copy(error = error.message ?: "Could not load conversations") }
            }.onFailure {
                _state.value = _state.value.copy(busy = false, error = it.message ?: "Pairing failed")
            }
        }
    }

    fun refresh() {
        if (!_state.value.paired) return
        profileScope.launch {
            runCatching { repository.refreshConversations() }
                .onFailure { _state.value = _state.value.copy(error = it.message) }
        }
    }

    fun refreshDevices() {
        if (!_state.value.paired) return
        profileScope.launch {
            runCatching { repository.pairedDevices() }
                .onSuccess { _state.value = _state.value.copy(devices = it, error = null) }
                .onFailure { _state.value = _state.value.copy(error = it.message ?: "Could not load paired devices") }
        }
    }

    fun revokeDevice(deviceId: String) {
        val revokingLocalDevice = deviceId == _state.value.localDeviceId
        profileScope.launch {
            runCatching { repository.revokeDevice(deviceId) }
                .onSuccess {
                    _state.value = _state.value.copy(devices = _state.value.devices.filterNot { device -> device.id == deviceId })
                    if (revokingLocalDevice) {
                        _state.value = _state.value.copy(
                            paired = false,
                            localDeviceId = null,
                            devices = emptyList(),
                            conversations = emptyList(),
                            events = emptyList(),
                            selectedId = null
                        )
                    }
                }
                .onFailure { _state.value = _state.value.copy(error = it.message ?: "Could not revoke device") }
        }
    }

    fun createConversation() {
        profileScope.launch {
            runCatching { repository.createConversation() }
                .onSuccess(::select)
                .onFailure { _state.value = _state.value.copy(error = it.message) }
        }
    }

    fun deleteConversation(id: String) {
        profileScope.launch {
            runCatching { repository.deleteConversation(id) }
                .onSuccess {
                    if (_state.value.selectedId == id) {
                        eventCollection?.cancel()
                        val nextId = _state.value.conversations.firstOrNull { it.id != id }?.id
                        _state.value = _state.value.copy(selectedId = null, events = emptyList())
                        if (nextId != null) select(nextId)
                    }
                }
                .onFailure {
                    _state.value = _state.value.copy(error = it.message ?: "Could not delete conversation.")
                }
        }
    }

    fun select(id: String) {
        eventCollection?.cancel()
        stopReading()
        preferences.edit().putString("selected_${mode.key}", id).apply()
        _state.value = _state.value.copy(selectedId = id, events = emptyList())
        eventCollection = profileScope.launch {
            repository.observeEvents(id).collectLatest { events ->
                _state.value = _state.value.copy(events = events)
            }
        }
    }

    fun send(text: String): Boolean {
        val id = _state.value.selectedId ?: return false
        if (text.isBlank()) return false
        if (!_state.value.connected) {
            showError("Not connected. Your message has not been sent.")
            return false
        }
        val sent = repository.sendMessage(id, text.trim())
        if (!sent) showError("Connection lost. Your message has not been sent.")
        return sent
    }

    fun answer(questionId: String, answer: String) = repository.answer(questionId, answer)
    fun respond(approvalId: String, approve: Boolean) = repository.respond(approvalId, approve)

    fun transcribe(file: File, onResult: (String) -> Unit) {
        profileScope.launch {
            _state.value = _state.value.copy(transcribing = true)
            try {
                runCatching { repository.transcribe(file) }
                    .onSuccess(onResult)
                    .onFailure { _state.value = _state.value.copy(error = it.message ?: "Voice upload failed") }
            } finally {
                file.delete()
                _state.value = _state.value.copy(transcribing = false)
            }
        }
    }

    fun revoke() {
        stopReading()
        repository.revoke()
        _state.value = _state.value.copy(
            paired = false,
            localDeviceId = null,
            devices = emptyList(),
            conversations = emptyList(),
            events = emptyList(),
            selectedId = null
        )
    }

    fun dismissError() {
        _state.value = _state.value.copy(error = null)
    }

    fun showError(message: String) {
        _state.value = _state.value.copy(error = message)
    }

    private fun onConnection(connected: Boolean, message: String?) {
        _state.value = _state.value.copy(connected = connected, connectionMessage = message)
    }

    private fun onEvent(packet: JSONObject, live: Boolean) {
        _state.value = _state.value.copy(lastEvent = packet.optString("type", "unknown"))
        if (packet.optString("type") == "conversation.created") refresh()
        val text = readAloudGate.accept(packet, live, foreground && _state.value.liveRead, _state.value.selectedId)
        if (text != null) {
            summaryJob?.cancel()
            summaryJob = profileScope.launch {
            _state.value = _state.value.copy(summarizing = true)
            try {
                val summary = repository.summarize(text)
                if (_state.value.liveRead && foreground) _speech.emit(summary)
            } catch (error: kotlinx.coroutines.CancellationException) {
                throw error
            } catch (error: Exception) {
                showError("Could not read the response aloud: ${error.message}")
            } finally {
                _state.value = _state.value.copy(summarizing = false)
            }
            }
        }
    }

    override fun onCleared() {
        repository.close()
        super.onCleared()
    }
}

data class BridgeState(
    val mode: ServerMode = ServerMode.LIVE,
    val liveRead: Boolean = false,
    val summarizing: Boolean = false,
    val transcribing: Boolean = false,
    val serverUrl: String = "",
    val paired: Boolean = false,
    val localDeviceId: String? = null,
    val busy: Boolean = false,
    val connected: Boolean = false,
    val connectionMessage: String? = null,
    val pairingCode: String = "",
    val conversations: List<ConversationRow> = emptyList(),
    val devices: List<PairedDevice> = emptyList(),
    val selectedId: String? = null,
    val events: List<EventRow> = emptyList(),
    val error: String? = null,
    val lastEvent: String? = null
)
