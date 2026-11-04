package com.agentbridge.android

import android.Manifest
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.os.Build
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.DeleteOutline
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Forum
import androidx.compose.material.icons.filled.StopCircle
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Divider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.viewmodel.compose.viewModel
import com.agentbridge.android.data.EventRow
import com.agentbridge.android.ui.TimelineItem
import com.agentbridge.android.ui.buildConversationTimeline
import com.agentbridge.android.ui.BridgeViewModel
import com.agentbridge.android.ui.PhoneSpeech
import com.agentbridge.android.data.ServerMode
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import org.json.JSONObject
import java.io.File
import kotlinx.coroutines.launch

class MainActivity : FragmentActivity() {
    private var recorder: MediaRecorder? = null
    private var recordingFile: File? = null
    private var recordingError: ((String) -> Unit)? = null
    private val audioPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (!granted) {
            recordingFile = null
            recordingError?.invoke("Microphone permission is required for push-to-talk.")
        } else {
            recordingError?.invoke("Microphone permission granted. Hold the microphone button to record.")
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent { AgentBridgeApp(this) }
    }

    fun startRecording(onError: (String) -> Unit) {
        recordingError = onError
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            audioPermission.launch(Manifest.permission.RECORD_AUDIO)
            return
        }
        runCatching {
            val file = File(cacheDir, "recording-${System.currentTimeMillis()}.m4a")
            val mediaRecorder = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(this) else MediaRecorder()
            mediaRecorder.setAudioSource(MediaRecorder.AudioSource.MIC)
            mediaRecorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            mediaRecorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            mediaRecorder.setAudioEncodingBitRate(96_000)
            mediaRecorder.setAudioSamplingRate(44_100)
            mediaRecorder.setOutputFile(file.absolutePath)
            mediaRecorder.prepare()
            mediaRecorder.start()
            recorder = mediaRecorder
            recordingFile = file
        }.onFailure {
            recordingError?.invoke(it.message ?: "Could not start audio recording.")
        }
    }

    fun stopRecording(onTranscript: (File) -> Unit) {
        val current = recorder ?: return
        val file = recordingFile
        val stopped = runCatching { current.stop() }
        current.release()
        recorder = null
        recordingFile = null
        if (stopped.isFailure) {
            recordingError?.invoke(stopped.exceptionOrNull()?.message ?: "Could not finish audio recording.")
            file?.delete()
        } else if (file != null && file.exists() && file.length() > 0) {
            onTranscript(file)
        } else file?.delete()
        recordingError = null
    }

    fun cancelRecording() {
        val current = recorder
        recorder = null
        if (current != null) {
            runCatching { current.stop() }
            current.release()
        }
        recordingFile?.delete()
        recordingFile = null
        recordingError = null
    }

    override fun onStop() {
        cancelRecording()
        super.onStop()
    }
}

