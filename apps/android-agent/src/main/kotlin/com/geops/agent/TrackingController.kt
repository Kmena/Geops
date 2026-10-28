package com.geops.agent

import java.util.UUID
import org.json.JSONObject

/** Production implementation must make the notification visible and register location before returning true. */
interface TrackingRuntime {
    fun startVisibleAndRegister(intervalSeconds: Int): Boolean
    /** Remove the listener while retaining the already-promoted foreground service. */
    fun pauseCapture() { stopAndUnregister() }
    fun stopAndUnregister()
    fun isRegistered(): Boolean
}
enum class LocationDecision { SAVED, NO_WINDOW, NO_SESSION, SERVICE_STOPPED, SESSION_CHANGED,
    INVALID_TIME, INVALID_FIX, WAITING_INTERVAL }
data class LocationFix(val latitude: Double, val longitude: Double, val accuracyM: Double,
                       val reading: ClockReading, val receivedAtMs: Long? = null)
data class HealthObservation(
    val batteryPercent: Int?, val charging: Boolean?, val plugged: Boolean?,
    val powerSave: Boolean?, val providerAvailable: Boolean?, val networkAvailable: Boolean?
)
interface HealthProbe { fun observe(): HealthObservation }

class TrackingController(
    private val identity: Identity, private val clock: AgentClock, private val policy: PolicyEngine,
    private val store: AgentStore, private val runtime: TrackingRuntime, private val health: HealthProbe,
    private val diagnostics: DiagnosticRecorder = NoopDiagnostics,
    private val onPendingQueued: () -> Unit = {}
) {
    private var lastWindowObservation: Triple<Long?, Long?, DiagnosticReason>? = null

    fun refreshConfig(transport: AuthenticatedConfigTransport): Snapshot {
        try {
            val beforeFetch = clock.read()
            val incomingSnapshot = transport.fetch(identity)
            val afterFetch = clock.read()
            return synchronized(this) {
            val snapshot = policy.acceptFetched(incomingSnapshot, beforeFetch, afterFetch) { incoming ->
                val before = store.read()
                val current = before.session
                val old = before.snapshot
                val changed = old == null || old.assignmentVersion != incoming.assignmentVersion ||
                    old.active != incoming.active || old.policy != incoming.policy ||
                    (incoming.schemaVersion == 1 && old.windows != incoming.windows) ||
                    incoming.authorizedUntilMs != old.authorizedUntilMs ||
                    (incoming.schemaVersion == 1 && incoming.offlineNotAfterMs < old.offlineNotAfterMs)
                if (current != null && current.state == "RUNNING" && changed) {
                    stop(if (incoming.active) "POLICY_REPLACED" else "POLICY_REVOKED", keepService = true)
                    store.update { it.lastStartAttemptAtMs = -1; it.lastStartAttemptBootId = null }
                }
            }
            diagnostics.recordSafely(DiagnosticEvent(DiagnosticKind.POLICY_RECEIVED, clock.read().wallMs,
                assignmentVersion = snapshot.assignmentVersion, policyRevision = snapshot.policy?.revision,
                windowStartMs = snapshot.windows.firstOrNull()?.startMs,
                windowEndMs = snapshot.windows.firstOrNull()?.endMs))
            snapshot
            }
        } catch (failure: Exception) {
            diagnostics.recordSafely(DiagnosticEvent(DiagnosticKind.POLICY_REFRESH_FAILED, clock.read().wallMs,
                DiagnosticReason.CONFIG_REQUEST_FAILED))
            throw failure
        }
    }

    @Synchronized fun tick() {
        val assessment = policy.assess()
        val allowed = assessment.window
        val observation = Triple(allowed?.snapshot?.assignmentVersion,
            allowed?.window?.startMs, assessment.reason)
        if (observation != lastWindowObservation) {
            lastWindowObservation = observation
            diagnostics.recordSafely(DiagnosticEvent(
                if (allowed == null) DiagnosticKind.WINDOW_LEFT else DiagnosticKind.WINDOW_ENTERED,
                clock.read().wallMs, assessment.reason,
                assignmentVersion = allowed?.snapshot?.assignmentVersion,
                policyRevision = allowed?.snapshot?.policy?.revision,
                windowStartMs = allowed?.window?.startMs, windowEndMs = allowed?.window?.endMs))
        }
        val existing = store.read().session
        val seamlessMdmRollover = existing?.state == "RUNNING" && allowed != null &&
            allowed.snapshot.policy?.mdmContinuous == true && runtime.isRegistered() &&
            existing.assignmentVersion == allowed.snapshot.assignmentVersion &&
            existing.scheduledId != allowed.window.scheduledSessionId
        if (existing != null && existing.state == "RUNNING" &&
            (allowed == null || existing.assignmentVersion != allowed.snapshot.assignmentVersion ||
                existing.scheduledId != allowed.window.scheduledSessionId || !runtime.isRegistered())) {
            stop(if (allowed == null) "WINDOW_END" else if (!runtime.isRegistered()) "UNKNOWN" else "POLICY_REPLACED",
                keepService = policy.snapshot()?.schemaVersion == 2,
                keepCapture = seamlessMdmRollover)
        }
        if (allowed == null) return
        val current = store.read().session
        if (current == null || current.state == "UNKNOWN_END") start(allowed, seamlessMdmRollover)
        sampleHealth(allowed)
    }

    private fun start(allowed: AuthorizedWindow, reuseListener: Boolean = false) {
        val reading = clock.read()
        val state = store.read()
        // elapsedRealtime is reset on physical reboot. A cooldown from another boot
        // cannot defer the first authorized STARTED on this boot.
        if (!reuseListener && state.lastStartAttemptBootId == reading.bootId && state.lastStartAttemptAtMs >= 0 &&
            reading.elapsedMs - state.lastStartAttemptAtMs < 60_000) return
        store.update { it.lastStartAttemptAtMs = reading.elapsedMs; it.lastStartAttemptBootId = reading.bootId }
        diagnostic("START_ATTEMPT", null, reading, allowed)
        val started = try { if (reuseListener && runtime.isRegistered()) true
            else runtime.startVisibleAndRegister(allowed.snapshot.policy!!.captureIntervalS) }
            catch (_: SecurityException) { false }
            catch (_: IllegalStateException) { false }
        if (!started || !runtime.isRegistered() || policy.current() == null) {
            if (allowed.snapshot.schemaVersion == 2) runtime.pauseCapture()
            else runtime.stopAndUnregister()
            diagnostic("MISSED_START", "FGS_START_BLOCKED", clock.read(), allowed)
            return
        }
        val client = UUID.randomUUID().toString()
        val startedReading = clock.read()
        val startedAt = policy.anchoredTime(startedReading) ?: run {
            if (allowed.snapshot.schemaVersion == 2) runtime.pauseCapture()
            else runtime.stopAndUnregister()
            return
        }
        val session = LocalSession(client, allowed.window.scheduledSessionId,
            allowed.snapshot.assignmentVersion, allowed.snapshot.policy!!.revision, startedAt, "RUNNING")
        try {
            val event = sessionEvent("STARTED", null, startedReading, allowed.snapshot, session)
            store.update { it.session = session; it.pending.add(event) }
            diagnostics.recordSafely(DiagnosticEvent(DiagnosticKind.QUEUE_INSERTED, clock.read().wallMs,
                assignmentVersion = session.assignmentVersion, policyRevision = session.policyRevision,
                recordKind = RecordKind.SESSION, count = 1))
            notifyPending(RecordKind.SESSION)
        } catch (e: Exception) {
            if (allowed.snapshot.schemaVersion == 2) runtime.pauseCapture()
            else runtime.stopAndUnregister()
            throw e
        }
    }

    @Synchronized fun onLocation(fix: LocationFix): Boolean = onLocationDecision(fix) == DiagnosticReason.NONE

    /** Re-register a stale provider without inventing a new fix or session. */
    @Synchronized fun recoverListener(): Boolean {
        val allowed = policy.current() ?: return false
        val session = store.read().session ?: return false
        if (session.state != "RUNNING" || session.scheduledId != allowed.window.scheduledSessionId)
            return false
        runtime.pauseCapture()
        return runtime.startVisibleAndRegister(allowed.snapshot.policy!!.captureIntervalS)
    }

    /** Local UI compatibility; the detailed decision and authorization live in onLocationDecision. */
    @Synchronized fun onLocationResult(fix: LocationFix): LocationDecision = when (val reason = onLocationDecision(fix)) {
        DiagnosticReason.NONE -> LocationDecision.SAVED
        DiagnosticReason.NO_SESSION -> LocationDecision.NO_SESSION
        DiagnosticReason.SERVICE_STOPPED -> LocationDecision.SERVICE_STOPPED
        DiagnosticReason.SESSION_CHANGED -> LocationDecision.SESSION_CHANGED
        DiagnosticReason.INVALID_FIX -> LocationDecision.INVALID_FIX
        DiagnosticReason.WAITING_INTERVAL -> LocationDecision.WAITING_INTERVAL
        DiagnosticReason.TIME_ANCHOR_INVALID, DiagnosticReason.TIME_BOOT_CHANGED,
        DiagnosticReason.TIME_BEFORE_SESSION, DiagnosticReason.TIME_BEFORE_WINDOW,
        DiagnosticReason.TIME_AFTER_WINDOW, DiagnosticReason.TIME_IN_FUTURE, DiagnosticReason.STALE_FIX,
        DiagnosticReason.TIME_BEFORE_POLICY, DiagnosticReason.TIME_AFTER_POLICY -> LocationDecision.INVALID_TIME
        else -> LocationDecision.NO_WINDOW
    }

    @Synchronized fun onLocationDecision(fix: LocationFix): DiagnosticReason {
        val receivedAt = fix.receivedAtMs ?: clock.read().wallMs
        val snapshot = policy.snapshot()
        val base = DiagnosticEvent(DiagnosticKind.CALLBACK_RECEIVED, receivedAt,
            fixAtMs = fix.reading.wallMs, receivedAtMs = receivedAt,
            assignmentVersion = snapshot?.assignmentVersion, policyRevision = snapshot?.policy?.revision)
        diagnostics.recordSafely(base)
        fun reject(reason: DiagnosticReason): DiagnosticReason {
            diagnostics.recordSafely(base.copy(kind = DiagnosticKind.CAPTURE_REJECTED, reason = reason))
            return reason
        }
        val assessment = policy.assess()
        val allowed = assessment.window ?: return reject(assessment.reason)
        val session = store.read().session ?: return reject(DiagnosticReason.NO_SESSION)
        if (session.state != "RUNNING" || !runtime.isRegistered()) return reject(DiagnosticReason.SERVICE_STOPPED)
        if (session.assignmentVersion != allowed.snapshot.assignmentVersion ||
            session.scheduledId != allowed.window.scheduledSessionId) return reject(DiagnosticReason.SESSION_CHANGED)
        if (fix.reading.bootId != clock.read().bootId) return reject(DiagnosticReason.TIME_BOOT_CHANGED)
        val captured = policy.anchoredTime(fix.reading) ?: return reject(DiagnosticReason.TIME_ANCHOR_INVALID)
        if (captured < session.startedAtMs) return reject(DiagnosticReason.TIME_BEFORE_SESSION)
        if (captured < allowed.window.startMs) return reject(DiagnosticReason.TIME_BEFORE_WINDOW)
        if (captured >= allowed.window.endMs) return reject(DiagnosticReason.TIME_AFTER_WINDOW)
        if (captured > allowed.nowMs) return reject(DiagnosticReason.TIME_IN_FUTURE)
        // Fused may deliver a batch after the fixes were acquired. Preserve the
        // original timestamp, but do not turn an old fix into a new capture.
        if (allowed.nowMs - captured > 120_000L) return reject(DiagnosticReason.STALE_FIX)
        if (captured < allowed.snapshot.policy!!.validFromMs) return reject(DiagnosticReason.TIME_BEFORE_POLICY)
        if (captured >= allowed.snapshot.policy.validUntilMs) return reject(DiagnosticReason.TIME_AFTER_POLICY)
        if (!fix.latitude.isFinite() || !fix.longitude.isFinite() || !fix.accuracyM.isFinite() ||
            fix.latitude !in -90.0..90.0 || fix.longitude !in -180.0..180.0 ||
            fix.accuracyM <= 0 || fix.accuracyM > 10_000) return reject(DiagnosticReason.INVALID_FIX)
        val minGap = allowed.snapshot.policy.captureIntervalS * 1000L
        if (store.read().lastLocationDueMs >= 0 && captured - store.read().lastLocationDueMs < minGap)
            return reject(DiagnosticReason.WAITING_INTERVAL)
        val id = UUID.randomUUID().toString()
        val priorBufferAlert = store.read().bufferAlertLevel
        val payload = JSONObject().put("event_id", id).put("client_session_id", session.clientId)
            .put("assignment_version", session.assignmentVersion).put("captured_at", utc(captured))
            .put("latitude", fix.latitude).put("longitude", fix.longitude).put("accuracy_m", fix.accuracyM)
            .put("boot_id", fix.reading.bootId).put("anchor_elapsed_realtime_ms", policy.anchorElapsedMs())
            .put("elapsed_realtime_ms", fix.reading.elapsedMs).put("capture_anchor_id", allowed.snapshot.anchorId)
        try {
            store.update {
                it.pending.add(PendingRecord(id, RecordKind.LOCATION, payload.toString(), captured,
                    wireVersion = if (allowed.snapshot.schemaVersion == 2) 3 else 2))
                it.lastLocationDueMs = captured
                it.lastLocationCapturedMs = captured
                it.locationsCaptured++
            }
        } catch (failure: Exception) {
            reject(DiagnosticReason.BUFFER_UNAVAILABLE)
            throw failure
        }
        diagnostics.recordSafely(base.copy(kind = DiagnosticKind.CAPTURE_ACCEPTED,
            assignmentVersion = session.assignmentVersion, policyRevision = session.policyRevision,
            windowStartMs = allowed.window.startMs, windowEndMs = allowed.window.endMs))
        diagnostics.recordSafely(DiagnosticEvent(DiagnosticKind.QUEUE_INSERTED, receivedAt,
            assignmentVersion = session.assignmentVersion, policyRevision = session.policyRevision,
            recordKind = RecordKind.LOCATION, count = 1))
        val bufferAlert = store.read().bufferAlertLevel
        if (bufferAlert > priorBufferAlert)
            diagnostics.recordSafely(DiagnosticEvent(DiagnosticKind.BUFFER_ALERT, receivedAt,
                recordKind = RecordKind.LOCATION, count = bufferAlert))
        notifyPending(RecordKind.LOCATION)
        return DiagnosticReason.NONE
    }

    private fun sampleHealth(allowed: AuthorizedWindow) {
        // The v1 health endpoint requires the original same-boot time anchor.
        // Keep v2 capture independent until the health contract is versioned.
        if (allowed.snapshot.schemaVersion == 2) return
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
        diagnostics.recordSafely(DiagnosticEvent(DiagnosticKind.QUEUE_INSERTED, clock.read().wallMs,
            assignmentVersion = allowed.snapshot.assignmentVersion,
            policyRevision = allowed.snapshot.policy.revision, recordKind = RecordKind.HEALTH, count = 1))
        notifyPending(RecordKind.HEALTH)
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

    @Synchronized fun stop(reason: String, keepService: Boolean = false,
                           keepCapture: Boolean = false) {
        val s = store.read().session ?: return
        if (!keepCapture) {
            if (keepService) runtime.pauseCapture() else runtime.stopAndUnregister()
        }
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
        diagnostics.recordSafely(DiagnosticEvent(DiagnosticKind.QUEUE_INSERTED, clock.read().wallMs,
            assignmentVersion = session.assignmentVersion, policyRevision = session.policyRevision,
            recordKind = RecordKind.SESSION, count = 1))
        notifyPending(RecordKind.SESSION)
    }

    private fun diagnostic(type: String, reason: String?, reading: ClockReading, allowed: AuthorizedWindow) {
        val id = UUID.randomUUID().toString()
        val payload = JSONObject().put("event_id", id).put("type", type)
            .put("occurred_at", utc(allowed.nowMs)).put("assignment_version", allowed.snapshot.assignmentVersion)
            .put("boot_id", reading.bootId).put("elapsed_realtime_ms", reading.elapsedMs)
            .put("reason_code", reason)
        store.update { it.pending.add(PendingRecord(id, RecordKind.SESSION, payload.toString(), allowed.nowMs)) }
        diagnostics.recordSafely(DiagnosticEvent(DiagnosticKind.QUEUE_INSERTED, clock.read().wallMs,
            assignmentVersion = allowed.snapshot.assignmentVersion,
            policyRevision = allowed.snapshot.policy?.revision, recordKind = RecordKind.SESSION, count = 1))
        notifyPending(RecordKind.SESSION)
    }

    private fun notifyPending(kind: RecordKind) {
        runCatching(onPendingQueued).onFailure {
            diagnostics.recordSafely(DiagnosticEvent(DiagnosticKind.SYNC_RETRY,
                clock.read().wallMs, DiagnosticReason.SCHEDULING_FAILED, recordKind = kind))
        }
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
        return PendingRecord(id, RecordKind.SESSION, payload.toString(), at,
            wireVersion = if (snapshot.schemaVersion == 2) 3 else 2)
    }
}

internal fun utc(ms: Long): String = java.time.Instant.ofEpochMilli(ms).toString()
