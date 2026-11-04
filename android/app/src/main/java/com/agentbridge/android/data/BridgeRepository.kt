package com.agentbridge.android.data

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.cancel
import kotlinx.coroutines.withContext
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

class BridgeRepository(
    context: Context,
    profile: String,
    databaseName: String,
    private val onEvent: (JSONObject, Boolean) -> Unit,
    private val onConnection: (Boolean, String?) -> Unit
) {
    private val database = BridgeDatabase.create(context, databaseName)
    private val dao = database.bridgeDao()
    private val tokenStore = com.agentbridge.android.security.DeviceTokenStore(context, profile)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    @Volatile private var client: BridgeClient? = null
    @Volatile private var socket: WebSocket? = null
    @Volatile private var connectionGeneration = 0L
    private val closed = AtomicBoolean(false)
    @Volatile private var reconnectAttempt = 0

    val conversations = dao.observeConversations()

    fun paired() = tokenStore.read() != null
    fun localDeviceId() = tokenStore.readDeviceId()

    suspend fun pair(url: String, code: String, deviceName: String) = withContext(Dispatchers.IO) {
        val candidate = BridgeClient(url, { null })
        val response = candidate.pair(code, deviceName)
        val deviceId = response.getString("deviceId")
        val token = response.getString("token")
        require(deviceId.isNotBlank() && token.isNotBlank())
        tokenStore.save(token, deviceId)
        client = BridgeClient(url, tokenStore::read)
        closed.set(false)
        connect()
    }

    @Synchronized
    fun configure(url: String) {
        val oldSocket = socket
        connectionGeneration++
        socket = null
        onConnection(false, "Switching server address")
        oldSocket?.cancel()
        if (BridgeProtocol.isValidHttpsUrl(url)) {
            client = BridgeClient(url, tokenStore::read)
            closed.set(false)
            if (paired()) connect()
        } else {
            client = null
            closed.set(true)
            onConnection(false, "Server address must use HTTPS")
        }
    }

    suspend fun pairedDevices(): List<PairedDevice> = withContext(Dispatchers.IO) {
        val result = clientOrFail().devices().getJSONArray("devices")
        (0 until result.length()).map { i ->
            val device = result.getJSONObject(i)
            PairedDevice(
                id = BridgeProtocol.deviceId(device),
                name = BridgeProtocol.deviceName(device),
                createdAt = device.optString("createdAt"),
                lastSeenAt = device.optString("lastSeenAt", device.optString("lastUsedAt"))
            )
        }.filterIndexed { index, device ->
            device.id.isNotBlank() && result.getJSONObject(index).isNull("revokedAt")
        }
    }

    suspend fun revokeDevice(deviceId: String) = withContext(Dispatchers.IO) {
        clientOrFail().revokeDevice(deviceId)
        if (deviceId == tokenStore.readDeviceId()) revoke()
    }

    suspend fun refreshConversations() = withContext(Dispatchers.IO) {
        val result = clientOrFail().conversations().getJSONArray("conversations")
        val rows = (0 until result.length()).map { i ->
            val item = result.getJSONObject(i)
            ConversationRow(item.getString("id"), item.optString("title", "Conversation"), item.optString("updatedAt", ""))
        }
        dao.synchronizeConversations(rows)
    }

    suspend fun createConversation(): String = withContext(Dispatchers.IO) {
        val item = clientOrFail().createConversation()
        val row = ConversationRow(item.getString("id"), item.optString("title", "New conversation"), item.optString("updatedAt", ""))
        dao.saveConversation(row)
        row.id
    }

    suspend fun deleteConversation(conversationId: String) = withContext(Dispatchers.IO) {
        clientOrFail().deleteConversation(conversationId)
        dao.deleteConversation(conversationId)
    }

    fun observeEvents(id: String) = dao.observeEvents(id)

    fun sendMessage(conversationId: String, text: String): Boolean =
        send(BridgeProtocol.message(conversationId, text))

    fun answer(questionId: String, answer: String) {
        send(BridgeProtocol.answer(questionId, answer))
    }

    fun respond(approvalId: String, approve: Boolean) {
        send(BridgeProtocol.approval(approvalId, approve))
    }

    suspend fun transcribe(file: File): String = withContext(Dispatchers.IO) { clientOrFail().transcribe(file) }

    suspend fun summarize(text: String): String = withContext(Dispatchers.IO) { clientOrFail().summarize(text) }

    fun close() {
        closed.set(true)
        connectionGeneration++
        socket?.cancel()
        socket = null
        client = null
        scope.coroutineContext[kotlinx.coroutines.Job]?.invokeOnCompletion { database.close() }
        scope.cancel()
    }

    fun revoke() {
        closed.set(true)
        connectionGeneration++
        socket?.close(1000, "Device unpaired")
        socket = null
        tokenStore.revokeLocally()
        client = null
        scope.launch {
            dao.clearEvents()
            dao.clearConversations()
        }
        onConnection(false, "Device token removed from this phone")
    }

    private fun send(packet: JSONObject): Boolean {
        val sent = socket?.send(packet.toString()) == true
        if (!sent) onConnection(false, "Not connected; message was not sent")
        return sent
    }

    @Synchronized
    private fun connect() {
        if (closed.get() || socket != null || client == null) return
        val current = client ?: return
        val generation = connectionGeneration
        socket = current.openSocket(object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (!isCurrentSocket(webSocket, generation)) {
                    webSocket.close(1000, "Superseded server connection")
                    return
                }
                reconnectAttempt = 0
                webSocket.send(BridgeProtocol.auth(tokenStore.read().orEmpty()).toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (!isCurrentSocket(webSocket, generation)) return
                runCatching { JSONObject(text) }.onSuccess { packet ->
                    if (packet.optString("type") == "auth.ok") {
                        onConnection(true, null)
                        val replayCursors = runCatching {
                            kotlinx.coroutines.runBlocking(Dispatchers.IO) {
                                dao.conversationIds().associateWith { id -> dao.lastSequence(id) }
                            }
                        }.getOrElse {
                            onConnection(true, "Could not read local replay cursor: ${it.message}")
                            emptyMap()
                        }
                        replay(replayCursors, generation)
                    } else if (packet.optString("type") == "conversation.deleted") {
                        val conversationId = packet.optString("conversationId")
                        if (conversationId.isNotBlank()) {
                            scope.launch {
                                dao.deleteConversation(conversationId)
                                onEvent(packet, true)
                            }
                        }
                    } else if (packet.has("sequence")) {
                        scope.launch {
                            if (generation != connectionGeneration) return@launch
                            val inserted = persist(packet)
                            onEvent(packet, inserted)
                        }
                    } else if (packet.optString("type") == "error") {
                        onConnection(false, packet.optString("message"))
                    }
                }.onFailure { onConnection(true, "Received an unreadable server event") }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, reason)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (isCurrentSocket(webSocket, generation)) {
                    socket = null
                    scheduleReconnect(generation)
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (isCurrentSocket(webSocket, generation)) {
                    socket = null
                    onConnection(false, t.message ?: "Connection failed")
                    scheduleReconnect(generation)
                }
            }
        })
    }

    private fun isCurrentSocket(webSocket: WebSocket, generation: Long): Boolean =
        BridgeProtocol.isCurrentSocketCallback(
            activeGeneration = connectionGeneration,
            callbackGeneration = generation,
            isActiveSocket = socket === webSocket
        )

    private fun replay(startingAfter: Map<String, Long>, generation: Long) {
        scope.launch {
            runCatching {
                kotlinx.coroutines.coroutineScope {
                    if (generation != connectionGeneration) return@coroutineScope
                    refreshConversations()
                    dao.conversationIds().forEach { id ->
                        if (generation != connectionGeneration) return@forEach
                        var after = startingAfter[id] ?: 0L
                        while (true) {
                            if (generation != connectionGeneration) break
                            val response = client?.events(id, after) ?: break
                            val page = BridgeProtocol.eventPage(response)
                            for (packet in page.events) {
                                if (generation != connectionGeneration) break
                                persist(packet)
                                onEvent(packet, false)
                            }
                            after = BridgeProtocol.nextReplayCursor(after, page) ?: break
                        }
                    }
                }
            }.onFailure {
                if (generation == connectionGeneration && !closed.get()) onConnection(true, "Replay unavailable: ${it.message}")
            }
        }
    }

    private suspend fun persist(packet: JSONObject): Boolean {
        val conversationId = BridgeProtocol.eventConversationId(packet) ?: return false
        val sequence = BridgeProtocol.eventSequence(packet) ?: return false
        return dao.saveEvent(EventRow(conversationId, sequence, BridgeProtocol.eventType(packet), packet.toString())) != -1L
    }

    private fun scheduleReconnect(generation: Long) {
        if (closed.get() || !paired()) return
        val delay = (1000L shl reconnectAttempt.coerceAtMost(5)).coerceAtMost(30_000L)
        reconnectAttempt++
        Thread {
            Thread.sleep(delay)
            synchronized(this) {
                if (generation == connectionGeneration && socket == null && !closed.get()) connect()
            }
        }.start()
    }

    private fun clientOrFail() = client ?: error("Set the server address and pair this device first")
}
