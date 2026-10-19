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

class BatchSync(private val identity: Identity, private val store: AgentStore,
                private val clock: AgentClock, private val transport: BatchTransport) {
    @Synchronized fun once(kind: RecordKind): SyncOutcome {
        val now = clock.read().wallMs
        val pending = store.read().pending
        if (kind == RecordKind.LOCATION && pending.any { it.kind == RecordKind.SESSION &&
                !it.quarantined && JSONObject(it.payload).optString("type") == "STARTED" }) return SyncOutcome.PENDING
        val available = pending.filter { it.kind == kind && !it.quarantined && it.retryAfterMs <= now }
            .sortedWith(compareBy<PendingRecord> { it.createdAtMs }.thenBy { it.id })
        if (available.isEmpty()) return SyncOutcome.EMPTY
        val selected = mutableListOf<PendingRecord>()
        var body = ""
        for (record in available.take(100)) {
            val candidate = selected + record
            val next = encode(kind, candidate)
            val max = if (kind == RecordKind.LOCATION) 256 * 1024 else 128 * 1024
            if (next.toByteArray(StandardCharsets.UTF_8).size > max) {
                if (selected.isEmpty()) store.update { s -> s.pending.first { it.id == record.id }.quarantined = true }
                break
            }
            selected.add(record)
            body = next
        }
        if (selected.isEmpty()) return SyncOutcome.QUARANTINED
        val ids = selected.map { it.id }.toSet()
        val result = try { transport.post(kind, body) } catch (_: Exception) {
            retry(ids, now, null); return SyncOutcome.RETRY
        }
        when (result.status) {
            200 -> {
                val ack = try { JSONObject(result.body) } catch (_: Exception) { retry(ids, now, null); return SyncOutcome.RETRY }
                val batchId = batchId(kind, selected)
                if (ack.optString("batch_id") != batchId ||
                    runCatching { Instant.parse(ack.getString("persisted_at")) }.isFailure) {
                    retry(ids, now, null); return SyncOutcome.RETRY
                }
                val accepted = idsFrom(ack.optJSONArray("accepted_event_ids"))
                val duplicate = idsFrom(ack.optJSONArray("duplicate_event_ids"))
                if (accepted == null || duplicate == null || accepted.intersect(duplicate).isNotEmpty() ||
                    accepted.union(duplicate) != ids) { retry(ids, now, null); return SyncOutcome.RETRY }
                store.update { s -> s.pending.removeAll { it.id in ids } }
                return SyncOutcome.ACKED
            }
            202 -> { retry(ids, now, 30); return SyncOutcome.PENDING }
            401, 403 -> return SyncOutcome.AUTH_REQUIRED
            409 -> { store.update { s -> s.pending.filter { it.id in ids }.forEach { it.quarantined = true } }; return SyncOutcome.QUARANTINED }
            422 -> {
                val invalid = try { idsFrom(JSONObject(result.body).optJSONArray("invalid_event_ids")) } catch (_: Exception) { null }
                if (invalid == null || invalid.isEmpty() || !ids.containsAll(invalid)) {
                    retry(ids, now, null); return SyncOutcome.RETRY
                }
                store.update { s -> s.pending.filter { it.id in invalid }.forEach { it.quarantined = true } }
                return SyncOutcome.QUARANTINED
            }
            429 -> retry(ids, now, result.retryAfterSeconds?.coerceIn(1, 3600))
            else -> retry(ids, now, null)
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
