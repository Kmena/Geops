package com.geops.agent

import java.util.UUID
import org.json.JSONObject

/** Production implementation must make the notification visible and register location before returning true. */
interface TrackingRuntime {
    fun startVisibleAndRegister(intervalSeconds: Int): Boolean
    fun stopAndUnregister()
    fun isRegistered(): Boolean
}
data class LocationFix(val latitude: Double, val longitude: Double, val accuracyM: Double, val reading: ClockReading)
data class HealthObservation(
    val batteryPercent: Int?, val charging: Boolean?, val plugged: Boolean?,
    val powerSave: Boolean?, val providerAvailable: Boolean?, val networkAvailable: Boolean?
)
interface HealthProbe { fun observe(): HealthObservation }

class TrackingController(
    private val identity: Identity, private val clock: AgentClock, private val policy: PolicyEngine,
    private val store: AgentStore, private val runtime: TrackingRuntime, private val health: HealthProbe
) {
    @Synchronized fun refreshConfig(transport: AuthenticatedConfigTransport): Snapshot = policy.refresh(transport) { incoming ->
        val current = store.read().session
        if (current != null && (current.assignmentVersion != incoming.assignmentVersion || !incoming.active)) {
            stop(if (incoming.active) "POLICY_REPLACED" else "POLICY_REVOKED")
            store.update { it.lastStartAttemptAtMs = -1 }
        }
    }

    @Synchronized fun tick() {
        val allowed = policy.current()
        val existing = store.read().session
        if (existing != null && existing.state == "RUNNING" &&
            (allowed == null || existing.assignmentVersion != allowed.snapshot.assignmentVersion ||
                existing.scheduledId != allowed.window.scheduledSessionId || !runtime.isRegistered())) {
            stop(if (allowed == null) "WINDOW_END" else if (!runtime.isRegistered()) "UNKNOWN" else "POLICY_REPLACED")
        }
        if (allowed == null) return
        sampleHealth(allowed)
        val current = store.read().session
        if (current == null || current.state == "UNKNOWN_END") start(allowed)
    }

    private fun start(allowed: AuthorizedWindow) {
        val reading = clock.read()
        val state = store.read()
        if (state.lastStartAttemptAtMs >= 0 && reading.elapsedMs - state.lastStartAttemptAtMs < 60_000) return
        store.update { it.lastStartAttemptAtMs = reading.elapsedMs }
        diagnostic("START_ATTEMPT", null, reading, allowed)
        val started = try { runtime.startVisibleAndRegister(allowed.snapshot.policy!!.captureIntervalS) }
            catch (_: SecurityException) { false }
            catch (_: IllegalStateException) { false }
        if (!started || !runtime.isRegistered() || policy.current() == null) {
            runtime.stopAndUnregister()
            diagnostic("MISSED_START", "FGS_START_BLOCKED", clock.read(), allowed)
            return
        }
        val client = UUID.randomUUID().toString()
        val startedReading = clock.read()
        val startedAt = policy.anchoredTime(startedReading) ?: run { runtime.stopAndUnregister(); return }
        val session = LocalSession(client, allowed.window.scheduledSessionId,
            allowed.snapshot.assignmentVersion, allowed.snapshot.policy!!.revision, startedAt, "RUNNING")
        try {
            val event = sessionEvent("STARTED", null, startedReading, allowed.snapshot, session)
            store.update { it.session = session; it.pending.add(event) }
        } catch (e: Exception) { runtime.stopAndUnregister(); throw e }
    }

    @Synchronized fun onLocation(fix: LocationFix): Boolean {
        val allowed = policy.current() ?: return false
        val session = store.read().session ?: return false
        if (session.state != "RUNNING" || !runtime.isRegistered() ||
            session.assignmentVersion != allowed.snapshot.assignmentVersion ||
            session.scheduledId != allowed.window.scheduledSessionId) return false
        val captured = policy.anchoredTime(fix.reading) ?: return false
        if (fix.reading.bootId != clock.read().bootId || captured < session.startedAtMs ||
            captured < allowed.window.startMs ||
            captured >= allowed.window.endMs || captured > allowed.nowMs ||
            captured < allowed.snapshot.policy!!.validFromMs || captured >= allowed.snapshot.policy.validUntilMs) return false
        if (!fix.latitude.isFinite() || !fix.longitude.isFinite() || !fix.accuracyM.isFinite() ||
            fix.latitude !in -90.0..90.0 || fix.longitude !in -180.0..180.0 ||
            fix.accuracyM <= 0 || fix.accuracyM > 10_000) return false
        val minGap = allowed.snapshot.policy.captureIntervalS * 1000L
        if (store.read().lastLocationDueMs >= 0 && captured - store.read().lastLocationDueMs < minGap) return false
        val id = UUID.randomUUID().toString()
        val payload = JSONObject().put("event_id", id).put("client_session_id", session.clientId)
            .put("assignment_version", session.assignmentVersion).put("captured_at", utc(captured))
            .put("latitude", fix.latitude).put("longitude", fix.longitude).put("accuracy_m", fix.accuracyM)
            .put("boot_id", fix.reading.bootId).put("anchor_elapsed_realtime_ms", policy.anchorElapsedMs())
            .put("elapsed_realtime_ms", fix.reading.elapsedMs).put("capture_anchor_id", allowed.snapshot.anchorId)
        store.update { it.pending.add(PendingRecord(id, RecordKind.LOCATION, payload.toString(), captured)); it.lastLocationDueMs = captured }
        return true
    }

    private fun sampleHealth(allowed: AuthorizedWindow) {
        val interval = allowed.snapshot.policy!!.healthIntervalS * 1000L
        val previous = store.read().lastHealthDueMs
        if (previous >= 0 && allowed.nowMs - previous < interval) return
        val due = if (previous < allowed.window.startMs || previous < 0) allowed.window.startMs else previous + interval
        val reading = clock.read()
        val observedAt = policy.anchoredTime(reading) ?: return
        if (observedAt < allowed.window.startMs || observedAt >= allowed.window.endMs) return
        val h = health.observe()
        require(h.batteryPercent == null || h.batteryPercent in 0..100) { "invalid_battery" }
        val diagnosis = HealthDiagnosis.classify(h, runtime.isRegistered())
        val states = org.json.JSONArray().also { array -> diagnosis.forEach { array.put(it.name) } }
        val id = UUID.randomUUID().toString()
        val payload = JSONObject().put("event_id", id).put("device_id", identity.deviceId)
            .put("installation_id", identity.installationId).put("assignment_version", allowed.snapshot.assignmentVersion)
            .put("policy_revision", allowed.snapshot.policy.revision).put("due_at", utc(due))
            .put("observed_at", utc(observedAt)).put("battery_percent", h.batteryPercent)
            .put("boot_id", reading.bootId).put("capture_anchor_id", allowed.snapshot.anchorId)
            .put("anchor_elapsed_realtime_ms", policy.anchorElapsedMs())
            .put("elapsed_realtime_ms", reading.elapsedMs)
            .put("charging", h.charging).put("plugged", h.plugged).put("power_save", h.powerSave)
            .put("provider_available", h.providerAvailable).put("network_available", h.networkAvailable)
            .put("tracking_state", if (runtime.isRegistered()) "RUNNING" else "STOPPED")
            .put("observed_states", states)
        store.update { it.pending.add(PendingRecord(id, RecordKind.HEALTH, payload.toString(), observedAt)); it.lastHealthDueMs = due }
    }

    @Synchronized fun interrupt(reason: String) {
        val s = store.read().session ?: return
        if (s.state != "RUNNING") return
        runtime.stopAndUnregister()
        eventAndState("INTERRUPTED", reason, "INTERRUPTED", s)
    }

    @Synchronized fun resume(): Boolean {
        val s = store.read().session ?: return false
        val allowed = policy.current() ?: return false
        if (s.state != "INTERRUPTED" || s.assignmentVersion != allowed.snapshot.assignmentVersion ||
            s.scheduledId != allowed.window.scheduledSessionId) return false
        if (!runtime.startVisibleAndRegister(allowed.snapshot.policy!!.captureIntervalS) || !runtime.isRegistered()) return false
        eventAndState("RESUMED", null, "RUNNING", s)
        return true
    }

    @Synchronized fun stop(reason: String) {
        val s = store.read().session ?: return
        runtime.stopAndUnregister()
        if (s.state == "RUNNING" || s.state == "INTERRUPTED") {
            if (policy.anchoredTime(clock.read()) != null) eventAndState("STOPPED", reason, "STOPPED", s)
            else store.update { it.session?.state = "UNKNOWN_END" }
        }
        store.update { it.session = null }
    }

    /** A reboot/process death is not evidence that STOPPED was observed. */
    @Synchronized fun onProcessRestart() {
        runtime.stopAndUnregister()
        store.update { it.session?.state = "UNKNOWN_END" }
    }

    private fun eventAndState(type: String, reason: String?, next: String, session: LocalSession) {
        val snapshot = policy.snapshot() ?: return
        val event = sessionEvent(type, reason, clock.read(), snapshot, session)
        store.update { it.pending.add(event); it.session?.state = next }
    }

    private fun diagnostic(type: String, reason: String?, reading: ClockReading, allowed: AuthorizedWindow) {
        val id = UUID.randomUUID().toString()
        val payload = JSONObject().put("event_id", id).put("type", type)
            .put("occurred_at", utc(allowed.nowMs)).put("assignment_version", allowed.snapshot.assignmentVersion)
            .put("boot_id", reading.bootId).put("elapsed_realtime_ms", reading.elapsedMs)
            .put("reason_code", reason)
        store.update { it.pending.add(PendingRecord(id, RecordKind.SESSION, payload.toString(), allowed.nowMs)) }
    }

    private fun sessionEvent(type: String, reason: String?, reading: ClockReading,
                             snapshot: Snapshot, session: LocalSession): PendingRecord {
        val at = policy.anchoredTime(reading) ?: throw IllegalStateException("anchor_lost")
        val id = UUID.randomUUID().toString()
        val payload = JSONObject().put("event_id", id).put("client_session_id", session.clientId)
            .put("type", type).put("occurred_at", utc(at)).put("assignment_version", session.assignmentVersion)
            .put("boot_id", reading.bootId).put("elapsed_realtime_ms", reading.elapsedMs)
            .put("anchor_elapsed_realtime_ms", policy.anchorElapsedMs())
            .put("capture_anchor_id", snapshot.anchorId).put("reason_code", reason)
        if (type == "STARTED") payload.put("scheduled_session_id", session.scheduledId)
        return PendingRecord(id, RecordKind.SESSION, payload.toString(), at)
    }
}

internal fun utc(ms: Long): String = java.time.Instant.ofEpochMilli(ms).toString()
