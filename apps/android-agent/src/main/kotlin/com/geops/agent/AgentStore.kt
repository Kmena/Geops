package com.geops.agent

import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONArray
import org.json.JSONObject

enum class RecordKind { SESSION, LOCATION, HEALTH }
data class PendingRecord(
    val id: String, val kind: RecordKind, val payload: String, val createdAtMs: Long,
    var attempts: Int = 0, var retryAfterMs: Long = 0, var quarantined: Boolean = false,
    val wireVersion: Int = 2
)
data class LocalSession(
    val clientId: String, val scheduledId: String, val assignmentVersion: Long,
    val policyRevision: Int, val startedAtMs: Long, var state: String
)
/** Exact work instance observed in an authenticated online policy response. */
data class ValidatedInstance(
    val scheduledId: String, val startMs: Long, val endMs: Long,
    val assignmentVersion: Long, val policyRevision: Int, val anchorId: String
)
/** A user-started service may be recreated only for this validated instance. */
data class TrackingIntent(
    val installationId: String, val instance: ValidatedInstance,
    val requestedAtMs: Long, val bootId: String
)
data class AgentState(
    var snapshot: Snapshot? = null, var highestAssignmentVersion: Long = -1,
    var anchorElapsedMs: Long = -1, var anchorBootId: String? = null,
    var session: LocalSession? = null, val pending: MutableList<PendingRecord> = mutableListOf(),
    var lastLocationDueMs: Long = -1, var lastHealthDueMs: Long = -1,
    var lastStartAttemptAtMs: Long = -1,
    var locationsCaptured: Long = 0, var locationsAcked: Long = 0,
    var lastLocationCapturedMs: Long = -1, var lastLocationAckedMs: Long = -1,
    var validatedInstance: ValidatedInstance? = null,
    var trackingIntent: TrackingIntent? = null,
    var uploadAuthBlocked: Boolean = false,
    var timeBootId: String? = null, var timeWallBaseMs: Long = -1,
    var timeElapsedBaseMs: Long = -1, var lastEvaluatedMs: Long = -1,
    var bufferUsageBytes: Int = 0, var bufferAlertLevel: Int = 0,
    var autonomousEnabled: Boolean = false
)
interface AgentStore {
    fun read(): AgentState
    fun update(block: (AgentState) -> Unit)
}

/** Keep the replay floor per device and never mix queues from different installations. */
object AgentStateFiles {
    fun scoped(root: Path, identity: Identity): Path {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(identity.deviceId.toByteArray(Charsets.UTF_8))
        val chars = "0123456789abcdef"
        val suffix = buildString(digest.size * 2) {
            digest.forEach { byte ->
                append(chars[(byte.toInt() ushr 4) and 15])
                append(chars[byte.toInt() and 15])
            }
        }
        return root.resolve("agent-state-$suffix.bin")
    }

    fun resolve(root: Path, identity: Identity, key: SecretKey): Path {
        val scoped = scoped(root, identity)
        if (Files.exists(scoped)) {
            val state = EncryptedFileAgentStore(scoped, key).read()
            require(state.snapshot?.identity == identity ||
                (state.snapshot == null && state.highestAssignmentVersion < 0 &&
                    state.session == null && state.pending.isEmpty())) { "state_identity_mismatch" }
            return scoped
        }
        val legacy = root.resolve("agent-state.bin")
        if (!Files.exists(legacy)) return scoped
        // Never reset or reuse a legacy replay floor for an unrelated installation.
        val old = EncryptedFileAgentStore(legacy, key).read()
        if (old.snapshot?.identity == identity) return legacy
        require(old.snapshot?.identity?.deviceId != identity.deviceId) { "state_identity_mismatch" }
        require(old.snapshot != null ||
            (old.highestAssignmentVersion < 0 && old.session == null && old.pending.isEmpty())) {
            "legacy_state_identity_unknown"
        }
        return scoped
    }
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
    companion object {
        private val locks = ConcurrentHashMap<Path, Any>()
        const val MAX_BYTES = 32 * 1024 * 1024
        const val MAX_RECORDS = 10_000
        fun alertLevel(bytes: Int, records: Int): Int {
            val percent = maxOf(bytes.toLong() * 100 / MAX_BYTES,
                records.toLong() * 100 / MAX_RECORDS)
            return if (percent >= 90) 90 else if (percent >= 70) 70 else 0
        }
    }
    private val fileLock = locks.computeIfAbsent(file.toAbsolutePath().normalize()) { Any() }

    override fun read(): AgentState = synchronized(fileLock) { readFile() }

