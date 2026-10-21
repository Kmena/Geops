package com.geops.agent

import java.nio.charset.StandardCharsets
import java.util.UUID
import java.time.Instant
import org.json.JSONArray
import org.json.JSONObject

interface BatchTransport {
    fun post(kind: RecordKind, body: String): HttpResult
    fun supportsMixed(): Boolean = false
    fun postMixed(body: String): HttpResult = throw UnsupportedOperationException("mixed_not_supported")
    fun supportsOffline(): Boolean = false
    fun postOffline(body: String): HttpResult = throw UnsupportedOperationException("offline_not_supported")
}

/** Health ingestion is a proposed SDD delta; disabled against current backend by default. */
class PopBatchTransport(private val http: PopHttpClient, private val healthContractApproved: Boolean = false) : BatchTransport {
    override fun supportsMixed(): Boolean = true
    override fun postMixed(body: String): HttpResult = http.request("POST", "/v2/device/gps/batches", body)
    override fun supportsOffline(): Boolean = true
    override fun postOffline(body: String): HttpResult = http.request("POST", "/v3/device/gps/batches", body)
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
    private var mixedAvailable = transport.supportsMixed()
    private val offlineAvailable = transport.supportsOffline()

    /** Earliest useful retry, including the STARTED dependency of each session. */
    fun nextEligibleAtMs(): Long? {
        val pending = store.read().pending.filter { !it.quarantined }
        if (pending.isEmpty()) return null
        fun client(record: PendingRecord) = JSONObject(record.payload).optString("client_session_id")
        fun startFor(record: PendingRecord) = pending.firstOrNull { candidate ->
            candidate.kind == RecordKind.SESSION &&
                JSONObject(candidate.payload).optString("type") == "STARTED" &&
                client(candidate) == client(record)
        }
        return pending.mapNotNull { record ->
            when (record.kind) {
                RecordKind.HEALTH -> record.retryAfterMs
                RecordKind.SESSION -> if (record.wireVersion == 2 && mixedAvailable && pending.any {
                    it.kind == RecordKind.LOCATION && it.wireVersion == 2 && client(it) == client(record)
                }) null else record.retryAfterMs
                RecordKind.LOCATION -> {
                    val start = startFor(record)
                    if (start == null) record.retryAfterMs
                    else if (record.wireVersion == 3 || mixedAvailable)
                        maxOf(record.retryAfterMs, start.retryAfterMs)
                    else null // v1 must ACK STARTED first; its own retry determines wakeup.
                }
            }
        }.minOrNull()
    }
    private fun observe(kind: DiagnosticKind, record: RecordKind, count: Int,
                        reason: DiagnosticReason = DiagnosticReason.NONE) {
        diagnostics.recordSafely(DiagnosticEvent(kind, clock.read().wallMs, reason,
            recordKind = record, count = count))
    }

