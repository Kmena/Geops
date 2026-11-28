package com.geops.agent

/** Closed diagnostic vocabulary. A configured permission is never assumed effective. */
enum class LocalDiagnosticState {
    GRANTED, DENIED, NOT_DECLARED, RESTRICTED, NOT_APPLICABLE, NOT_SUPPORTED, UNKNOWN
}

enum class GpsSummaryState {
    STOPPED_OBSERVED, OFFLINE, CAPTURE_STALE, CAPTURE_PENDING_UPLOAD,
    CAPTURE_ACK_OBSERVED, UNKNOWN
}

object LocalDiagnosticRules {
    fun gpsSummary(
        service: String?, internet: String?, intervalS: Int?, captureAtMs: Long?,
        ackAtMs: Long?, pending: Int?, nowMs: Long
    ): GpsSummaryState {
        if (service == "STOPPED_OBSERVED") return GpsSummaryState.STOPPED_OBSERVED
        if (internet == "OFFLINE") return GpsSummaryState.OFFLINE
        if (service != "RUNNING_OBSERVED" || intervalS == null || intervalS <= 0)
            return GpsSummaryState.UNKNOWN
        val capture = captureAtMs ?: return GpsSummaryState.CAPTURE_STALE
        val age = nowMs - capture
        if (age > intervalS * 3_000L) return GpsSummaryState.CAPTURE_STALE
        if (age < 0) return GpsSummaryState.UNKNOWN
        if (pending != null && pending > 0 && (ackAtMs == null || ackAtMs < capture))
            return GpsSummaryState.CAPTURE_PENDING_UPLOAD
        if (pending == 0 && ackAtMs != null && ackAtMs >= capture)
            return GpsSummaryState.CAPTURE_ACK_OBSERVED
        return GpsSummaryState.UNKNOWN
    }

    fun permission(
        declared: Boolean,
        applicable: Boolean,
        runtimeGranted: Boolean?,
        restricted: Boolean = false
    ): LocalDiagnosticState = when {
        !applicable -> LocalDiagnosticState.NOT_APPLICABLE
        !declared -> LocalDiagnosticState.NOT_DECLARED
        restricted -> LocalDiagnosticState.RESTRICTED
        runtimeGranted == null -> LocalDiagnosticState.UNKNOWN
        runtimeGranted -> LocalDiagnosticState.GRANTED
        else -> LocalDiagnosticState.DENIED
    }

    /** Absence of a live process is not proof that a foreground service was stopped. */
    fun service(liveRegistered: Boolean, lastEvent: DiagnosticKind?): String = when {
        liveRegistered -> "RUNNING_OBSERVED"
        lastEvent == DiagnosticKind.FGS_DESTROYED ||
            lastEvent == DiagnosticKind.FGS_PROMOTION_FAILED -> "STOPPED_OBSERVED"
        else -> "UNKNOWN"
    }

    fun transmission(
        pending: Int,
        lastCapturedAtMs: Long?,
        lastAckAtMs: Long?
    ): String = when {
        pending > 0 && lastCapturedAtMs != null -> "CAPTURED_PENDING_TRANSMISSION"
        lastCapturedAtMs != null && lastAckAtMs != null ->
            "ACK_OBSERVED"
        else -> "UNKNOWN"
    }
}
