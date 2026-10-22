package com.geops.agent

import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.PosixFilePermission
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONArray
import org.json.JSONObject

/** Closed vocabulary: no coordinates, identifiers, HTTP bodies, tokens or free-form messages. */
enum class DiagnosticKind {
    FGS_START_COMMAND, FGS_PROMOTED, FGS_PROMOTION_FAILED, FGS_DESTROYED,
    LISTENER_REGISTERED, LISTENER_UNREGISTERED, PROVIDER_FUSED, PROVIDER_GPS,
    POLICY_RECEIVED, POLICY_REFRESH_FAILED, WINDOW_ENTERED, WINDOW_LEFT,
    CALLBACK_RECEIVED, CAPTURE_ACCEPTED, CAPTURE_REJECTED, QUEUE_INSERTED, BUFFER_ALERT,
    SYNC_ATTEMPT, SYNC_RETRY, SYNC_PENDING, SYNC_ACK, SYNC_QUARANTINE, SYNC_AUTH_REQUIRED,
    WINDOW_WAKE_SCHEDULED, WINDOW_WAKE_ATTEMPT, WINDOW_WAKE_DISPATCHED,
    WINDOW_WAKE_ACTIVE, WINDOW_WAKE_BLOCKED
}

enum class DiagnosticReason {
    NONE, NO_SNAPSHOT, NO_ACTIVE_POLICY, IDENTITY_MISMATCH, BOOT_CHANGED,
    ASSIGNMENT_DOWNGRADE, MONOTONIC_ROLLBACK, OFFLINE_EXPIRED, CLOCK_INVALID, TZDB_MISMATCH,
    CLOCK_DRIFT, POLICY_NOT_YET_VALID, POLICY_EXPIRED, OUTSIDE_WINDOW, WINDOW_ENDED,
    NO_SESSION, SERVICE_STOPPED, SESSION_CHANGED, TIME_ANCHOR_INVALID,
    TIME_BOOT_CHANGED, TIME_BEFORE_SESSION, TIME_BEFORE_WINDOW, TIME_AFTER_WINDOW,
    TIME_IN_FUTURE, TIME_BEFORE_POLICY, TIME_AFTER_POLICY, STALE_FIX, INVALID_FIX,
    WAITING_INTERVAL, BUFFER_UNAVAILABLE, CONFIG_REQUEST_FAILED, INSTANCE_NOT_ONLINE_VERIFIED, NETWORK,
    INVALID_ACK, SERVER_PENDING, RATE_LIMIT, SERVER_ERROR, AUTH_REJECTED,
    REJECTED_EVENTS, BACKOFF, WAITING_SESSION, SCHEDULING_FAILED,
    EXACT_ALARM_UNAVAILABLE, BACKGROUND_LOCATION_MISSING, FINE_LOCATION_MISSING,
    GPS_DISABLED, FGS_START_RESTRICTED, FGS_PERMISSION_DENIED, RECOVERY_FAILED,
    RECOVERY_NOT_AUTHORIZED, UNKNOWN
}

data class DiagnosticEvent(
    val kind: DiagnosticKind, val atMs: Long, val reason: DiagnosticReason = DiagnosticReason.NONE,
    val fixAtMs: Long? = null, val receivedAtMs: Long? = null,
    val assignmentVersion: Long? = null, val policyRevision: Int? = null,
    val windowStartMs: Long? = null, val windowEndMs: Long? = null,
    val recordKind: RecordKind? = null, val count: Int? = null
) {
    init {
        require(count == null || count in 0..10_000) { "diagnostic_count" }
        require(policyRevision == null || policyRevision >= 0) { "diagnostic_revision" }
    }
}

interface DiagnosticRecorder {
    fun record(event: DiagnosticEvent)
    fun recent(): List<DiagnosticEvent>
}

/** A re-enrollment cannot inherit another installation's local technical history. */
object DiagnosticFiles {
    fun scoped(root: Path, identity: Identity): Path {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest((identity.deviceId + ":" + identity.installationId).toByteArray(Charsets.UTF_8))
        val suffix = digest.take(12).joinToString("") { "%02x".format(it.toInt() and 0xff) }
        return root.resolve("diagnostics-$suffix.bin")
    }
}

data class DiagnosticSummary(
    val callbacks: Int, val accepted: Int, val rejected: Int,
    val pendingLocations: Int, val quarantinedLocations: Int,
    val lastFixAtMs: Long?, val lastCallbackAtMs: Long?,
    val lastAcceptedAtMs: Long?, val lastAckAtMs: Long?,
    val lastRejectReason: DiagnosticReason?, val lastServiceEvent: DiagnosticKind?,
    val lastSyncReason: DiagnosticReason?
)

/** Counts refer to the retained 24-hour journal; pending counts come from the encrypted GPS queue. */
fun summarizeDiagnostics(events: List<DiagnosticEvent>, pending: List<PendingRecord>): DiagnosticSummary {
    val callbacks = events.filter { it.kind == DiagnosticKind.CALLBACK_RECEIVED }
    val accepted = events.filter { it.kind == DiagnosticKind.CAPTURE_ACCEPTED }
    val rejected = events.filter { it.kind == DiagnosticKind.CAPTURE_REJECTED }
    val acknowledgements = events.filter { it.kind == DiagnosticKind.SYNC_ACK && it.recordKind == RecordKind.LOCATION }
    val service = events.lastOrNull { it.kind.name.startsWith("FGS_") || it.kind.name.startsWith("LISTENER_") }
    val sync = events.lastOrNull { it.kind.name.startsWith("SYNC_") }
    return DiagnosticSummary(callbacks.size, accepted.size, rejected.size,
        pending.count { it.kind == RecordKind.LOCATION && !it.quarantined },
        pending.count { it.kind == RecordKind.LOCATION && it.quarantined },
        callbacks.lastOrNull()?.fixAtMs, callbacks.lastOrNull()?.receivedAtMs,
        accepted.lastOrNull()?.atMs, acknowledgements.lastOrNull()?.atMs,
        rejected.lastOrNull()?.reason, service?.kind, sync?.reason)
}

