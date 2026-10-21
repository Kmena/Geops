package com.geops.agent

import java.nio.charset.StandardCharsets
import java.util.UUID
import java.time.Instant
import org.json.JSONArray
import org.json.JSONObject

interface BatchTransport { fun post(kind: RecordKind, body: String): HttpResult }

/** Health ingestion is a proposed SDD delta; disabled against current backend by default. */
class PopBatchTransport(private val http: PopHttpClient, private val healthContractApproved: Boolean = false) : BatchTransport {
    override fun post(kind: RecordKind, body: String): HttpResult {
        val path = when (kind) {
            RecordKind.SESSION -> "/v1/device/gps-session-events/batches"
            RecordKind.LOCATION -> "/v1/device/locations/batches"
            RecordKind.HEALTH -> if (healthContractApproved) "/v1/device/health/batches"
                else throw IllegalStateException("health_contract_pending")
        }
        return http.request("POST", path, body)
    }
}

enum class SyncOutcome { EMPTY, ACKED, PENDING, RETRY, QUARANTINED, AUTH_REQUIRED }
enum class SyncDetail { NONE, WAITING_SESSION, BACKOFF, NETWORK, INVALID_ACK, SERVER_PENDING,
    RATE_LIMIT, SERVER_ERROR, AUTH_REJECTED, REJECTED_EVENTS, ACKED }

