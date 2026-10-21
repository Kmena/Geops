package com.geops.agent

/** Upload-only loop. It has no policy engine, service, listener or location provider. */
enum class UploadStatus { EMPTY, PENDING, AUTH_REQUIRED, IDENTITY_MISMATCH }

data class UploadResult(val status: UploadStatus, val nextDelayMs: Long = 0)

class PendingUpload(
    private val identity: Identity,
    private val store: AgentStore,
    private val clock: AgentClock,
    private val sync: BatchSync
) {
    fun run(maxBatches: Int = 12, shouldStop: () -> Boolean = { false }): UploadResult {
        require(maxBatches in 1..100)
        val initial = store.read()
        if (initial.uploadAuthBlocked) return UploadResult(UploadStatus.AUTH_REQUIRED)
        val snapshot = initial.snapshot ?: return UploadResult(UploadStatus.IDENTITY_MISMATCH)
        if (snapshot.identity != identity) return UploadResult(UploadStatus.IDENTITY_MISMATCH)
        val oldest = initial.pending.filter { !it.quarantined }.minOfOrNull { it.createdAtMs }
            ?: return UploadResult(UploadStatus.EMPTY)
        val intervalMs = (snapshot.policy?.syncIntervalS ?: 300) * 1000L
        val waitMs = oldest + intervalMs - clock.read().wallMs
        if (waitMs > 0) return UploadResult(UploadStatus.PENDING, waitMs)
        var processed = 0
        while (processed < maxBatches && !shouldStop()) {
            var progressed = false
            for (kind in listOf(RecordKind.SESSION, RecordKind.LOCATION, RecordKind.HEALTH)) {
                if (processed >= maxBatches || shouldStop()) break
                val current = store.read()
                if (current.snapshot?.identity != identity) return UploadResult(UploadStatus.IDENTITY_MISMATCH)
                if (current.uploadAuthBlocked) return UploadResult(UploadStatus.AUTH_REQUIRED)
                when (sync.once(kind)) {
                    SyncOutcome.ACKED, SyncOutcome.QUARANTINED -> { progressed = true; processed++ }
                    SyncOutcome.AUTH_REQUIRED -> {
                        store.update { it.uploadAuthBlocked = true }
                        return UploadResult(UploadStatus.AUTH_REQUIRED)
                    }
                    else -> Unit
                }
            }
            if (!progressed) break
        }
        val now = clock.read().wallMs
        val pending = store.read().pending.filter { !it.quarantined }
        if (pending.isEmpty()) return UploadResult(UploadStatus.EMPTY)
        val due = pending.minOf { it.retryAfterMs }
        return UploadResult(UploadStatus.PENDING, (due - now).coerceAtLeast(0))
    }
}