object NoopDiagnostics : DiagnosticRecorder {
    override fun record(event: DiagnosticEvent) = Unit
    override fun recent(): List<DiagnosticEvent> = emptyList()
}

/** Uses an Android app-private, backup-excluded directory and an existing AndroidKeyStore key in production. */
class EncryptedDiagnosticJournal(
    private val file: Path, private val key: SecretKey,
    private val nowMs: () -> Long = System::currentTimeMillis
) : DiagnosticRecorder {
    private companion object {
        val locks = ConcurrentHashMap<Path, Any>()
    }
    private val fileLock = locks.computeIfAbsent(file.toAbsolutePath().normalize()) { Any() }
    private val aad = "GEOPS-DIAGNOSTICS-V1".toByteArray(Charsets.US_ASCII)
    private val retentionMs = 24 * 3_600_000L
    private val maxEvents = 256
    private val maxBytes = 128 * 1024

    override fun recent(): List<DiagnosticEvent> = synchronized(fileLock) {
        val all = readFile()
        val now = nowMs()
        val fresh = all.filter { it.atMs >= now - retentionMs && it.atMs <= now + 30_000L }
        if (fresh.size != all.size) {
            if (fresh.isEmpty()) Files.deleteIfExists(file) else writeFile(fresh)
        }
        fresh
    }

    override fun record(event: DiagnosticEvent) = synchronized(fileLock) {
        val now = nowMs()
        val events = (readFile().filter { it.atMs >= now - retentionMs && it.atMs <= now + 30_000L } + event)
            .takeLast(maxEvents)
        writeFile(events)
    }

    private fun writeFile(events: List<DiagnosticEvent>) {
        val array = JSONArray()
        events.forEach { e ->
            array.put(JSONObject().put("kind", e.kind.name).put("at", e.atMs)
                .put("reason", e.reason.name).put("fix_at", e.fixAtMs)
                .put("received_at", e.receivedAtMs).put("assignment", e.assignmentVersion)
                .put("revision", e.policyRevision).put("window_start", e.windowStartMs)
                .put("window_end", e.windowEndMs).put("record_kind", e.recordKind?.name)
                .put("count", e.count))
        }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key) // AndroidKeyStore must generate the IV.
        val iv = cipher.iv ?: error("diagnostic_iv_missing")
        require(iv.size == 12) { "diagnostic_iv_size" }
        cipher.updateAAD(aad)
        val bytes = byteArrayOf(1) + iv + cipher.doFinal(array.toString().toByteArray(Charsets.UTF_8))
        require(bytes.size <= maxBytes) { "diagnostic_bytes_full" }
        Files.createDirectories(file.parent)
        val temporary = Files.createTempFile(file.parent, ".geops-diagnostic-", ".tmp")
        try {
            try { Files.setPosixFilePermissions(temporary, setOf(
                PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE)) }
            catch (_: UnsupportedOperationException) { /* Android noBackupFilesDir remains app-private. */ }
            FileOutputStream(temporary.toFile()).use { it.write(bytes); it.fd.sync() }
            try { Files.move(temporary, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE) }
            catch (_: java.nio.file.AtomicMoveNotSupportedException) {
                Files.move(temporary, file, StandardCopyOption.REPLACE_EXISTING)
            }
        } finally { Files.deleteIfExists(temporary) }
    }

    private fun readFile(): List<DiagnosticEvent> {
        if (!Files.exists(file)) return emptyList()
        val bytes = Files.readAllBytes(file)
        require(bytes.size in 29..maxBytes && bytes[0] == 1.toByte()) { "diagnostic_corrupt" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes.copyOfRange(1, 13)))
        cipher.updateAAD(aad)
        val array = JSONArray(String(cipher.doFinal(bytes.copyOfRange(13, bytes.size)), Charsets.UTF_8))
        require(array.length() <= maxEvents) { "diagnostic_corrupt" }
        return (0 until array.length()).map { i ->
            val e = array.getJSONObject(i)
            DiagnosticEvent(DiagnosticKind.valueOf(e.getString("kind")), e.getLong("at"),
                DiagnosticReason.valueOf(e.getString("reason")), e.optLongOrNull("fix_at"),
                e.optLongOrNull("received_at"), e.optLongOrNull("assignment"),
                e.optIntOrNull("revision"), e.optLongOrNull("window_start"),
                e.optLongOrNull("window_end"), e.optString("record_kind").takeIf { it.isNotEmpty() }
                    ?.let(RecordKind::valueOf), e.optIntOrNull("count"))
        }
    }
}

private fun JSONObject.optLongOrNull(name: String): Long? = if (isNull(name)) null else getLong(name)
private fun JSONObject.optIntOrNull(name: String): Int? = if (isNull(name)) null else getInt(name)

/** Diagnostic failures cannot change capture authorization or ACK semantics. */
fun DiagnosticRecorder.recordSafely(event: DiagnosticEvent) {
    try { record(event) } catch (_: Exception) { /* Stored GPS events remain authoritative. */ }
}
