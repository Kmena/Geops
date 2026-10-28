package com.geops.agent

import java.util.UUID
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import kotlin.math.abs
import kotlin.math.min

data class Identity(val deviceId: String, val installationId: String)
data class Window(val scheduledSessionId: String, val startMs: Long, val endMs: Long)
data class Policy(
    val id: String, val revision: Int, val captureIntervalS: Int, val syncIntervalS: Int,
    val validFromMs: Long, val validUntilMs: Long,
    // GPS-HEALTH-001 proposed delta. 300 s is a synthetic default until SDD approval.
    val healthIntervalS: Int = 300,
    val mdmContinuous: Boolean = false
)
data class PolicyException(val localDate: String, val mode: String,
                           val startLocal: String? = null, val endLocal: String? = null)
/** In v1 this is display-only; v2 authenticates these rules for local authorization. */
data class PolicyDisplay(val name: String, val daysIso: List<Int>, val startLocal: String,
                         val endLocal: String, val timeZone: String,
                         val exceptions: List<PolicyException> = emptyList())
data class Snapshot(
    val identity: Identity, val assignmentVersion: Long, val active: Boolean,
    val anchorId: String, val serverTimeMs: Long, val verifiedAtMs: Long,
    val offlineNotAfterMs: Long, val windows: List<Window>, val policy: Policy?,
    val display: PolicyDisplay? = null,
    val schemaVersion: Int = 1, val assignmentStartMs: Long? = null,
    val authorizedUntilMs: Long? = null, val tzdbVersion: String? = null
)
data class ClockReading(val wallMs: Long, val elapsedMs: Long, val bootId: String,
                        val automaticTimeEnabled: Boolean = true)
interface AgentClock { fun read(): ClockReading }

/** The transport must enforce TLS, short bearer, GEOPS-REQ-V1 PoP and strict wire schema. */
interface AuthenticatedConfigTransport { fun fetch(identity: Identity): Snapshot }

data class AuthorizedWindow(val snapshot: Snapshot, val window: Window, val nowMs: Long)
data class PolicyEvaluation(val window: AuthorizedWindow?, val reason: String?)
data class PolicyAssessment(val window: AuthorizedWindow?, val reason: DiagnosticReason)

