package com.agentbridge.android.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class DeviceTokenStore(context: Context, profile: String? = null) {
    private val preferences = context.getSharedPreferences(
        if (profile == null) "device_credentials" else "device_credentials_$profile", Context.MODE_PRIVATE
    )
    private val keyAlias = if (profile == null) KEY_ALIAS else "$KEY_ALIAS-$profile"

    @Synchronized
    fun save(token: String, deviceId: String) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val encrypted = cipher.doFinal(token.toByteArray(Charsets.UTF_8))
        val deviceCipher = Cipher.getInstance(TRANSFORMATION)
        deviceCipher.init(Cipher.ENCRYPT_MODE, key())
        val encryptedDeviceId = deviceCipher.doFinal(deviceId.toByteArray(Charsets.UTF_8))
        val saved = preferences.edit()
            .putString("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .putString("token", Base64.encodeToString(encrypted, Base64.NO_WRAP))
            .putString("device_id_iv", Base64.encodeToString(deviceCipher.iv, Base64.NO_WRAP))
            .putString("device_id", Base64.encodeToString(encryptedDeviceId, Base64.NO_WRAP))
            .commit()
        check(saved) { "Could not securely save the device pairing. Try pairing again." }
    }

    @Synchronized
    fun read(): String? {
        return decrypt("iv", "token")
    }

    @Synchronized
    fun readDeviceId(): String? {
        return decrypt("device_id_iv", "device_id")
    }

    private fun decrypt(ivKey: String, valueKey: String): String? {
        val iv = preferences.getString(ivKey, null) ?: return null
        val encrypted = preferences.getString(valueKey, null) ?: return null
        return runCatching {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(
                Cipher.DECRYPT_MODE,
                key(),
                GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP))
            )
            String(cipher.doFinal(Base64.decode(encrypted, Base64.NO_WRAP)), Charsets.UTF_8)
        }.getOrNull()
    }

    @Synchronized
    fun revokeLocally() {
        preferences.edit().clear().apply()
        runCatching {
            val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            store.deleteEntry(keyAlias)
        }
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(keyAlias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                keyAlias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build()
        )
        return generator.generateKey()
    }

    private companion object {
        const val KEY_ALIAS = "agentbridge-device-token"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