@Composable
private fun AgentBridgeApp(activity: MainActivity, vm: BridgeViewModel = viewModel()) {
    val state by vm.state.collectAsState()
    var draft by remember(state.mode) { mutableStateOf("") }
    var useBiometric by remember { mutableStateOf(false) }
    var awaitingApproval by remember { mutableStateOf<ApprovalPrompt?>(null) }
    var pendingDeviceRevoke by remember { mutableStateOf<com.agentbridge.android.data.PairedDevice?>(null) }
    var showSettings by remember { mutableStateOf(false) }
    var showConversations by remember { mutableStateOf(false) }
    var showDeviceManager by remember(state.mode) { mutableStateOf(false) }
    var confirmUnpair by remember { mutableStateOf(false) }
    var serverDraft by remember(state.mode, state.serverUrl) { mutableStateOf(state.serverUrl) }
    var speaking by remember { mutableStateOf(false) }
    var recording by remember { mutableStateOf(false) }
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val speech = remember(state.liveRead) {
        if (state.liveRead) PhoneSpeech(context,
            { message -> activity.runOnUiThread { vm.showError(message) } },
            { active -> activity.runOnUiThread { speaking = active } }
        ) else null
    }
    DisposableEffect(speech) { onDispose { speech?.close() } }
    DisposableEffect(lifecycle, speech, showSettings) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) vm.setForeground(!showSettings)
            if (event == Lifecycle.Event.ON_PAUSE) {
                vm.setForeground(false)
                speech?.stop()
                recording = false
                activity.cancelRecording()
            }
        }
        lifecycle.addObserver(observer)
        vm.setForeground(!showSettings && lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED))
        onDispose { lifecycle.removeObserver(observer); vm.setForeground(false) }
    }
    LaunchedEffect(speech) { vm.speech.collect { speech?.speak(it) } }
    LaunchedEffect(state.mode, state.selectedId, showSettings) {
        speech?.stop()
        vm.stopReading()
        recording = false
        activity.cancelRecording()
        awaitingApproval = null
        pendingDeviceRevoke = null
    }
    androidx.activity.compose.BackHandler(enabled = showSettings || showConversations) {
        if (showConversations) showConversations = false else showSettings = false
    }

    MaterialTheme {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            Column(
                Modifier
                    .fillMaxSize()
                    .windowInsetsPadding(WindowInsets.safeDrawing)
                    .imePadding()
                    .padding(horizontal = 12.dp, vertical = 4.dp)
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                    if (showSettings) {
                        IconButton(onClick = { showSettings = false }) { Icon(Icons.Default.ArrowBack, "Back to chat") }
                    }
                    Column(Modifier.weight(1f)) {
                        Text(if (showSettings) "Settings" else "Mcpro ai bridge",
                            style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold,
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            "${state.mode.label} · " + if (state.connected) "Connected" else if (state.paired) "Reconnecting" else "Not paired",
                            style = MaterialTheme.typography.labelMedium,
                            color = if (state.connected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                            maxLines = 1, overflow = TextOverflow.Ellipsis
                        )
                    }
                    if (!showSettings) {
                        if (speaking || state.summarizing) {
                            IconButton(onClick = { vm.stopReading(); speech?.stop() }) {
                                Icon(Icons.Default.StopCircle, "Stop reading aloud")
                            }
                        }
                        IconButton(onClick = { showConversations = true }, enabled = state.paired) {
                            Icon(Icons.Default.Forum, "Conversations")
                        }
                        IconButton(onClick = { showSettings = true }) { Icon(Icons.Default.Settings, "Settings") }
                    }
                }
                Divider(Modifier.padding(vertical = 4.dp))
                if (showSettings) {
                    Column(Modifier.weight(1f).verticalScroll(rememberScrollState()),
                        verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text("Assistant mode", style = MaterialTheme.typography.titleMedium)
                        ServerMode.entries.forEach { mode ->
                            OutlinedButton(onClick = { vm.switchMode(mode) }, enabled = mode != state.mode,
                                modifier = Modifier.fillMaxWidth()) {
                                Text(mode.label + if (mode == state.mode) " (selected)" else "")
                            }
                        }
                        Text("Each mode remembers its own server, pairing and conversations. Switching does not cancel work already running on the host.",
                            style = MaterialTheme.typography.bodySmall)
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text("Read short responses aloud", style = MaterialTheme.typography.titleMedium)
                                Text("Keep the full reply in chat. Ask the host for a short AI summary and speak it on this phone.",
                                    style = MaterialTheme.typography.bodySmall)
                            }
                            Switch(checked = state.liveRead, onCheckedChange = vm::setLiveRead)
                        }
                        Text("Only new replies received in the open conversation are read while the app is in the foreground. Reconnect history is never read. Requires a host summary API key and a downloaded Android voice.",
                            style = MaterialTheme.typography.bodySmall)
                        Divider()
                        Text("Connection", style = MaterialTheme.typography.titleMedium)
                        state.connectionMessage?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                        if (!state.paired) androidx.compose.runtime.key(state.mode) {
                            PairingPanel(state.serverUrl, state.busy, vm, scrollable = false)
                        }
                        else {
                            OutlinedTextField(value = serverDraft, onValueChange = { serverDraft = it },
                                label = { Text("HTTPS server URL") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                            TextButton(onClick = { vm.setServer(serverDraft) }) { Text("Save address") }
                            Text("Unpair this mode before changing its address. Tokens are never sent to a different host.",
                                style = MaterialTheme.typography.bodySmall)
                            OutlinedButton(onClick = { confirmUnpair = true }) { Text("Unpair ${state.mode.label}") }
                            TextButton(onClick = {
                                showDeviceManager = !showDeviceManager
                                if (showDeviceManager) vm.refreshDevices()
                            }) { Text(if (showDeviceManager) "Hide paired devices" else "Manage paired devices") }
                            if (showDeviceManager) DeviceManager(state.devices, state.localDeviceId,
                                onRefresh = vm::refreshDevices, onRevoke = { pendingDeviceRevoke = it })
                        }
                    }
                } else if (!state.paired) androidx.compose.runtime.key(state.mode) {
                    PairingPanel(state.serverUrl, state.busy, vm)
                }
                else {
                    state.selectedId?.let {
                        EventList(state.events, onAnswer = vm::answer, onApproval = { id, op, details ->
                            awaitingApproval = ApprovalPrompt(id, op, details)
                        })
                    } ?: Column(Modifier.weight(1f).fillMaxWidth(), verticalArrangement = Arrangement.Center,
                        horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("Start a conversation", style = MaterialTheme.typography.titleLarge)
                        Text("Your assistant is ready.")
                        Button(onClick = vm::createConversation, enabled = state.connected) { Text("New conversation") }
                    }
                    if (recording || state.transcribing || state.summarizing) Text(
                        when { recording -> "Recording... release to send"; state.transcribing -> "Transcribing...";
                            else -> "Preparing short spoken reply..." },
                        style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(vertical = 4.dp))
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                        HoldToTalk(
                            enabled = state.connected && state.selectedId != null && !state.transcribing,
                            onStart = {
                                vm.stopReading(); speech?.stop()
                                recording = true
                                activity.startRecording { recording = false; vm.showError(it) }
                            },
                            onStop = { recording = false; activity.stopRecording { file -> vm.transcribe(file) { transcript ->
                                if (!vm.send(transcript)) draft = transcript
                            } } },
                            onCancel = { recording = false; activity.cancelRecording() }
                        )
                        Spacer(Modifier.width(8.dp))
                        OutlinedTextField(
                            value = draft,
                            onValueChange = { draft = it },
                            modifier = Modifier.weight(1f),
                            placeholder = { Text("Message") },
                            maxLines = 5,
                            enabled = state.selectedId != null
                        )
                        IconButton(onClick = { if (vm.send(draft)) draft = "" },
                            enabled = draft.isNotBlank() && state.connected && state.selectedId != null) {
                            Icon(Icons.Default.Send, "Send message")
                        }
                    }
                }
                state.error?.let { ErrorDialog(it, vm::dismissError) }
            }
        }
    }

    if (showConversations) {
        androidx.compose.ui.window.Dialog(onDismissRequest = { showConversations = false }) {
            Surface(shape = RoundedCornerShape(24.dp)) {
                Column(Modifier.padding(16.dp)) {
                    ConversationPicker(state.conversations, state.selectedId, vm,
                        onSelected = { showConversations = false }, mode = state.mode)
                    TextButton(onClick = { showConversations = false }) { Text("Back to chat") }
                }
            }
        }
    }
    if (confirmUnpair) AlertDialog(
        onDismissRequest = { confirmUnpair = false },
        title = { Text("Unpair ${state.mode.label}?") },
        text = { Text("Remove this mode's local pairing and cached chats? Host history and the other mode are kept.") },
        confirmButton = { TextButton(onClick = { vm.revoke(); confirmUnpair = false }) { Text("Unpair") } },
        dismissButton = { TextButton(onClick = { confirmUnpair = false }) { Text("Cancel") } }
    )

    awaitingApproval?.let { prompt ->
        val approvalId = prompt.id
        val operation = prompt.operation
        AlertDialog(
            onDismissRequest = { awaitingApproval = null },
            title = { Text("Approve exact operation?") },
            text = {
                Column {
                    Text(operation, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.height(8.dp))
                    Text(prompt.details)
                    Spacer(Modifier.height(8.dp))
                    Text("Review this exact operation before allowing it.")
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(checked = useBiometric, onCheckedChange = { useBiometric = it })
                        Text("Confirm with biometrics when available")
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    val approve = {
                        vm.respond(approvalId, true)
                        awaitingApproval = null
                    }
                    val available = BiometricManager.from(context)
                        .canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS
                    if (useBiometric && available) {
                        BiometricPrompt(
                            activity,
                            ContextCompat.getMainExecutor(context),
                            object : BiometricPrompt.AuthenticationCallback() {
                                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = approve()
                            }
                        ).authenticate(
                            BiometricPrompt.PromptInfo.Builder()
                                .setTitle("Approve operation")
                                .setSubtitle(operation)
                                .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                                .build()
                        )
                    } else approve()
                }) { Text("Approve") }
            },
            dismissButton = {
                TextButton(onClick = { vm.respond(approvalId, false); awaitingApproval = null }) { Text("Deny") }
            }
        )
    }

    pendingDeviceRevoke?.let { device ->
        val isCurrentDevice = device.id == state.localDeviceId
        AlertDialog(
            onDismissRequest = { pendingDeviceRevoke = null },
            title = { Text(if (isCurrentDevice) "Revoke this phone?" else "Revoke paired device?") },
            text = {
                Text(
                    if (isCurrentDevice) {
                        "Revoke access for ${device.name}? This phone will be unpaired and its local conversation cache cleared."
                    } else {
                        "Revoke the bearer token for ${device.name}? That device will lose access immediately."
                    }
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    vm.revokeDevice(device.id)
                    pendingDeviceRevoke = null
                }) { Text("Revoke token") }
            },
            dismissButton = { TextButton(onClick = { pendingDeviceRevoke = null }) { Text("Cancel") } }
        )
    }
}

