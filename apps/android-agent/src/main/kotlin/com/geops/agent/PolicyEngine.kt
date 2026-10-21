package com.geops.agent

import java.util.UUID
import kotlin.math.abs
import kotlin.math.min

data class Identity(val deviceId: String, val installationId: String)
data class Window(val scheduledSessionId: String, val startMs: Long, val endMs: Long)
data class Policy(
    val id: String, val revision: Int, val captureIntervalS: Int, val syncIntervalS: Int,
    val validFromMs: Long, val validUntilMs: Long,
    // GPS-HEALTH-001 proposed delta. 300 s is a synthetic default until SDD approval.
    val healthIntervalS: Int = 300
)
data class Snapshot(
    val identity: Identity, val assignmentVersion: Long, val active: Boolean,
    val anchorId: String, val serverTimeMs: Long, val verifiedAtMs: Long,
    val offlineNotAfterMs: Long, val windows: List<Window>, val policy: Policy?
)
data class ClockReading(val wallMs: Long, val elapsedMs: Long, val bootId: String)
interface AgentClock { fun read(): ClockReading }

/** The transport must enforce TLS, short bearer, GEOPS-REQ-V1 PoP and strict wire schema. */
interface AuthenticatedConfigTransport { fun fetch(identity: Identity): Snapshot }

data class AuthorizedWindow(val snapshot: Snapshot, val window: Window, val nowMs: Long)
data class PolicyAssessment(val window: AuthorizedWindow?, val reason: DiagnosticReason)

