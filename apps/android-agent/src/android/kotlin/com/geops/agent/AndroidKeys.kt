package com.geops.agent

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.security.PrivateKey
import java.security.KeyPairGenerator
import java.security.spec.ECGenParameterSpec
import javax.crypto.SecretKey
import javax.crypto.KeyGenerator

/** Existing keys only: restoring ciphertext without its key must fail closed. */
object AndroidKeys {
    fun createStateKey(alias: String): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        require(!store.containsAlias(alias)) { "state_key_exists" }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(alias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256).build())
        return generator.generateKey()
    }
    fun createSigningKey(alias: String): EnrollmentSigner {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        require(!store.containsAlias(alias)) { "identity_key_exists" }
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        generator.initialize(KeyGenParameterSpec.Builder(alias,
            KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256).build())
        generator.generateKeyPair()
        return existingEnrollmentSigner(alias)
    }
    fun existingEnrollmentSigner(alias: String): EnrollmentSigner {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val key = store.getKey(alias, null) as? PrivateKey ?: throw IllegalStateException("identity_key_missing")
        val spki = store.getCertificate(alias)?.publicKey?.encoded ?: throw IllegalStateException("identity_cert_missing")
        return object : EnrollmentSigner {
            override val publicSpki: ByteArray = spki
            override fun sign(message: ByteArray): ByteArray = java.security.Signature.getInstance("SHA256withECDSA").run {
                initSign(key); update(message); sign()
            }
        }
    }
    fun existingStateKey(alias: String): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        return store.getKey(alias, null) as? SecretKey ?: throw IllegalStateException("state_key_missing")
    }
    fun existingSigningKey(alias: String, keyId: String): EcdsaDeviceSigner {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val key = store.getKey(alias, null) as? PrivateKey ?: throw IllegalStateException("identity_key_missing")
        return EcdsaDeviceSigner(keyId, key)
    }
}