@Composable
private fun PairingPanel(url: String, busy: Boolean, vm: BridgeViewModel, scrollable: Boolean = true) {
    var address by remember(url) { mutableStateOf(url) }
    var code by remember { mutableStateOf("") }
    val scroll = rememberScrollState()
    Column(Modifier.fillMaxWidth().then(if (scrollable) Modifier.verticalScroll(scroll) else Modifier),
        verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Connect to your Mcpro ai bridge host", style = MaterialTheme.typography.titleLarge)
        Text("Use a private LAN or VPN address with a valid HTTPS certificate. No public relay is used.")
        OutlinedTextField(address, { address = it }, label = { Text("HTTPS server URL") }, modifier = Modifier.fillMaxWidth())
        OutlinedButton(onClick = { vm.setServer(address) }, modifier = Modifier.fillMaxWidth()) { Text("Save server address") }
        OutlinedTextField(code, { code = it }, label = { Text("One-time pairing code") }, modifier = Modifier.fillMaxWidth())
        Button(onClick = { if (vm.setServer(address)) vm.pair(code) }, enabled = !busy && code.isNotBlank(), modifier = Modifier.fillMaxWidth()) {
            if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Text("Pair this phone")
        }
    }
}

@Composable
private fun DeviceManager(
    devices: List<com.agentbridge.android.data.PairedDevice>,
    localDeviceId: String?,
    onRefresh: () -> Unit,
    onRevoke: (com.agentbridge.android.data.PairedDevice) -> Unit
) {
    Column(Modifier.fillMaxWidth().heightIn(max = 180.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Paired device tokens", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
            TextButton(onClick = onRefresh) { Text("Refresh") }
        }
        if (devices.isEmpty()) {
            Text("No paired devices found.", style = MaterialTheme.typography.bodySmall)
        } else {
            LazyColumn(Modifier.weight(1f, fill = false), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                items(devices, key = { it.id }) { device ->
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.weight(1f)) {
                            Text(
                                device.name + if (device.id == localDeviceId) " (this phone)" else "",
                                style = MaterialTheme.typography.bodyMedium
                            )
                            Text(
                                device.lastSeenAt.takeIf { it.isNotBlank() }?.let { "Last seen $it" } ?: "Last seen unknown",
                                style = MaterialTheme.typography.bodySmall
                            )
                        }
                        TextButton(onClick = { onRevoke(device) }) { Text("Revoke") }
                    }
                }
            }
        }
    }
}

