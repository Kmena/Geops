package com.geops.weekendpoc

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class CryptoBox {
    private val alias = "geops-weekend-poc-v1"
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).build())
            generateKey()
        }
    }
    fun encrypt(plain: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        return Base64.encodeToString(cipher.iv + cipher.doFinal(plain.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
    }
    fun decrypt(encoded: String): String {
        val bytes = Base64.decode(encoded, Base64.DEFAULT)
        require(bytes.size > 12)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        return String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
    }
}

class PocCredentials(context: Context) {
    private val prefs = context.getSharedPreferences("poc-identity", Context.MODE_PRIVATE)
    private val crypto = CryptoBox()
    val apiBase: String get() = prefs.getString("base", "") ?: ""
    val token: String get() = prefs.getString("token", null)?.let { crypto.decrypt(it) } ?: ""
    val deviceId: String get() = prefs.getString("device", "") ?: ""

    internal fun saveEnrollment(base: String, device: EnrolledDevice) {
        require(base.startsWith("https://"))
        val encryptedToken = crypto.encrypt(device.token)
        check(prefs.edit().putString("base", base).putString("device", device.deviceId)
            .putString("token", encryptedToken).commit())
    }
    fun clear() { prefs.edit().clear().apply() }
}
