package com.geops.agent

import java.nio.file.Files
import java.nio.file.Paths
import java.time.Instant
import org.json.JSONObject

/** Replays exact 202/200 backend responses through the synthetic buffer state machine. */
fun main(args: Array<String>) {
    require(args.size == 1) { "wire_path_required" }
    val wire = JSONObject(String(Files.readAllBytes(Paths.get(args[0])), Charsets.UTF_8))
    val identity = Identity(wire.getString("device_id"), wire.getString("installation_id"))
    val missed = wire.getJSONObject("missed_event")
    val started = wire.getJSONObject("start_event")
    val point = wire.getJSONObject("position_event")
    val store = MemoryAgentStore()
    val base = Instant.parse(missed.getString("occurred_at")).toEpochMilli()
    store.update { state ->
        state.pending.add(PendingRecord(missed.getString("event_id"), RecordKind.SESSION,
            missed.toString(), base))
        state.pending.add(PendingRecord(started.getString("event_id"), RecordKind.SESSION,
            started.toString(), base + 1000))
        state.pending.add(PendingRecord(point.getString("event_id"), RecordKind.LOCATION,
            point.toString(), base + 2000))
    }
    val clock = object : AgentClock {
        var wall = base + 3000
        override fun read() = ClockReading(wall, 3000, started.getString("boot_id"))
    }
    var locationAttempts = 0
    val transport = object : BatchTransport {
        override fun post(kind: RecordKind, body: String): HttpResult {
            val sent = JSONObject(body)
            check(sent.getString("device_id") == identity.deviceId &&
                sent.getString("installation_id") == identity.installationId)
            return when (kind) {
                RecordKind.SESSION -> HttpResult(200, wire.getJSONObject("session_ack").toString(), null)
                RecordKind.LOCATION -> {
                    locationAttempts++
                    if (locationAttempts == 1)
                        HttpResult(202, wire.getJSONObject("pending_response").toString(), null)
                    else HttpResult(200, wire.getJSONObject("position_ack").toString(), null)
                }
                RecordKind.HEALTH -> error("not_requested")
            }
        }
    }
    val sync = BatchSync(identity, store, clock, transport)
    check(sync.once(RecordKind.LOCATION) == SyncOutcome.PENDING)
    check(locationAttempts == 0)
    check(sync.once(RecordKind.SESSION) == SyncOutcome.ACKED)
    check(store.read().pending.size == 1)
    check(sync.once(RecordKind.LOCATION) == SyncOutcome.PENDING)
    check(store.read().pending.size == 1)
    clock.wall += 30_000
    check(sync.once(RecordKind.LOCATION) == SyncOutcome.ACKED)
    check(store.read().pending.isEmpty())
    println("PASS Kotlin session/position queue, 202, retry and persisted backend ACK")
}