@Composable
private fun ConversationPicker(
    rows: List<com.agentbridge.android.data.ConversationRow>, selectedId: String?, vm: BridgeViewModel,
    onSelected: () -> Unit, mode: ServerMode
) {
    var deleteTarget by remember { mutableStateOf<com.agentbridge.android.data.ConversationRow?>(null) }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Conversations", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
        IconButton(
            onClick = { deleteTarget = rows.firstOrNull { it.id == selectedId } },
            enabled = selectedId != null
        ) {
            Icon(Icons.Default.DeleteOutline, "Delete selected conversation")
        }
        IconButton(onClick = { vm.createConversation(); onSelected() }) { Icon(Icons.Default.Add, "New conversation") }
    }
    LazyColumn(Modifier.fillMaxWidth().heightIn(max = 360.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        items(rows, key = { it.id }) { row ->
            Surface(
                shape = RoundedCornerShape(18.dp),
                color = if (row.id == selectedId) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant,
                modifier = Modifier.fillMaxWidth().clickable { vm.select(row.id); onSelected() }
            ) {
                Text(row.title, Modifier.padding(horizontal = 14.dp, vertical = 10.dp), maxLines = 1)
            }
        }
    }
    deleteTarget?.let { conversation ->
        AlertDialog(
            onDismissRequest = { deleteTarget = null },
            title = { Text("Delete conversation?") },
            text = {
                Text(if (mode == ServerMode.LIVE)
                    "Delete “${conversation.title}” from this phone and the relay cache? Your VS Code session is not deleted."
                    else "Delete “${conversation.title}” and its saved messages from this phone and the host? This cannot be undone.")
            },
            confirmButton = {
                TextButton(onClick = {
                    vm.deleteConversation(conversation.id)
                    deleteTarget = null
                }) { Text("Delete") }
            },
            dismissButton = { TextButton(onClick = { deleteTarget = null }) { Text("Cancel") } }
        )
    }
}