class BatchSync(private val identity: Identity, private val store: AgentStore,
                private val clock: AgentClock, private val transport: BatchTransport,
                private val diagnostics: DiagnosticRecorder = NoopDiagnostics) {
    @Volatile var lastDetail: SyncDetail = SyncDetail.NONE
        private set
    private fun observe(kind: DiagnosticKind, record: RecordKind, count: Int,
                        reason: DiagnosticReason = DiagnosticReason.NONE) {
        diagnostics.recordSafely(DiagnosticEvent(kind, clock.read().wallMs, reason,
            recordKind = record, count = count))
    }

    @Synchronized fun once(kind: RecordKind): SyncOutcome {
        val now = clock.read().wallMs
        val pending = store.read().pending
        if (kind == RecordKind.LOCATION && pending.any { it.kind == RecordKind.SESSION &&
                !it.quarantined && JSONObject(it.payload).optString("type") == "STARTED" }) {
            lastDetail = SyncDetail.WAITING_SESSION
            observe(DiagnosticKind.SYNC_PENDING, kind, 0, DiagnosticReason.WAITING_SESSION)
            return SyncOutcome.PENDING
        }
        val available = pending.filter { it.kind == kind && !it.quarantined && it.retryAfterMs <= now }
            .sortedWith(compareBy<PendingRecord> { it.createdAtMs }.thenBy { it.id })
        if (available.isEmpty()) {
            lastDetail = if (pending.any { it.kind == kind && !it.quarantined && it.retryAfterMs > now })
                SyncDetail.BACKOFF else SyncDetail.NONE
            if (pending.any { it.kind == kind && !it.quarantined && it.retryAfterMs > now })
                observe(DiagnosticKind.SYNC_PENDING, kind, 0, DiagnosticReason.BACKOFF)
            return SyncOutcome.EMPTY
        }
        val selected = mutableListOf<PendingRecord>()
        var body = ""
        for (record in available.take(100)) {
            val candidate = selected + record
            val next = encode(kind, candidate)
            val max = if (kind == RecordKind.LOCATION) 256 * 1024 else 128 * 1024
            if (next.toByteArray(StandardCharsets.UTF_8).size > max) {
                if (selected.isEmpty()) {
                    store.update { s -> s.pending.first { it.id == record.id }.quarantined = true }
                    observe(DiagnosticKind.SYNC_QUARANTINE, kind, 1, DiagnosticReason.REJECTED_EVENTS)
                }
                break
            }
            selected.add(record)
            body = next
        }
        if (selected.isEmpty()) { lastDetail = SyncDetail.REJECTED_EVENTS; return SyncOutcome.QUARANTINED }
        val ids = selected.map { it.id }.toSet()
        observe(DiagnosticKind.SYNC_ATTEMPT, kind, ids.size)
        val result = try { transport.post(kind, body) } catch (failure: Exception) {
            if (failure.message in setOf("session_http_401", "session_http_403",
                    "session_challenge_http_401", "session_challenge_http_403")) {
                lastDetail = SyncDetail.AUTH_REJECTED
                observe(DiagnosticKind.SYNC_AUTH_REQUIRED, kind, ids.size, DiagnosticReason.AUTH_REJECTED)
                return SyncOutcome.AUTH_REQUIRED
            }
            lastDetail = SyncDetail.NETWORK
            observe(DiagnosticKind.SYNC_RETRY, kind, ids.size, DiagnosticReason.NETWORK)
            retry(ids, now, null); return SyncOutcome.RETRY
        }
        when (result.status) {
            200 -> {
                val ack = try { JSONObject(result.body) } catch (_: Exception) {
                    lastDetail = SyncDetail.INVALID_ACK
                    observe(DiagnosticKind.SYNC_RETRY, kind, ids.size, DiagnosticReason.INVALID_ACK)
                    retry(ids, now, null); return SyncOutcome.RETRY
                }
                val batchId = batchId(kind, selected)
                val persistedAt = runCatching { Instant.parse(ack.getString("persisted_at")).toEpochMilli() }.getOrNull()
                if (ack.optString("batch_id") != batchId || persistedAt == null) {
                    lastDetail = SyncDetail.INVALID_ACK
                    observe(DiagnosticKind.SYNC_RETRY, kind, ids.size, DiagnosticReason.INVALID_ACK)
                    retry(ids, now, null); return SyncOutcome.RETRY
                }
                val accepted = idsFrom(ack.optJSONArray("accepted_event_ids"))
                val duplicate = idsFrom(ack.optJSONArray("duplicate_event_ids"))
                if (accepted == null || duplicate == null || accepted.intersect(duplicate).isNotEmpty() ||
                    accepted.union(duplicate) != ids) {
                    lastDetail = SyncDetail.INVALID_ACK
                    observe(DiagnosticKind.SYNC_RETRY, kind, ids.size, DiagnosticReason.INVALID_ACK)
                    retry(ids, now, null); return SyncOutcome.RETRY
                }
                store.update { s ->
                    s.pending.removeAll { it.id in ids }
                    if (kind == RecordKind.LOCATION) {
                        s.locationsAcked += ids.size
                        s.lastLocationAckedMs = persistedAt
                    }
                }
                lastDetail = SyncDetail.ACKED
                observe(DiagnosticKind.SYNC_ACK, kind, ids.size)
                return SyncOutcome.ACKED
            }
            202 -> {
                lastDetail = SyncDetail.SERVER_PENDING
                observe(DiagnosticKind.SYNC_PENDING, kind, ids.size, DiagnosticReason.SERVER_PENDING)
                retry(ids, now, 30); return SyncOutcome.PENDING
            }
            401, 403 -> {
                lastDetail = SyncDetail.AUTH_REJECTED
                observe(DiagnosticKind.SYNC_AUTH_REQUIRED, kind, ids.size, DiagnosticReason.AUTH_REJECTED)
                return SyncOutcome.AUTH_REQUIRED
            }
            409 -> {
                lastDetail = SyncDetail.REJECTED_EVENTS
                store.update { s -> s.pending.filter { it.id in ids }.forEach { it.quarantined = true } }
                observe(DiagnosticKind.SYNC_QUARANTINE, kind, ids.size, DiagnosticReason.REJECTED_EVENTS)
                return SyncOutcome.QUARANTINED
            }
            422 -> {
                lastDetail = SyncDetail.REJECTED_EVENTS
                val invalid = try { idsFrom(JSONObject(result.body).optJSONArray("invalid_event_ids")) } catch (_: Exception) { null }
                if (invalid == null || invalid.isEmpty() || !ids.containsAll(invalid)) {
                    lastDetail = SyncDetail.INVALID_ACK
                    observe(DiagnosticKind.SYNC_RETRY, kind, ids.size, DiagnosticReason.INVALID_ACK)
                    retry(ids, now, null); return SyncOutcome.RETRY
                }
                store.update { s -> s.pending.filter { it.id in invalid }.forEach { it.quarantined = true } }
                observe(DiagnosticKind.SYNC_QUARANTINE, kind, invalid.size, DiagnosticReason.REJECTED_EVENTS)
                return SyncOutcome.QUARANTINED
            }
            429 -> {
                lastDetail = SyncDetail.RATE_LIMIT
                observe(DiagnosticKind.SYNC_RETRY, kind, ids.size, DiagnosticReason.RATE_LIMIT)
                retry(ids, now, result.retryAfterSeconds?.coerceIn(1, 3600))
            }
            else -> {
                lastDetail = SyncDetail.SERVER_ERROR
                observe(DiagnosticKind.SYNC_RETRY, kind, ids.size, DiagnosticReason.SERVER_ERROR)
                retry(ids, now, null)
            }
        }
        return SyncOutcome.RETRY
    }

    private fun retry(ids: Set<String>, now: Long, afterSeconds: Int?) {
        store.update { s -> s.pending.filter { it.id in ids }.forEach {
            it.attempts++
            val delay = afterSeconds?.times(1000L) ?: (1000L shl it.attempts.coerceAtMost(9)).coerceAtMost(900_000L)
            it.retryAfterMs = now + delay
        } }
    }
    private fun encode(kind: RecordKind, records: List<PendingRecord>): String {
        val events = JSONArray()
        records.forEach { events.put(JSONObject(it.payload)) }
        return JSONObject().put("schema_version", 1).put("batch_id", batchId(kind, records))
            .put("device_id", identity.deviceId).put("installation_id", identity.installationId)
            .put("events", events).toString()
    }
    private fun batchId(kind: RecordKind, records: List<PendingRecord>): String = UUID.nameUUIDFromBytes(
        (kind.name + ":" + records.joinToString(",") { it.id }).toByteArray(StandardCharsets.UTF_8)).toString()
    private fun idsFrom(array: JSONArray?): Set<String>? {
        if (array == null) return null
        val list = (0 until array.length()).map { array.optString(it) }
        if (list.any { !uuid(it) } || list.toSet().size != list.size) return null
        return list.toSet()
    }
}
