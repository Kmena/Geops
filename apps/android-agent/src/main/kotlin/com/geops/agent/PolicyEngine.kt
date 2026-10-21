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
/** Display only. Capture authorization always uses the server supplied UTC windows. */
data class PolicyDisplay(val name: String, val daysIso: List<Int>, val startLocal: String,
                         val endLocal: String, val timeZone: String)
data class Snapshot(
    val identity: Identity, val assignmentVersion: Long, val active: Boolean,
    val anchorId: String, val serverTimeMs: Long, val verifiedAtMs: Long,
    val offlineNotAfterMs: Long, val windows: List<Window>, val policy: Policy?,
    val display: PolicyDisplay? = null
)
data class ClockReading(val wallMs: Long, val elapsedMs: Long, val bootId: String)
interface AgentClock { fun read(): ClockReading }

/** The transport must enforce TLS, short bearer, GEOPS-REQ-V1 PoP and strict wire schema. */
interface AuthenticatedConfigTransport { fun fetch(identity: Identity): Snapshot }

data class AuthorizedWindow(val snapshot: Snapshot, val window: Window, val nowMs: Long)
data class PolicyEvaluation(val window: AuthorizedWindow?, val reason: String?)

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
        require(incoming.assignmentVersion >= old.highestAssignmentVersion) { "assignment_downgrade" }
        if (incoming.assignmentVersion == old.highestAssignmentVersion && old.snapshot != null) {
            require(incoming.active == old.snapshot!!.active && incoming.policy == old.snapshot!!.policy) {
                "same_version_conflict"
            }
        }
        beforeApply(incoming)
        store.update { state ->
            require(incoming.assignmentVersion >= state.highestAssignmentVersion) { "assignment_downgrade" }
            state.highestAssignmentVersion = incoming.assignmentVersion
            state.snapshot = incoming
            state.anchorElapsedMs = after.elapsedMs
            state.anchorBootId = after.bootId
        }
        return incoming
    }

    fun current(): AuthorizedWindow? = evaluate().window

    fun evaluate(): PolicyEvaluation {
        fun denied(reason: String) = PolicyEvaluation(null, reason)
        val state = store.read()
        val s = state.snapshot ?: return denied("NO_CONFIG")
        if (!s.active || s.policy == null) return denied("NO_ACTIVE_POLICY")
        val p = s.policy
        val reading = clock.read()
        if (s.identity != identity || s.assignmentVersion < state.highestAssignmentVersion)
            return denied("CONFIG_REPLACED")
        if (state.anchorBootId != reading.bootId || reading.elapsedMs < state.anchorElapsedMs)
            return denied("REBOOT_REQUIRES_REFRESH")
        val delta = reading.elapsedMs - state.anchorElapsedMs
        if (delta > 12 * 3_600_000L) return denied("CONFIG_EXPIRED")
        val now = safeAdd(s.serverTimeMs, delta) ?: return denied("CLOCK_INVALID")
        if (abs(reading.wallMs.toDouble() - now.toDouble()) > 300_000.0) return denied("CLOCK_DRIFT")
        if (now < s.verifiedAtMs) return denied("CLOCK_INVALID")
        if (now < p.validFromMs) return denied("POLICY_NOT_YET_VALID")
        val offlineEnd = min(s.offlineNotAfterMs,
            safeAdd(s.verifiedAtMs, 12 * 3_600_000L) ?: return denied("CLOCK_INVALID"))
        if (now >= offlineEnd) return denied("CONFIG_EXPIRED")
        if (now >= p.validUntilMs) return denied("POLICY_EXPIRED")
        val window = s.windows.firstOrNull { now >= it.startMs && now < it.endMs }
            ?: return denied("OUTSIDE_WINDOW")
        return PolicyEvaluation(AuthorizedWindow(s, window, now), null)
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