@Composable
private fun ColumnScope.EventList(
    events: List<EventRow>,
    onAnswer: (String, String) -> Unit,
    onApproval: (String, String, String) -> Unit
) {
    val timeline = remember(events) { buildConversationTimeline(events) }
    val listState = androidx.compose.foundation.lazy.rememberLazyListState()
    val scope = rememberCoroutineScope()
    val nearBottom by remember {
        derivedStateOf {
            val layout = listState.layoutInfo
            (layout.visibleItemsInfo.lastOrNull()?.index ?: 0) >= layout.totalItemsCount - 2
        }
    }
    LaunchedEffect(timeline.lastOrNull()?.key, events.size) {
        if (timeline.isNotEmpty() && nearBottom) listState.scrollToItem(timeline.lastIndex)
    }
    LazyColumn(
        modifier = Modifier.fillMaxWidth().weight(1f),
        state = listState,
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        items(timeline, key = { it.key }) { item ->
            when (item) {
                is TimelineItem.Message -> MessageBubble(item)
                is TimelineItem.Tool -> ToolStatusCard(item)
                is TimelineItem.Server -> EventCard(item.packet, item.type, onAnswer, onApproval)
            }
        }
    }
    if (!nearBottom) TextButton(onClick = {
        scope.launch { if (timeline.isNotEmpty()) listState.animateScrollToItem(timeline.lastIndex) }
    }, modifier = Modifier.align(Alignment.CenterHorizontally)) { Text("Jump to latest") }
}

@Composable
private fun MessageBubble(message: TimelineItem.Message) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (message.role == "You") Arrangement.End else Arrangement.Start
    ) {
        Surface(
            modifier = Modifier.fillMaxWidth(0.9f),
            shape = RoundedCornerShape(20.dp),
            color = if (message.role == "You") {
                MaterialTheme.colorScheme.primaryContainer
            } else {
                MaterialTheme.colorScheme.surfaceVariant
            }
        ) {
            Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
                Text(
                    message.role + if (message.streaming) " · responding" else "",
                    style = MaterialTheme.typography.labelMedium,
                    color = if (message.role == "You") MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.secondary,
                    fontWeight = FontWeight.SemiBold
                )
                if (message.content.isNotBlank()) {
                    Spacer(Modifier.height(4.dp))
                    SelectionContainer { MarkdownText(message.content) }
                } else if (message.streaming) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                }
            }
        }
    }
}

@Composable
private fun ToolStatusCard(item: TimelineItem.Tool) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
            Text(item.toolName, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
            Text(
                buildString {
                    append(item.status.replaceFirstChar { it.uppercase() })
                    if (item.summary.isNotBlank()) append(" · ${item.summary}")
                },
                style = MaterialTheme.typography.bodySmall
            )
        }
    }
}

