package com.geops.agent

import java.security.KeyStore
import java.security.PrivateKey
import javax.crypto.SecretKey

/** Existing keys only: restoring ciphertext without its key must fail closed. */
object AndroidKeys {
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