    private fun readFile(): AgentState {
        if (!Files.exists(file)) return AgentState()
        val bytes = Files.readAllBytes(file)
        require(bytes.size in 29..MAX_BYTES && bytes[0] == 1.toByte()) { "state_corrupt" }
        val nonce = bytes.copyOfRange(1, 13)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, nonce))
        cipher.updateAAD("GEOPS-AGENT-STATE-V1".toByteArray(Charsets.US_ASCII))
        return StateCodec.decode(String(cipher.doFinal(bytes.copyOfRange(13, bytes.size)), Charsets.UTF_8))
    }
    override fun update(block: (AgentState) -> Unit): Unit = synchronized(fileLock) {
        val next = readFile()
        block(next)
        require(next.pending.size <= MAX_RECORDS) { "queue_full" }
        var raw = StateCodec.encode(next).toByteArray(Charsets.UTF_8)
        next.bufferUsageBytes = raw.size + 29
        next.bufferAlertLevel = alertLevel(next.bufferUsageBytes, next.pending.size)
        raw = StateCodec.encode(next).toByteArray(Charsets.UTF_8)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        // AndroidKeyStore rejects caller-provided IVs for encryption. Let the provider
        // generate a fresh IV and retain the existing on-disk format for decryption.
        cipher.init(Cipher.ENCRYPT_MODE, key)
        val nonce = cipher.iv ?: error("state_iv_missing")
        require(nonce.size == 12) { "state_iv_size" }
        cipher.updateAAD("GEOPS-AGENT-STATE-V1".toByteArray(Charsets.US_ASCII))
        val sealed = byteArrayOf(1) + nonce + cipher.doFinal(raw)
        require(sealed.size <= MAX_BYTES) { "queue_bytes_full" }
        Files.createDirectories(file.parent)
        val tmp = Files.createTempFile(file.parent, ".agent-", ".tmp")
        try {
            FileOutputStream(tmp.toFile()).use { it.write(sealed); it.fd.sync() }
            Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        } finally { Files.deleteIfExists(tmp) }
        Unit
    }
}

internal object StateCodec {
    fun encode(s: AgentState): String {
        val o = JSONObject().put("schema", 1).put("highest", s.highestAssignmentVersion)
            .put("anchor_elapsed", s.anchorElapsedMs).put("anchor_boot", s.anchorBootId)
            .put("last_location_due", s.lastLocationDueMs).put("last_health_due", s.lastHealthDueMs)
            .put("last_start_attempt", s.lastStartAttemptAtMs)
            .put("locations_captured", s.locationsCaptured).put("locations_acked", s.locationsAcked)
            .put("last_location_captured", s.lastLocationCapturedMs)
            .put("last_location_acked", s.lastLocationAckedMs)
            .put("upload_auth_blocked", s.uploadAuthBlocked)
            .put("time_boot", s.timeBootId).put("time_wall_base", s.timeWallBaseMs)
            .put("time_elapsed_base", s.timeElapsedBaseMs).put("last_evaluated", s.lastEvaluatedMs)
            .put("buffer_bytes", s.bufferUsageBytes).put("buffer_alert", s.bufferAlertLevel)
            .put("autonomous_enabled", s.autonomousEnabled)
        s.snapshot?.let { v ->
            val snap = JSONObject().put("device", v.identity.deviceId).put("installation", v.identity.installationId)
                .put("version", v.assignmentVersion).put("active", v.active).put("anchor", v.anchorId)
                .put("server_time", v.serverTimeMs).put("verified", v.verifiedAtMs)
                .put("offline_end", v.offlineNotAfterMs).put("contract", v.schemaVersion)
                .put("assignment_start", v.assignmentStartMs)
                .put("authorized_until", v.authorizedUntilMs).put("tzdb", v.tzdbVersion)
            val windows = JSONArray()
            v.windows.forEach { windows.put(JSONObject().put("id", it.scheduledSessionId).put("start", it.startMs).put("end", it.endMs)) }
            snap.put("windows", windows)
            v.policy?.let { p -> snap.put("policy", JSONObject().put("id", p.id).put("revision", p.revision)
                .put("capture", p.captureIntervalS).put("sync", p.syncIntervalS).put("health", p.healthIntervalS)
                .put("from", p.validFromMs).put("until", p.validUntilMs)) }
            v.display?.let { d -> snap.put("display", JSONObject().put("name", d.name)
                .put("days", JSONArray().also { a -> d.daysIso.forEach(a::put) })
                .put("start", d.startLocal).put("end", d.endLocal).put("zone", d.timeZone)
                .put("exceptions", JSONArray().also { array -> d.exceptions.forEach { ex ->
                    array.put(JSONObject().put("date", ex.localDate).put("mode", ex.mode)
                        .put("start", ex.startLocal).put("end", ex.endLocal))
                } })) }
            o.put("snapshot", snap)
        }
        s.session?.let { o.put("session", JSONObject().put("id", it.clientId).put("scheduled", it.scheduledId)
            .put("version", it.assignmentVersion).put("revision", it.policyRevision)
            .put("started", it.startedAtMs).put("state", it.state)) }
        s.validatedInstance?.let { o.put("validated_instance", encodeInstance(it)) }
        s.trackingIntent?.let { o.put("tracking_intent", JSONObject()
            .put("installation", it.installationId).put("instance", encodeInstance(it.instance))
            .put("requested", it.requestedAtMs).put("boot", it.bootId)) }
        val pending = JSONArray()
        s.pending.forEach { pending.put(JSONObject().put("id", it.id).put("kind", it.kind.name)
            .put("payload", it.payload).put("created", it.createdAtMs).put("attempts", it.attempts)
            .put("retry", it.retryAfterMs).put("quarantined", it.quarantined)
            .put("wire_version", it.wireVersion)) }
        o.put("pending", pending)
        return o.toString()
    }

