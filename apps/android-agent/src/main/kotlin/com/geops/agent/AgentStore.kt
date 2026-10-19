package com.geops.agent

import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.io.FileOutputStream
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONArray
import org.json.JSONObject

enum class RecordKind { SESSION, LOCATION, HEALTH }
data class PendingRecord(
    val id: String, val kind: RecordKind, val payload: String, val createdAtMs: Long,
    var attempts: Int = 0, var retryAfterMs: Long = 0, var quarantined: Boolean = false
)
data class LocalSession(
    val clientId: String, val scheduledId: String, val assignmentVersion: Long,
    val policyRevision: Int, val startedAtMs: Long, var state: String
)
data class AgentState(
    var snapshot: Snapshot? = null, var highestAssignmentVersion: Long = -1,
    var anchorElapsedMs: Long = -1, var anchorBootId: String? = null,
    var session: LocalSession? = null, val pending: MutableList<PendingRecord> = mutableListOf(),
    var lastLocationDueMs: Long = -1, var lastHealthDueMs: Long = -1,
    var lastStartAttemptAtMs: Long = -1
)
interface AgentStore {
    fun read(): AgentState
    fun update(block: (AgentState) -> Unit)
}

class MemoryAgentStore : AgentStore {
    private var state = AgentState()
    @Synchronized override fun read(): AgentState = StateCodec.decode(StateCodec.encode(state))
    @Synchronized override fun update(block: (AgentState) -> Unit) {
        val next = read()
        block(next)
        state = next
    }
}

/** A key must come from AndroidKeyStore in production. Missing/corrupt key fails closed. */
class EncryptedFileAgentStore(private val file: Path, private val key: SecretKey) : AgentStore {
    private val random = SecureRandom()
    @Synchronized override fun read(): AgentState {
        if (!Files.exists(file)) return AgentState()
        val bytes = Files.readAllBytes(file)
        require(bytes.size in 29..4_000_000 && bytes[0] == 1.toByte()) { "state_corrupt" }
        val nonce = bytes.copyOfRange(1, 13)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, nonce))
        cipher.updateAAD("GEOPS-AGENT-STATE-V1".toByteArray(Charsets.US_ASCII))
        return StateCodec.decode(String(cipher.doFinal(bytes.copyOfRange(13, bytes.size)), Charsets.UTF_8))
    }
    @Synchronized override fun update(block: (AgentState) -> Unit) {
        val next = read()
        block(next)
        require(next.pending.size <= 10_000) { "queue_full" }
        val nonce = ByteArray(12).also(random::nextBytes)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, nonce))
        cipher.updateAAD("GEOPS-AGENT-STATE-V1".toByteArray(Charsets.US_ASCII))
        val sealed = byteArrayOf(1) + nonce + cipher.doFinal(StateCodec.encode(next).toByteArray(Charsets.UTF_8))
        require(sealed.size <= 4_000_000) { "queue_bytes_full" }
        Files.createDirectories(file.parent)
        val tmp = Files.createTempFile(file.parent, ".agent-", ".tmp")
        try {
            FileOutputStream(tmp.toFile()).use { it.write(sealed); it.fd.sync() }
            try { Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE) }
            catch (_: java.nio.file.AtomicMoveNotSupportedException) {
                Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING)
            }
        } finally { Files.deleteIfExists(tmp) }
    }
}

internal object StateCodec {
    fun encode(s: AgentState): String {
        val o = JSONObject().put("schema", 1).put("highest", s.highestAssignmentVersion)
            .put("anchor_elapsed", s.anchorElapsedMs).put("anchor_boot", s.anchorBootId)
            .put("last_location_due", s.lastLocationDueMs).put("last_health_due", s.lastHealthDueMs)
            .put("last_start_attempt", s.lastStartAttemptAtMs)
        s.snapshot?.let { v ->
            val snap = JSONObject().put("device", v.identity.deviceId).put("installation", v.identity.installationId)
                .put("version", v.assignmentVersion).put("active", v.active).put("anchor", v.anchorId)
                .put("server_time", v.serverTimeMs).put("verified", v.verifiedAtMs)
                .put("offline_end", v.offlineNotAfterMs)
            val windows = JSONArray()
            v.windows.forEach { windows.put(JSONObject().put("id", it.scheduledSessionId).put("start", it.startMs).put("end", it.endMs)) }
            snap.put("windows", windows)
            v.policy?.let { p -> snap.put("policy", JSONObject().put("id", p.id).put("revision", p.revision)
                .put("capture", p.captureIntervalS).put("sync", p.syncIntervalS).put("health", p.healthIntervalS)
                .put("from", p.validFromMs).put("until", p.validUntilMs)) }
            o.put("snapshot", snap)
        }
        s.session?.let { o.put("session", JSONObject().put("id", it.clientId).put("scheduled", it.scheduledId)
            .put("version", it.assignmentVersion).put("revision", it.policyRevision)
            .put("started", it.startedAtMs).put("state", it.state)) }
        val pending = JSONArray()
        s.pending.forEach { pending.put(JSONObject().put("id", it.id).put("kind", it.kind.name)
            .put("payload", it.payload).put("created", it.createdAtMs).put("attempts", it.attempts)
            .put("retry", it.retryAfterMs).put("quarantined", it.quarantined)) }
        o.put("pending", pending)
        return o.toString()
    }

    fun decode(raw: String): AgentState {
        val o = JSONObject(raw)
        require(o.getInt("schema") == 1) { "state_schema" }
        val s = AgentState(highestAssignmentVersion = o.getLong("highest"), anchorElapsedMs = o.getLong("anchor_elapsed"),
            anchorBootId = o.optString("anchor_boot").takeUnless { it.isEmpty() || it == "null" },
            lastLocationDueMs = o.getLong("last_location_due"), lastHealthDueMs = o.getLong("last_health_due"),
            lastStartAttemptAtMs = o.optLong("last_start_attempt", -1))
        o.optJSONObject("snapshot")?.let { v ->
            val windows = v.getJSONArray("windows")
            val list = (0 until windows.length()).map { i -> windows.getJSONObject(i).let {
                Window(it.getString("id"), it.getLong("start"), it.getLong("end")) } }
            val p = v.optJSONObject("policy")?.let { Policy(it.getString("id"), it.getInt("revision"),
                it.getInt("capture"), it.getInt("sync"), it.getLong("from"), it.getLong("until"), it.getInt("health")) }
            s.snapshot = Snapshot(Identity(v.getString("device"), v.getString("installation")), v.getLong("version"),
                v.getBoolean("active"), v.getString("anchor"), v.getLong("server_time"), v.getLong("verified"),
                v.getLong("offline_end"), list, p)
        }
        o.optJSONObject("session")?.let { s.session = LocalSession(it.getString("id"), it.getString("scheduled"),
            it.getLong("version"), it.getInt("revision"), it.getLong("started"), it.getString("state")) }
        val pending = o.getJSONArray("pending")
        require(pending.length() <= 10_000) { "queue_corrupt" }
        for (i in 0 until pending.length()) pending.getJSONObject(i).let { s.pending.add(PendingRecord(
            it.getString("id"), RecordKind.valueOf(it.getString("kind")), it.getString("payload"),
            it.getLong("created"), it.getInt("attempts"), it.getLong("retry"), it.getBoolean("quarantined"))) }
        return s
    }
}
