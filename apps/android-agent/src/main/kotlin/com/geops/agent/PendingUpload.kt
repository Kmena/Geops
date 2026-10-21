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
            // Give v2 the first chance to commit STARTED with its positions atomically.
            // A v1-only backend then falls back to the per-session SESSION path.
            for (kind in listOf(RecordKind.LOCATION, RecordKind.SESSION, RecordKind.HEALTH)) {
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
        val due = sync.nextEligibleAtMs()
        return UploadResult(UploadStatus.PENDING,
            if (due == null) 15 * 60_000L else (due - now).coerceAtLeast(0))
    }
}