    fun decode(raw: String): AgentState {
        val o = JSONObject(raw)
        require(o.getInt("schema") == 1) { "state_schema" }
        val s = AgentState(highestAssignmentVersion = o.getLong("highest"), anchorElapsedMs = o.getLong("anchor_elapsed"),
            anchorBootId = o.optString("anchor_boot").takeUnless { it.isEmpty() || it == "null" },
            lastLocationDueMs = o.getLong("last_location_due"), lastHealthDueMs = o.getLong("last_health_due"),
            lastStartAttemptAtMs = o.optLong("last_start_attempt", -1),
            locationsCaptured = o.optLong("locations_captured", 0), locationsAcked = o.optLong("locations_acked", 0),
            lastLocationCapturedMs = o.optLong("last_location_captured", -1),
            lastLocationAckedMs = o.optLong("last_location_acked", -1),
            uploadAuthBlocked = o.optBoolean("upload_auth_blocked", false),
            timeBootId = o.optString("time_boot").takeUnless { it.isEmpty() || it == "null" },
            timeWallBaseMs = o.optLong("time_wall_base", -1),
            timeElapsedBaseMs = o.optLong("time_elapsed_base", -1),
            lastEvaluatedMs = o.optLong("last_evaluated", -1),
            bufferUsageBytes = o.optInt("buffer_bytes", 0),
            bufferAlertLevel = o.optInt("buffer_alert", 0),
            autonomousEnabled = o.optBoolean("autonomous_enabled", false))
        o.optJSONObject("snapshot")?.let { v ->
            val windows = v.getJSONArray("windows")
            val list = (0 until windows.length()).map { i -> windows.getJSONObject(i).let {
                Window(it.getString("id"), it.getLong("start"), it.getLong("end")) } }
            val p = v.optJSONObject("policy")?.let { Policy(it.getString("id"), it.getInt("revision"),
                it.getInt("capture"), it.getInt("sync"), it.getLong("from"), it.getLong("until"), it.getInt("health")) }
            val display = v.optJSONObject("display")?.let { d ->
                val days = d.getJSONArray("days")
                val exceptions = d.optJSONArray("exceptions")
                PolicyDisplay(d.getString("name"), (0 until days.length()).map(days::getInt),
                    d.getString("start"), d.getString("end"), d.getString("zone"),
                    if (exceptions == null) emptyList() else (0 until exceptions.length()).map { i ->
                        exceptions.getJSONObject(i).let { ex -> PolicyException(ex.getString("date"),
                            ex.getString("mode"), ex.optString("start").takeUnless { it.isEmpty() || it == "null" },
                            ex.optString("end").takeUnless { it.isEmpty() || it == "null" }) }
                    })
            }
            s.snapshot = Snapshot(Identity(v.getString("device"), v.getString("installation")), v.getLong("version"),
                v.getBoolean("active"), v.getString("anchor"), v.getLong("server_time"), v.getLong("verified"),
                v.getLong("offline_end"), list, p, display, v.optInt("contract", 1),
                v.optLong("assignment_start").takeIf { v.has("assignment_start") && !v.isNull("assignment_start") },
                v.optLong("authorized_until").takeIf { v.has("authorized_until") && !v.isNull("authorized_until") },
                v.optString("tzdb").takeUnless { it.isEmpty() || it == "null" })
        }
        o.optJSONObject("session")?.let { s.session = LocalSession(it.getString("id"), it.getString("scheduled"),
            it.getLong("version"), it.getInt("revision"), it.getLong("started"), it.getString("state")) }
        s.validatedInstance = o.optJSONObject("validated_instance")?.let(::decodeInstance)
        s.trackingIntent = o.optJSONObject("tracking_intent")?.let {
            TrackingIntent(it.getString("installation"), decodeInstance(it.getJSONObject("instance")),
                it.getLong("requested"), it.getString("boot")) }
        val pending = o.getJSONArray("pending")
        require(pending.length() <= EncryptedFileAgentStore.MAX_RECORDS) { "queue_corrupt" }
        for (i in 0 until pending.length()) pending.getJSONObject(i).let { s.pending.add(PendingRecord(
            it.getString("id"), RecordKind.valueOf(it.getString("kind")), it.getString("payload"),
            it.getLong("created"), it.getInt("attempts"), it.getLong("retry"), it.getBoolean("quarantined"),
            it.optInt("wire_version", 2).also { version -> require(version in 2..3) { "queue_protocol" } })) }
        return s
    }

    private fun encodeInstance(v: ValidatedInstance) = JSONObject().put("scheduled", v.scheduledId)
        .put("start", v.startMs).put("end", v.endMs).put("version", v.assignmentVersion)
        .put("revision", v.policyRevision).put("anchor", v.anchorId)

    private fun decodeInstance(v: JSONObject) = ValidatedInstance(v.getString("scheduled"),
        v.getLong("start"), v.getLong("end"), v.getLong("version"),
        v.getInt("revision"), v.getString("anchor"))
}