@Composable
private fun EventCard(
    packet: JSONObject,
    type: String,
    onAnswer: (String, String) -> Unit,
    onApproval: (String, String, String) -> Unit
) {
    var answer by remember(packet.optString("questionId")) { mutableStateOf("") }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp)) {
            when (type) {
                "question.asked" -> {
                    Text("A question needs your input", fontWeight = FontWeight.Bold)
                    Text(packet.optString("prompt"))
                    val choices = packet.optJSONArray("choices")
                    if (choices != null && choices.length() > 0) {
                        for (i in 0 until choices.length()) {
                            val choice = choices.optString(i)
                            TextButton(onClick = { onAnswer(packet.optString("questionId"), choice) }) { Text(choice) }
                        }
                    } else {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            OutlinedTextField(answer, { answer = it }, modifier = Modifier.weight(1f), label = { Text("Your answer") })
                            TextButton(onClick = { onAnswer(packet.optString("questionId"), answer) }) { Text("Reply") }
                        }
                    }
                }
                "question.answered" -> Text("Question answered")
                "question.expired" -> Text("Question expired")
                "approval.requested" -> {
                    val operation = packet.optJSONObject("operation")
                    Text("Approval required", fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.tertiary)
                    Text(operation?.optString("kind") ?: packet.optString("operation"), fontWeight = FontWeight.SemiBold)
                    Text(operation?.toString(2) ?: packet.optString("details"))
                    Button(onClick = {
                        onApproval(
                            packet.optString("approvalId"),
                            operation?.optString("kind") ?: packet.optString("operation"),
                            operation?.toString(2) ?: packet.optString("details")
                        )
                    }) { Text("Review & approve") }
                }
                "approval.completed" -> Text("Approval ${packet.optString("decision")}")
                "error" -> Text(packet.optString("message"), color = MaterialTheme.colorScheme.error)
                else -> Text(type)
            }
        }
    }
}

private sealed interface MarkdownBlock {
    data class Paragraph(val text: String) : MarkdownBlock
    data class Heading(val level: Int, val text: String) : MarkdownBlock
    data class Bullet(val text: String) : MarkdownBlock
    data class Numbered(val number: String, val text: String) : MarkdownBlock
    data class Quote(val text: String) : MarkdownBlock
    data class Code(val text: String) : MarkdownBlock
}

private fun markdownBlocks(source: String): List<MarkdownBlock> {
    val result = mutableListOf<MarkdownBlock>()
    val paragraph = mutableListOf<String>()
    val code = mutableListOf<String>()
    var inCode = false

    fun flushParagraph() {
        if (paragraph.isNotEmpty()) {
            result += MarkdownBlock.Paragraph(paragraph.joinToString(" "))
            paragraph.clear()
        }
    }

    for (line in source.lines()) {
        if (line.trimStart().startsWith("```")) {
            flushParagraph()
            if (inCode) result += MarkdownBlock.Code(code.joinToString("\n"))
            code.clear()
            inCode = !inCode
            continue
        }
        if (inCode) {
            code += line
            continue
        }
        val heading = Regex("""^(#{1,6})\s+(.+)$""").matchEntire(line.trim())
        val bullet = Regex("""^\s*[-*+]\s+(.+)$""").matchEntire(line)
        val numbered = Regex("""^\s*(\d+)[.)]\s+(.+)$""").matchEntire(line)
        val quote = Regex("""^\s*>\s?(.*)$""").matchEntire(line)
        when {
            line.isBlank() -> flushParagraph()
            heading != null -> {
                flushParagraph()
                result += MarkdownBlock.Heading(heading.groupValues[1].length, heading.groupValues[2])
            }
            bullet != null -> {
                flushParagraph()
                result += MarkdownBlock.Bullet(bullet.groupValues[1])
            }
            numbered != null -> {
                flushParagraph()
                result += MarkdownBlock.Numbered(numbered.groupValues[1], numbered.groupValues[2])
            }
            quote != null -> {
                flushParagraph()
                result += MarkdownBlock.Quote(quote.groupValues[1])
            }
            else -> paragraph += line.trim()
        }
    }
    flushParagraph()
    if (code.isNotEmpty()) result += MarkdownBlock.Code(code.joinToString("\n"))
    return result
}

private val inlineMarkdownPattern = Regex("""(\*\*.+?\*\*|__.+?__|~~.+?~~|`[^`]+`|\*[^*]+\*|_[^_]+_)""")

