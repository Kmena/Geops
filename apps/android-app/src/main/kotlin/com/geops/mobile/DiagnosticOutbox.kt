package com.geops.mobile

import android.content.Context
import android.util.AtomicFile
import com.geops.agent.AndroidAgentClock
import com.geops.agent.AndroidKeys
import com.geops.agent.HttpsEnrollmentTransport
import com.geops.agent.PopHttpClient
import com.geops.agent.RefreshingSessionProvider
import com.geops.agent.SYNTHETIC_STAGING_BASE_URL
import java.io.File
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONArray
import org.json.JSONObject

/** Encrypted, bounded diagnostic queue. GPS position storage and transport remain independent. */
internal object DiagnosticOutbox {
    private const val MAX_PENDING = 16
    private const val MIN_CHANGE_MS = 60_000L
    private const val REFRESH_MS = 15 * 60_000L
    private const val PATH = "/v1/device/diagnostics/snapshots"

    private fun file(context: Context, installationId: String): AtomicFile {
        val suffix = MessageDigest.getInstance("SHA-256")
            .digest(installationId.toByteArray(Charsets.UTF_8)).take(12)
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }
        return AtomicFile(File(context.noBackupFilesDir, "diagnostic-outbox-$suffix.bin"))
    }

    private fun read(file: AtomicFile, key: SecretKey): JSONArray {
        if (!file.baseFile.exists()) return JSONArray()
        val bytes = file.openRead().use { it.readBytes() }
        require(bytes.size in 29..262_144 && bytes[0] == 1.toByte()) { "diagnostic_outbox_corrupt" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes.copyOfRange(1, 13)))
        val array = JSONArray(String(cipher.doFinal(bytes.copyOfRange(13, bytes.size)), Charsets.UTF_8))
        require(array.length() <= MAX_PENDING) { "diagnostic_outbox_corrupt" }
        return array
    }

    private fun write(file: AtomicFile, key: SecretKey, array: JSONArray) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key)
        val bytes = byteArrayOf(1) + cipher.iv + cipher.doFinal(array.toString().toByteArray(Charsets.UTF_8))
        require(bytes.size <= 262_144) { "diagnostic_outbox_full" }
        val stream = file.startWrite()
        try { stream.write(bytes); file.finishWrite(stream) }
        catch (failure: Exception) { file.failWrite(stream); throw failure }
    }

    @Synchronized fun upload(context: Context, stopped: () -> Boolean): Boolean {
        val prefs = context.getSharedPreferences("geops_agent_identity", Context.MODE_PRIVATE)
        val deviceId = prefs.getString("device_id", null) ?: return false
        val installationId = prefs.getString("installation_id", null) ?: return false
        val keyId = prefs.getString("key_id", null) ?: return false
        val key = AndroidKeys.existingStateKey(AgentRuntime.STATE_ALIAS)
        val file = file(context, installationId)
        val queue = read(file, key)
        val sync = context.getSharedPreferences("geops_diagnostic_sync", Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        if (!stopped() && queue.length() < MAX_PENDING) {
            val report = LocalDiagnostics.collect(context)
            val state = JSONObject(report.telemetry.toString()).apply { remove("observed_at") }
            val fingerprint = MessageDigest.getInstance("SHA-256")
                .digest(state.toString().toByteArray(Charsets.UTF_8))
                .joinToString("") { "%02x".format(it.toInt() and 0xff) }
            val lastAt = sync.getLong("last_queued_at", 0L)
            val installationChanged = sync.getString("installation_id", null) != installationId
            if (installationChanged || (now - lastAt >= MIN_CHANGE_MS &&
                (fingerprint != sync.getString("last_fingerprint", null) || now - lastAt >= REFRESH_MS))) {
                val sequence = sync.getLong("sequence", 0L) + 1
                check(sync.edit().putLong("sequence", sequence).commit())
                val payload = JSONObject(report.telemetry.toString())
                    .put("installation_id", installationId)
                    .put("boot_id", AgentRuntime.currentBootId(context))
                    .put("sequence", sequence)
                queue.put(payload.toString())
                write(file, key, queue)
                check(sync.edit().putLong("last_queued_at", now)
                    .putString("last_fingerprint", fingerprint)
                    .putString("installation_id", installationId).commit())
            }
        }
        if (queue.length() == 0 || stopped()) return false
        val signer = AndroidKeys.existingEnrollmentSigner(AgentRuntime.SIGNING_ALIAS)
        val session = RefreshingSessionProvider(deviceId, keyId, signer,
            HttpsEnrollmentTransport(SYNTHETIC_STAGING_BASE_URL))
        val http = PopHttpClient(SYNTHETIC_STAGING_BASE_URL, session,
            AndroidKeys.existingSigningKey(AgentRuntime.SIGNING_ALIAS, keyId),
            AndroidAgentClock(context) { AgentRuntime.currentBootId(context) })
        while (queue.length() > 0 && !stopped()) {
            val response = http.request("POST", PATH, queue.getString(0))
            if (response.status !in 200..299) return response.status == 429 || response.status >= 500
            val remaining = JSONArray()
            for (index in 1 until queue.length()) remaining.put(queue.getString(index))
            write(file, key, remaining)
            for (index in queue.length() - 1 downTo 0) queue.remove(index)
            for (index in 0 until remaining.length()) queue.put(remaining.getString(index))
        }
        return queue.length() > 0
    }
}