    @Synchronized fun once(kind: RecordKind): SyncOutcome {
        val now = clock.read().wallMs
        val pending = store.read().pending
        if ((kind == RecordKind.LOCATION || kind == RecordKind.SESSION) && offlineAvailable) {
            val offline = onceMixedLocations(pending, now, 3)
            if (offline != SyncOutcome.EMPTY) return offline
        }
        if (kind == RecordKind.LOCATION && mixedAvailable) return onceMixedLocations(pending, now, 2)
        val available = pending.filter { record ->
            record.kind == kind && record.wireVersion == 2 && !record.quarantined &&
                record.retryAfterMs <= now &&
                (kind != RecordKind.SESSION || !mixedAvailable || pending.none { location ->
                    location.kind == RecordKind.LOCATION && !location.quarantined &&
                        JSONObject(location.payload).optString("client_session_id") ==
                            JSONObject(record.payload).optString("client_session_id")
                }) &&
                (kind != RecordKind.LOCATION || pending.none { start ->
                    start.kind == RecordKind.SESSION && !start.quarantined &&
                        JSONObject(start.payload).optString("type") == "STARTED" &&
                        JSONObject(start.payload).optString("client_session_id") ==
                            JSONObject(record.payload).optString("client_session_id")
                })
        }
            .sortedWith(compareBy<PendingRecord> { it.createdAtMs }.thenBy { it.id })
        if (available.isEmpty()) {
            val waiting = kind == RecordKind.LOCATION && pending.any {
                it.kind == kind && !it.quarantined && it.retryAfterMs <= now
            }
            lastDetail = if (waiting) SyncDetail.WAITING_SESSION else if (pending.any {
                it.kind == kind && !it.quarantined && it.retryAfterMs > now
            }) SyncDetail.BACKOFF else SyncDetail.NONE
            if (lastDetail != SyncDetail.NONE)
                observe(DiagnosticKind.SYNC_PENDING, kind, 0,
                    if (waiting) DiagnosticReason.WAITING_SESSION else DiagnosticReason.BACKOFF)
            return if (waiting) SyncOutcome.PENDING else SyncOutcome.EMPTY
        }
        val firstClient = if (kind == RecordKind.HEALTH) "" else
            JSONObject(available.first().payload).optString("client_session_id")
        val grouped = if (kind == RecordKind.HEALTH) available else available.filter { record ->
            JSONObject(record.payload).optString("client_session_id") == firstClient
        }
        val selected = mutableListOf<PendingRecord>()
        var body = ""
        for (record in grouped.take(100)) {
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

    /** One local session per mixed batch; v3 also sends session-only changes. */
    private fun onceMixedLocations(pending: List<PendingRecord>, now: Long, version: Int): SyncOutcome {
        val due = pending.filter { it.wireVersion == version &&
            (it.kind == RecordKind.LOCATION || (version == 3 && it.kind == RecordKind.SESSION &&
                JSONObject(it.payload).optString("client_session_id").isNotEmpty())) && !it.quarantined &&
            it.retryAfterMs <= now }.sortedWith(compareBy<PendingRecord> { it.createdAtMs }.thenBy { it.id })
        val first = due.firstOrNull { location ->
            val clientId = JSONObject(location.payload).optString("client_session_id")
            pending.none { start -> start.wireVersion == version && start.kind == RecordKind.SESSION &&
                (start.quarantined || start.retryAfterMs > now) &&
                JSONObject(start.payload).optString("type") == "STARTED" &&
                JSONObject(start.payload).optString("client_session_id") == clientId }
        }
        if (first == null) {
            val waiting = due.any { location -> pending.any { start ->
                start.wireVersion == version && start.kind == RecordKind.SESSION && start.quarantined &&
                    JSONObject(start.payload).optString("type") == "STARTED" &&
                    JSONObject(start.payload).optString("client_session_id") ==
                        JSONObject(location.payload).optString("client_session_id")
            } }
            lastDetail = if (waiting) SyncDetail.WAITING_SESSION else if (pending.any {
                it.wireVersion == version && it.kind == RecordKind.LOCATION && !it.quarantined && it.retryAfterMs > now
            } || due.isNotEmpty()) SyncDetail.BACKOFF else SyncDetail.NONE
            if (waiting) observe(DiagnosticKind.SYNC_PENDING, RecordKind.LOCATION, 0,
                DiagnosticReason.WAITING_SESSION)
            return if (waiting) SyncOutcome.PENDING else SyncOutcome.EMPTY
        }
        val clientId = JSONObject(first.payload).optString("client_session_id")
        val start = pending.firstOrNull { it.wireVersion == version && it.kind == RecordKind.SESSION && !it.quarantined &&
            JSONObject(it.payload).optString("type") == "STARTED" &&
            JSONObject(it.payload).optString("client_session_id") == clientId }
        val selected = mutableListOf<PendingRecord>()
        if (start != null) selected.add(start)
        for (location in due.filter { it.id != start?.id &&
                JSONObject(it.payload).optString("client_session_id") == clientId }
                .take(100 - selected.size)) {
            val candidate = selected + location
            if (encodeMixed(clientId, candidate, version).toByteArray(StandardCharsets.UTF_8).size > 256 * 1024) {
                if (selected.size == (if (start == null) 0 else 1)) {
                    store.update { state -> state.pending.first { it.id == location.id }.quarantined = true }
                    lastDetail = SyncDetail.REJECTED_EVENTS
                    observe(DiagnosticKind.SYNC_QUARANTINE, RecordKind.LOCATION, 1,
                        DiagnosticReason.REJECTED_EVENTS)
                    return SyncOutcome.QUARANTINED
                }
                break
            }
            selected.add(location)
        }
        if (version == 2 && selected.none { it.kind == RecordKind.LOCATION }) return SyncOutcome.EMPTY
        val ids = selected.map { it.id }.toSet()
        val body = encodeMixed(clientId, selected, version)
        observe(DiagnosticKind.SYNC_ATTEMPT, RecordKind.LOCATION, ids.size)
        val result = try { if (version == 3) transport.postOffline(body) else transport.postMixed(body) }
            catch (failure: Exception) {
            if (failure.message in setOf("session_http_401", "session_http_403",
                    "session_challenge_http_401", "session_challenge_http_403")) {
                lastDetail = SyncDetail.AUTH_REJECTED
                observe(DiagnosticKind.SYNC_AUTH_REQUIRED, RecordKind.LOCATION, ids.size,
                    DiagnosticReason.AUTH_REJECTED)
                return SyncOutcome.AUTH_REQUIRED
            }
            lastDetail = SyncDetail.NETWORK
            retry(ids, now, null)
            observe(DiagnosticKind.SYNC_RETRY, RecordKind.LOCATION, ids.size,
                DiagnosticReason.NETWORK)
            return SyncOutcome.RETRY
        }
        when (result.status) {
            200 -> {
                val ack = runCatching { JSONObject(result.body) }.getOrNull()
                val persistedAt = runCatching { Instant.parse(ack?.getString("persisted_at")).toEpochMilli() }
                    .getOrNull()
                val accepted = ack?.let { idsFrom(it.optJSONArray("accepted_event_ids")) }
                val duplicate = ack?.let { idsFrom(it.optJSONArray("duplicate_event_ids")) }
                val mappings = ack?.optJSONArray("session_mappings")
                val mapped = mappings != null && (0 until mappings.length()).all { index ->
                    val item = mappings.optJSONObject(index) ?: return@all false
                    item.optString("client_session_id") == clientId && uuid(item.optString("session_id"))
                }
                if (ack?.optString("batch_id") != mixedBatchId(selected, version) || persistedAt == null ||
                    accepted == null || duplicate == null || accepted.intersect(duplicate).isNotEmpty() ||
                    accepted.union(duplicate) != ids || !mapped ||
                    (start != null && mappings.length() != 1)) {
                    lastDetail = SyncDetail.INVALID_ACK
                    retry(ids, now, null)
                    observe(DiagnosticKind.SYNC_RETRY, RecordKind.LOCATION, ids.size,
                        DiagnosticReason.INVALID_ACK)
                    return SyncOutcome.RETRY
                }
                val locations = selected.count { it.kind == RecordKind.LOCATION }
                store.update { state ->
                    state.pending.removeAll { it.id in ids }
                    state.locationsAcked += locations
                    state.lastLocationAckedMs = persistedAt
                }
                lastDetail = SyncDetail.ACKED
                observe(DiagnosticKind.SYNC_ACK, RecordKind.LOCATION, ids.size)
                return SyncOutcome.ACKED
            }
            202 -> {
                lastDetail = SyncDetail.SERVER_PENDING
                retry(ids, now, 30)
                observe(DiagnosticKind.SYNC_PENDING, RecordKind.LOCATION, ids.size,
                    DiagnosticReason.SERVER_PENDING)
                return SyncOutcome.PENDING
            }
            401, 403 -> {
                lastDetail = SyncDetail.AUTH_REJECTED
                observe(DiagnosticKind.SYNC_AUTH_REQUIRED, RecordKind.LOCATION, ids.size,
                    DiagnosticReason.AUTH_REJECTED)
                return SyncOutcome.AUTH_REQUIRED
            }
            404, 405 -> {
                if (version == 2) {
                    // Older backend: retain all IDs and use per-session v1 ordering.
                    mixedAvailable = false
                    lastDetail = SyncDetail.SERVER_PENDING
                    return SyncOutcome.PENDING
                }
                // An offline event cannot be safely downgraded to v1/v2 time validation.
                lastDetail = SyncDetail.SERVER_ERROR
                retry(ids, now, null)
                return SyncOutcome.RETRY
            }
            409 -> {
                lastDetail = SyncDetail.REJECTED_EVENTS
                store.update { state -> state.pending.filter { it.id in ids }.forEach { it.quarantined = true } }
                observe(DiagnosticKind.SYNC_QUARANTINE, RecordKind.LOCATION, ids.size,
                    DiagnosticReason.REJECTED_EVENTS)
                return SyncOutcome.QUARANTINED
            }
            422 -> {
                val invalid = runCatching { idsFrom(JSONObject(result.body).optJSONArray("invalid_event_ids")) }
                    .getOrNull()
                if (invalid == null || invalid.isEmpty() || !ids.containsAll(invalid)) {
                    lastDetail = SyncDetail.INVALID_ACK
                    retry(ids, now, null)
                    return SyncOutcome.RETRY
                }
                lastDetail = SyncDetail.REJECTED_EVENTS
                store.update { state -> state.pending.filter { it.id in invalid }.forEach { it.quarantined = true } }
                observe(DiagnosticKind.SYNC_QUARANTINE, RecordKind.LOCATION, invalid.size,
                    DiagnosticReason.REJECTED_EVENTS)
                return SyncOutcome.QUARANTINED
            }
            429 -> {
                lastDetail = SyncDetail.RATE_LIMIT
                retry(ids, now, result.retryAfterSeconds?.coerceIn(1, 3600))
            }
            else -> {
                lastDetail = SyncDetail.SERVER_ERROR
                retry(ids, now, null)
            }
        }
        observe(DiagnosticKind.SYNC_RETRY, RecordKind.LOCATION, ids.size,
            if (result.status == 429) DiagnosticReason.RATE_LIMIT else DiagnosticReason.SERVER_ERROR)
        return SyncOutcome.RETRY
    }

    private fun mixedBatchId(records: List<PendingRecord>, version: Int): String = UUID.nameUUIDFromBytes(
        ((if (version == 3) "OFFLINE:" else "MIXED:") + records.joinToString(",") { it.id })
            .toByteArray(StandardCharsets.UTF_8)).toString()

    private fun encodeMixed(clientId: String, records: List<PendingRecord>, version: Int): String {
        val events = JSONArray()
        records.forEach { record ->
            events.put(JSONObject().put("kind", record.kind.name.let {
                if (it == "LOCATION") "POSITION" else it
            }).put("payload", JSONObject(record.payload)))
        }
        return JSONObject().put("schema_version", version).put("batch_id", mixedBatchId(records, version))
            .put("device_id", identity.deviceId).put("installation_id", identity.installationId)
            .put("client_session_id", clientId).put("events", events).toString()
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
