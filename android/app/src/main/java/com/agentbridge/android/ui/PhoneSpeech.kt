package com.agentbridge.android.ui

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.util.Locale

class PhoneSpeech(
    context: Context,
    private val onError: (String) -> Unit,
    private val onSpeaking: (Boolean) -> Unit
) {
    private val audio = context.getSystemService(AudioManager::class.java)
    private val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
    private val focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
        .setAudioAttributes(attributes).setOnAudioFocusChangeListener { change ->
            if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) stop()
        }.build()
    private var ready = false
    private var failed = false
    private var pending: String? = null
    private var disposed = false
    @Volatile private var utteranceId: String? = null
    private val tts = TextToSpeech(context.applicationContext) { status ->
        android.os.Handler(android.os.Looper.getMainLooper()).post { initialize(status) }
    }

    private fun initialize(status: Int) {
        if (disposed) return
        if (status != TextToSpeech.SUCCESS) {
            failed = true
            pending = null
            onError("Android text-to-speech could not start. Check the phone's text-to-speech settings.")
            return
        }
        val language = Locale.getDefault().language
        val voice = tts.voices?.firstOrNull {
            it.locale.language == language && !it.isNetworkConnectionRequired &&
                it.features?.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) != true
        }
        if (voice == null || tts.setVoice(voice) != TextToSpeech.SUCCESS) {
            failed = true
            pending = null
            onError("Install a downloaded text-to-speech voice for your phone's language, then reopen the app.")
            return
        }
        tts.setAudioAttributes(attributes)
        tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(id: String?) { if (id == utteranceId) onSpeaking(true) }
            override fun onDone(id: String?) {
                if (id != utteranceId) return
                utteranceId = null
                audio.abandonAudioFocusRequest(focus)
                onSpeaking(false)
            }
            @Deprecated("Android TTS callback")
            override fun onError(id: String?) {
                if (id != utteranceId) return
                utteranceId = null
                audio.abandonAudioFocusRequest(focus)
                onSpeaking(false)
                onError("Android could not read the summary aloud.")
            }
        })
        ready = true
        pending?.let { pending = null; speak(it) }
    }

    fun speak(text: String) {
        if (disposed) return
        if (failed) {
            onError("Read-aloud is unavailable. Check your downloaded Android text-to-speech voice.")
            return
        }
        if (!ready) { pending = text; return }
        stop()
        if (audio.requestAudioFocus(focus) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            onError("Could not read aloud because another app is using audio.")
            return
        }
        utteranceId = "summary-${System.nanoTime()}"
        if (tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId) == TextToSpeech.ERROR) {
            utteranceId = null
            audio.abandonAudioFocusRequest(focus)
            onError("Android rejected the spoken summary.")
        }
    }

    fun stop() {
        pending = null
        utteranceId = null
        tts.stop()
        audio.abandonAudioFocusRequest(focus)
        onSpeaking(false)
    }

    fun close() {
        disposed = true
        stop()
        tts.shutdown()
    }
}