class PolicyEngine(
    private val identity: Identity, private val clock: AgentClock, private val store: AgentStore
) {
    fun refresh(transport: AuthenticatedConfigTransport, beforeApply: (Snapshot) -> Unit = {}): Snapshot {
        val before = clock.read()
        val incoming = transport.fetch(identity)
        val after = clock.read()
        require(before.bootId == after.bootId && after.elapsedMs >= before.elapsedMs) { "boot_changed" }
        require(after.elapsedMs - before.elapsedMs <= 30_000L) { "snapshot_rtt_exceeded" }
        validate(incoming)
        val old = store.read()
        // A new installation must not relabel unsent ciphertext from an earlier identity.
        require(old.snapshot == null || old.snapshot!!.identity == incoming.identity ||
            old.pending.isEmpty()) { "pending_foreign_identity" }
        require(incoming.assignmentVersion >= old.highestAssignmentVersion) { "assignment_downgrade" }
        if (incoming.assignmentVersion == old.highestAssignmentVersion && old.snapshot != null) {
            require(incoming.active == old.snapshot!!.active && incoming.policy == old.snapshot!!.policy) {
                "same_version_conflict"
            }
        }
        // A future window in the response is not online validation of that future instance.
        val onlineWindow = incoming.windows.firstOrNull { incoming.serverTimeMs >= it.startMs &&
            incoming.serverTimeMs < it.endMs }
        val validated = if (incoming.active && incoming.policy != null && onlineWindow != null &&
            incoming.serverTimeMs >= incoming.policy.validFromMs &&
            incoming.serverTimeMs < incoming.policy.validUntilMs &&
            incoming.serverTimeMs < incoming.offlineNotAfterMs)
            ValidatedInstance(onlineWindow.scheduledSessionId, onlineWindow.startMs, onlineWindow.endMs,
                incoming.assignmentVersion, incoming.policy.revision, incoming.anchorId) else null
        beforeApply(incoming)
        store.update { state ->
            require(incoming.assignmentVersion >= state.highestAssignmentVersion) { "assignment_downgrade" }
            state.highestAssignmentVersion = incoming.assignmentVersion
            state.snapshot = incoming
            state.anchorElapsedMs = after.elapsedMs
            state.anchorBootId = after.bootId
            state.validatedInstance = validated
        }
        return incoming
    }

    fun current(): AuthorizedWindow? = assess().window

    /** A system recreation is limited to the user-started, online-validated work instance. */
    fun mayRecover(intent: TrackingIntent): Boolean {
        val state = store.read()
        val allowed = assess().window ?: return false
        return intent.installationId == identity.installationId &&
            intent == state.trackingIntent &&
            intent.bootId == clock.read().bootId &&
            intent.instance == state.validatedInstance &&
            intent.instance.scheduledId == allowed.window.scheduledSessionId &&
            intent.instance.startMs == allowed.window.startMs &&
            intent.instance.endMs == allowed.window.endMs &&
            intent.requestedAtMs >= intent.instance.startMs &&
            intent.requestedAtMs < intent.instance.endMs
    }

    /** Reports why authorization failed without changing the existing authorization predicate. */
    fun assess(): PolicyAssessment {
        fun denied(reason: DiagnosticReason) = PolicyAssessment(null, reason)
        val state = store.read()
        val s = state.snapshot ?: return denied(DiagnosticReason.NO_SNAPSHOT)
        val p = s.policy ?: return denied(DiagnosticReason.NO_ACTIVE_POLICY)
        val reading = clock.read()
        if (!s.active) return denied(DiagnosticReason.NO_ACTIVE_POLICY)
        if (s.identity != identity) return denied(DiagnosticReason.IDENTITY_MISMATCH)
        if (state.anchorBootId != reading.bootId) return denied(DiagnosticReason.BOOT_CHANGED)
        if (s.assignmentVersion < state.highestAssignmentVersion) return denied(DiagnosticReason.ASSIGNMENT_DOWNGRADE)
        if (reading.elapsedMs < state.anchorElapsedMs) return denied(DiagnosticReason.MONOTONIC_ROLLBACK)
        val delta = reading.elapsedMs - state.anchorElapsedMs
        if (delta > 12 * 3_600_000L) return denied(DiagnosticReason.OFFLINE_EXPIRED)
        val now = safeAdd(s.serverTimeMs, delta) ?: return denied(DiagnosticReason.CLOCK_INVALID)
        if (abs(reading.wallMs.toDouble() - now.toDouble()) > 300_000.0) return denied(DiagnosticReason.CLOCK_DRIFT)
        if (now < s.verifiedAtMs) return denied(DiagnosticReason.CLOCK_INVALID)
        if (now < p.validFromMs) return denied(DiagnosticReason.POLICY_NOT_YET_VALID)
        val offlineEnd = min(s.offlineNotAfterMs,
            safeAdd(s.verifiedAtMs, 12 * 3_600_000L) ?: return denied(DiagnosticReason.CLOCK_INVALID))
        if (now >= offlineEnd) return denied(if (s.windows.any { it.endMs == offlineEnd && now >= it.endMs })
            DiagnosticReason.WINDOW_ENDED else DiagnosticReason.OFFLINE_EXPIRED)
        if (now >= p.validUntilMs) return denied(DiagnosticReason.POLICY_EXPIRED)
        val window = s.windows.firstOrNull { now >= it.startMs && now < it.endMs }
            ?: return denied(DiagnosticReason.OUTSIDE_WINDOW)
        val validated = state.validatedInstance
        if (validated == null || validated.scheduledId != window.scheduledSessionId ||
            validated.startMs != window.startMs || validated.endMs != window.endMs ||
            validated.assignmentVersion != s.assignmentVersion ||
            validated.policyRevision != p.revision || validated.anchorId != s.anchorId)
            return denied(DiagnosticReason.INSTANCE_NOT_ONLINE_VERIFIED)
        return PolicyAssessment(AuthorizedWindow(s, window, now), DiagnosticReason.NONE)
    }

    fun anchoredTime(reading: ClockReading): Long? {
        val state = store.read()
        val s = state.snapshot ?: return null
        if (state.anchorBootId != reading.bootId || reading.elapsedMs < state.anchorElapsedMs) return null
        return safeAdd(s.serverTimeMs, reading.elapsedMs - state.anchorElapsedMs)
    }

    fun anchorElapsedMs(): Long = store.read().anchorElapsedMs
    fun snapshot(): Snapshot? = store.read().snapshot

    private fun validate(s: Snapshot) {
        require(s.identity == identity && uuid(s.identity.deviceId) && uuid(s.identity.installationId)) { "identity_mismatch" }
        require(s.assignmentVersion >= 0 && uuid(s.anchorId)) { "invalid_assignment" }
        require(s.verifiedAtMs <= s.serverTimeMs && s.offlineNotAfterMs > s.verifiedAtMs) { "invalid_anchor" }
        require(s.offlineNotAfterMs - s.verifiedAtMs <= 12 * 3_600_000L) { "offline_ttl_exceeded" }
        require(s.windows.size <= 64 && s.windows.all {
            uuid(it.scheduledSessionId) && it.startMs < it.endMs &&
                it.endMs <= s.serverTimeMs + 7 * 86_400_000L
        }) { "invalid_windows" }
        if (s.active) {
            val p = requireNotNull(s.policy) { "missing_policy" }
            require(uuid(p.id) && p.revision >= 1 && p.validFromMs < p.validUntilMs) { "invalid_policy" }
            require(p.captureIntervalS in 30..300 && p.syncIntervalS in 60..900 &&
                p.healthIntervalS in 60..3600) { "invalid_interval" }
            require(s.windows.zipWithNext().all { it.first.endMs <= it.second.startMs }) { "overlapping_windows" }
        } else require(s.policy == null && s.windows.isEmpty()) { "invalid_tombstone" }
    }
}

internal fun uuid(value: String): Boolean = try { UUID.fromString(value).toString() == value.lowercase() } catch (_: Exception) { false }
private fun safeAdd(a: Long, b: Long): Long? = try { Math.addExact(a, b) } catch (_: ArithmeticException) { null }