@Composable
private fun MarkdownText(content: String) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        markdownBlocks(content).forEach { block ->
            when (block) {
                is MarkdownBlock.Paragraph -> MarkdownInlineText(block.text)
                is MarkdownBlock.Heading -> MarkdownInlineText(
                    block.text,
                    style = when (block.level) {
                        1 -> MaterialTheme.typography.titleLarge
                        2 -> MaterialTheme.typography.titleMedium
                        else -> MaterialTheme.typography.titleSmall
                    }
                )
                is MarkdownBlock.Bullet -> Row {
                    Text("•  ", style = MaterialTheme.typography.bodyMedium)
                    MarkdownInlineText(block.text, Modifier.weight(1f))
                }
                is MarkdownBlock.Numbered -> Row {
                    Text("${block.number}.  ", style = MaterialTheme.typography.bodyMedium)
                    MarkdownInlineText(block.text, Modifier.weight(1f))
                }
                is MarkdownBlock.Quote -> Surface(
                    color = MaterialTheme.colorScheme.surface,
                    shape = RoundedCornerShape(8.dp)
                ) {
                    MarkdownInlineText(block.text, Modifier.padding(8.dp))
                }
                is MarkdownBlock.Code -> Surface(
                    modifier = Modifier.fillMaxWidth(),
                    color = MaterialTheme.colorScheme.surface,
                    shape = RoundedCornerShape(8.dp)
                ) {
                    Text(
                        block.text,
                        modifier = Modifier.horizontalScroll(rememberScrollState()).padding(10.dp),
                        fontFamily = FontFamily.Monospace,
                        style = MaterialTheme.typography.bodySmall
                    )
                }
            }
        }
    }
}

@Composable
private fun MarkdownInlineText(
    text: String,
    modifier: Modifier = Modifier,
    style: TextStyle? = null
) {
    val annotated = buildAnnotatedString {
        var offset = 0
        for (match in inlineMarkdownPattern.findAll(text)) {
            append(text.substring(offset, match.range.first))
            val token = match.value
            when {
                token.startsWith("**") || token.startsWith("__") ->
                    withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(token.substring(2, token.length - 2)) }
                token.startsWith("~~") ->
                    withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { append(token.substring(2, token.length - 2)) }
                token.startsWith("`") ->
                    withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = MaterialTheme.colorScheme.surface)) {
                        append(token.substring(1, token.length - 1))
                    }
                else ->
                    withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(token.substring(1, token.length - 1)) }
            }
            offset = match.range.last + 1
        }
        append(text.substring(offset))
    }
    Text(annotated, modifier = modifier, style = style ?: MaterialTheme.typography.bodyMedium)
}

@Composable
private fun HoldToTalk(enabled: Boolean, onStart: () -> Unit, onStop: () -> Unit, onCancel: () -> Unit) {
    var recording by remember { mutableStateOf(false) }
    val start by rememberUpdatedState(onStart)
    val stop by rememberUpdatedState(onStop)
    val cancel by rememberUpdatedState(onCancel)
    Box(
        Modifier
            .size(54.dp)
            .background(if (!enabled) MaterialTheme.colorScheme.surfaceVariant else if (recording)
                MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary, RoundedCornerShape(28.dp))
            .pointerInput(enabled) {
                detectTapGestures(onPress = {
                    if (!enabled) return@detectTapGestures
                    recording = true
                    start()
                    try {
                        if (tryAwaitRelease()) stop() else cancel()
                    } finally {
                        recording = false
                    }
                })
            },
        contentAlignment = Alignment.Center
    ) {
        Icon(Icons.Default.Mic, "Hold to record; release to upload", tint = MaterialTheme.colorScheme.onPrimary)
    }
}

@Composable
private fun ColumnScope.EmptyState() {
    Column(Modifier.weight(1f).fillMaxWidth(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Text("Choose or create a conversation")
        Spacer(Modifier.height(8.dp))
        Text("Conversation events are stored on this phone for reconnect replay.", style = MaterialTheme.typography.bodySmall)
    }
}

private data class ApprovalPrompt(val id: String, val operation: String, val details: String)

@Composable
private fun ErrorDialog(message: String, dismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = dismiss,
        title = { Text("Mcpro ai bridge") },
        text = { Text(message) },
        confirmButton = { TextButton(onClick = dismiss) { Text("OK") } }
    )
}