class PolicyEngine(
    private val identity: Identity, private val clock: AgentClock, private val store: AgentStore,
    private val localTzdbVersion: (String) -> String? = { null }
) {
    fun refresh(transport: AuthenticatedConfigTransport, beforeApply: (Snapshot) -> Unit = {}): Snapshot {
        val before = clock.read()
        val incoming = transport.fetch(identity)
        val after = clock.read()
        return acceptFetched(incoming, before, after, beforeApply)
    }

    /** Apply under the capture lock after network I/O has completed outside it. */
    fun acceptFetched(incoming: Snapshot, before: ClockReading, after: ClockReading,
                      beforeApply: (Snapshot) -> Unit = {}): Snapshot {
        require(before.bootId == after.bootId && after.elapsedMs >= before.elapsedMs) { "boot_changed" }
        require(after.elapsedMs - before.elapsedMs <= 30_000L) { "snapshot_rtt_exceeded" }
        validate(incoming)
        val old = store.read()
        // A new installation must not relabel unsent ciphertext from an earlier identity.
        require(old.snapshot == null || old.snapshot!!.identity == incoming.identity ||
            old.pending.isEmpty()) { "pending_foreign_identity" }
        require(incoming.assignmentVersion >= old.highestAssignmentVersion) { "assignment_downgrade" }
        if (incoming.assignmentVersion == old.highestAssignmentVersion && old.snapshot != null) {
            val upgrade = old.snapshot!!.schemaVersion == 1 && incoming.schemaVersion == 2
            require(incoming.active == old.snapshot!!.active && incoming.policy == old.snapshot!!.policy &&
                (upgrade || (incoming.authorizedUntilMs == old.snapshot!!.authorizedUntilMs &&
                    incoming.display == old.snapshot!!.display))) {
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
            state.autonomousEnabled = incoming.schemaVersion == 2 && incoming.active
            state.anchorElapsedMs = after.elapsedMs
            state.anchorBootId = after.bootId
            state.validatedInstance = validated
            if (incoming.schemaVersion == 2) {
                state.timeBootId = after.bootId
                state.timeWallBaseMs = incoming.serverTimeMs
                state.timeElapsedBaseMs = after.elapsedMs
                state.lastEvaluatedMs = incoming.serverTimeMs
            }
        }
        return incoming
    }

    fun current(): AuthorizedWindow? = assess().window

    /** Compatibility view for local UI diagnostics; authorization is exclusively assess(). */
    fun evaluate(): PolicyEvaluation {
        val assessment = assess()
        val reason = when (assessment.reason) {
            DiagnosticReason.NONE -> null
            DiagnosticReason.NO_SNAPSHOT -> "NO_CONFIG"
            DiagnosticReason.OFFLINE_EXPIRED -> "CONFIG_EXPIRED"
            DiagnosticReason.WINDOW_ENDED -> "OUTSIDE_WINDOW"
            DiagnosticReason.BOOT_CHANGED, DiagnosticReason.MONOTONIC_ROLLBACK -> "REBOOT_REQUIRES_REFRESH"
            DiagnosticReason.IDENTITY_MISMATCH, DiagnosticReason.ASSIGNMENT_DOWNGRADE -> "CONFIG_REPLACED"
            else -> assessment.reason.name
        }
        return PolicyEvaluation(assessment.window, reason)
    }

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
        if (s.assignmentVersion < state.highestAssignmentVersion) return denied(DiagnosticReason.ASSIGNMENT_DOWNGRADE)
        if (s.schemaVersion == 2) return assessLocal(state, s, p, reading)
        if (state.anchorBootId != reading.bootId) return denied(DiagnosticReason.BOOT_CHANGED)
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
        if (s.schemaVersion == 2) return localTime(state, reading)
        if (state.anchorBootId != reading.bootId || reading.elapsedMs < state.anchorElapsedMs) return null
        return safeAdd(s.serverTimeMs, reading.elapsedMs - state.anchorElapsedMs)
    }

    fun anchorElapsedMs(): Long = store.read().let {
        if (it.snapshot?.schemaVersion == 2) it.timeElapsedBaseMs else it.anchorElapsedMs
    }
    fun snapshot(): Snapshot? = store.read().snapshot

    /** A valid v2 assignment can keep the visible service ready between local windows. */
    fun autonomousEligible(): Boolean {
        val state = store.read()
        val s = state.snapshot ?: return false
        if (!state.autonomousEnabled || state.uploadAuthBlocked || s.schemaVersion != 2 || !s.active ||
            s.identity != identity || s.assignmentVersion < state.highestAssignmentVersion ||
            s.policy == null) return false
        val now = localTime(state, clock.read()) ?: return false
        return now >= s.serverTimeMs - 30_000L && now < s.authorizedUntilMs!! &&
            now < s.policy.validUntilMs &&
            (sameTzdb(s) || s.windows.any { it.endMs > now && it.startMs < s.authorizedUntilMs })
    }

    private fun validate(s: Snapshot) {
        require(s.identity == identity && uuid(s.identity.deviceId) && uuid(s.identity.installationId)) { "identity_mismatch" }
        require(s.assignmentVersion >= 0 && uuid(s.anchorId)) { "invalid_assignment" }
        require(s.schemaVersion in 1..2 && s.verifiedAtMs <= s.serverTimeMs &&
            s.offlineNotAfterMs > s.verifiedAtMs) { "invalid_anchor" }
        if (s.schemaVersion == 1)
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
            if (s.schemaVersion == 2) {
                require(s.assignmentStartMs != null && s.assignmentStartMs <= s.serverTimeMs &&
                    s.authorizedUntilMs != null && s.authorizedUntilMs > s.serverTimeMs &&
                    s.authorizedUntilMs <= p.validUntilMs && s.display != null &&
                    s.tzdbVersion?.isNotBlank() == true) { "invalid_offline_authorization" }
                validateSchedule(s.display, p.mdmContinuous)
            }
        } else require(s.policy == null && s.windows.isEmpty()) { "invalid_tombstone" }
    }

    private fun assessLocal(state: AgentState, s: Snapshot, p: Policy,
                            reading: ClockReading): PolicyAssessment {
        fun denied(reason: DiagnosticReason) = PolicyAssessment(null, reason)
        val now = localTime(state, reading) ?: return denied(DiagnosticReason.CLOCK_INVALID)
        if (now < s.serverTimeMs - 30_000) return denied(DiagnosticReason.CLOCK_INVALID)
        if (now < p.validFromMs || now < (s.assignmentStartMs ?: Long.MAX_VALUE))
            return denied(DiagnosticReason.POLICY_NOT_YET_VALID)
        if (now >= p.validUntilMs || now >= (s.authorizedUntilMs ?: Long.MIN_VALUE))
            return denied(DiagnosticReason.POLICY_EXPIRED)
        // If the OS and server use different timezone data, only the exact UTC
        // windows delivered with the authenticated policy can authorize capture.
        val matchingTzdb = sameTzdb(s)
        val window = (if (matchingTzdb) localWindow(s, now) else
            s.windows.firstOrNull { it.startMs <= now && now < it.endMs })
            ?: return denied(if (matchingTzdb) DiagnosticReason.OUTSIDE_WINDOW else
                DiagnosticReason.TZDB_MISMATCH)
        if (now >= state.lastEvaluatedMs + 60_000L)
            store.update { if (now > it.lastEvaluatedMs) it.lastEvaluatedMs = now }
        return PolicyAssessment(AuthorizedWindow(s, window, now), DiagnosticReason.NONE)
    }

    private fun sameTzdb(s: Snapshot): Boolean {
        val zone = s.display?.timeZone ?: return false
        val localVersion = runCatching { localTzdbVersion(zone) }.getOrNull()
        return localVersion != null && localVersion == s.tzdbVersion
    }

    private fun localTime(state: AgentState, reading: ClockReading): Long? {
        if (!reading.automaticTimeEnabled) return null
        if (reading.bootId != state.timeBootId) {
            if (reading.wallMs < state.lastEvaluatedMs - 30_000L ||
                reading.wallMs < state.snapshot!!.serverTimeMs - 30_000L) return null
            store.update {
                it.timeBootId = reading.bootId
                it.timeWallBaseMs = reading.wallMs
                it.timeElapsedBaseMs = reading.elapsedMs
                it.lastEvaluatedMs = maxOf(it.lastEvaluatedMs, reading.wallMs)
            }
            return reading.wallMs
        }
        if (reading.elapsedMs < state.timeElapsedBaseMs) return null
        val now = safeAdd(state.timeWallBaseMs, reading.elapsedMs - state.timeElapsedBaseMs) ?: return null
        if (abs(reading.wallMs.toDouble() - now.toDouble()) > 300_000.0 ||
            now < state.lastEvaluatedMs - 30_000L) return null
        return now
    }

    private fun localWindow(s: Snapshot, now: Long): Window? {
        val rule = s.display ?: return null
        val zone = ZoneId.of(rule.timeZone)
        val date = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
        for (day in listOf(date.minusDays(1), date)) {
            val exception = rule.exceptions.firstOrNull { it.localDate == day.toString() }
            if (exception?.mode == "OFF" ||
                (exception == null && day.dayOfWeek.value !in rule.daysIso)) continue
            val startLocal = LocalTime.parse(exception?.startLocal ?: rule.startLocal)
            val endLocal = LocalTime.parse(exception?.endLocal ?: rule.endLocal)
            val start = resolveBoundary(day, startLocal, zone, false)
            val endDay = if (endLocal <= startLocal) day.plusDays(1) else day
            val end = resolveBoundary(endDay, endLocal, zone, true)
            val lower = maxOf(start, s.policy!!.validFromMs, s.assignmentStartMs!!)
            val upper = minOf(end, s.policy.validUntilMs, s.authorizedUntilMs!!)
            if (lower <= now && now < upper) {
                val seed = "${identity.deviceId}:${s.assignmentVersion}:${day}:${lower}:${upper}"
                return Window(UUID.nameUUIDFromBytes(seed.toByteArray(Charsets.UTF_8)).toString(), lower, upper)
            }
        }
        return null
    }

    private fun resolveBoundary(day: LocalDate, time: LocalTime, zone: ZoneId, end: Boolean): Long {
        val local = LocalDateTime.of(day, time)
        val offsets = zone.rules.getValidOffsets(local)
        return when {
            offsets.size == 2 -> local.atOffset(if (end) offsets[1] else offsets[0]).toInstant().toEpochMilli()
            offsets.size == 1 -> local.atOffset(offsets[0]).toInstant().toEpochMilli()
            // Match backend resolveLocal: a missing minute ends or starts at the
            // first valid local minute after the DST gap, not at time + gap length.
            else -> requireNotNull(zone.rules.getTransition(local)).instant.toEpochMilli()
        }
    }

    private fun validateSchedule(rule: PolicyDisplay, mdmContinuous: Boolean) {
        require(rule.daysIso.isNotEmpty() && rule.daysIso.size == rule.daysIso.toSet().size &&
            rule.daysIso.all { it in 1..7 } &&
            (if (mdmContinuous) rule.daysIso.toSet() == (1..7).toSet() &&
                rule.startLocal == "00:00" && rule.endLocal == "00:00" && rule.exceptions.isEmpty()
             else rule.startLocal != rule.endLocal)) { "invalid_schedule" }
        ZoneId.of(rule.timeZone)
        LocalTime.parse(rule.startLocal); LocalTime.parse(rule.endLocal)
        require(rule.exceptions.size <= 366 &&
            rule.exceptions.map { it.localDate }.toSet().size == rule.exceptions.size) { "invalid_exceptions" }
        rule.exceptions.forEach {
            LocalDate.parse(it.localDate)
            require(it.mode == "OFF" || it.mode == "REPLACE") { "invalid_exception" }
            if (it.mode == "REPLACE") {
                require(it.startLocal != null && it.endLocal != null && it.startLocal != it.endLocal) {
                    "invalid_exception" }
                LocalTime.parse(it.startLocal); LocalTime.parse(it.endLocal)
            } else require(it.startLocal == null && it.endLocal == null) { "invalid_exception" }
        }
    }
}

internal fun uuid(value: String): Boolean = try { UUID.fromString(value).toString() == value.lowercase() } catch (_: Exception) { false }
private fun safeAdd(a: Long, b: Long): Long? = try { Math.addExact(a, b) } catch (_: ArithmeticException) { null }
