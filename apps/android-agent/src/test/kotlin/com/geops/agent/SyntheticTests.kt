package com.geops.agent

import java.nio.file.Files
import java.time.Instant
import java.security.MessageDigest
import java.util.UUID
import javax.crypto.KeyGenerator
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONArray
import org.json.JSONObject

private val device = "11111111-1111-4111-8111-111111111111"
private val installation = "22222222-2222-4222-8222-222222222222"
private val policyId = "33333333-3333-4333-8333-333333333333"
private val anchor = "44444444-4444-4444-8444-444444444444"
private val scheduled = "55555555-5555-4555-8555-555555555555"
private val boot = "66666666-6666-4666-8666-666666666666"
private fun ms(s: String) = Instant.parse(s).toEpochMilli()
private val start = ms("2026-10-20T04:00:00Z")
private val end = ms("2026-10-20T12:00:00Z")
private fun snap(version: Long = 7, active: Boolean = true, from: Long = start, until: Long = end + 3_600_000,
                 windows: List<Window> = listOf(Window(scheduled, start, end)), healthInterval: Int = 300) =
    Snapshot(Identity(device, installation), version, active, anchor, start, start, end,
        if (active) windows else emptyList(),
        if (active) Policy(policyId, if (version == 7L) 2 else 3, 60, 300, from, until, healthInterval) else null)
private class FakeClock(var wall: Long = start, var elapsed: Long = 1000, var bootId: String = boot) : AgentClock {
    override fun read() = ClockReading(wall, elapsed, bootId)
    fun advance(delta: Long) { wall += delta; elapsed += delta }
}
private class FakeRuntime(var allowed: Boolean = true) : TrackingRuntime {
    var running = false
    override fun startVisibleAndRegister(intervalSeconds: Int): Boolean { running = allowed; return running }
    override fun stopAndUnregister() { running = false }
    override fun isRegistered() = running
}
private class FakeHealth(var value: HealthObservation = HealthObservation(80, false, false, false, true, true)) : HealthProbe {
    override fun observe() = value
}
private fun engine(clock: FakeClock, store: AgentStore = MemoryAgentStore()): Pair<PolicyEngine, AgentStore> =
    PolicyEngine(Identity(device, installation), clock, store) to store
private fun PolicyEngine.load(snapshot: Snapshot) { refresh(object : AuthenticatedConfigTransport {
    override fun fetch(identity: Identity) = snapshot
}) }
private fun test(name: String, block: () -> Unit) { block(); println("PASS $name") }

fun main() {
    test("V01 UTC half-open and V02 expiration") {
        val clock = FakeClock(); val (p, _) = engine(clock); p.load(snap())
        check(p.current() != null)
        clock.advance(3_600_000); check(p.current() != null)
        clock.advance(7 * 3_600_000); check(p.current() == null)
        val c2 = FakeClock(); val (p2, _) = engine(c2); p2.load(snap(until = start + 60_000))
        c2.advance(60_000); check(p2.current() == null)
    }
    test("V03 tombstone and V05 downgrade") {
        val clock = FakeClock(); val (p, _) = engine(clock); p.load(snap())
        p.load(snap(version = 8, active = false)); check(p.current() == null)
        check(runCatching { p.load(snap(version = 7)) }.isFailure)
    }
    test("V06 changed window, V07 offline end, V08 drift and reboot") {
        val clock = FakeClock(); val (p, _) = engine(clock)
        p.load(snap(version = 8, windows = listOf(Window(scheduled, start + 3_600_000, end))))
        check(p.current() == null); clock.advance(3_600_000); check(p.current() != null)
        clock.wall += 300_001; check(p.current() == null); clock.wall -= 300_001
        clock.bootId = UUID.randomUUID().toString(); check(p.current() == null)
        clock.bootId = boot; clock.advance(7 * 3_600_000); check(p.current() == null)
    }
    test("policy diagnostic distinguishes no assignment, scheduled window and clock drift") {
        val clock = FakeClock(); val (p, store) = engine(clock)
        check(p.evaluate().reason == "NO_CONFIG")
        p.load(snap(active = false)); check(p.evaluate().reason == "NO_ACTIVE_POLICY")
        p.load(snap(version = 8, windows = listOf(Window(scheduled, start + 3_600_000, end))))
        check(p.evaluate().reason == "OUTSIDE_WINDOW")
        clock.advance(3_600_000); check(p.evaluate().window != null)
        clock.wall += 300_001; check(p.evaluate().reason == "CLOCK_DRIFT")
        check(store.read().snapshot?.policy?.revision == 3)
    }
    test("foreign identity and excessive RTT fail closed") {
        val clock = FakeClock(); val (p, _) = engine(clock)
        check(runCatching { p.load(snap().copy(identity = Identity(UUID.randomUUID().toString(), installation))) }.isFailure)
        val slow = object : AuthenticatedConfigTransport {
            override fun fetch(identity: Identity): Snapshot { clock.advance(30_001); return snap() }
        }
        check(runCatching { p.refresh(slow) }.isFailure)
    }
    test("W1-A config parser rejects foreign and unknown fields") {
        val policy = JSONObject().put("name", "Synthetic").put("days_iso", JSONArray().put(1))
            .put("start_local", "22:00").put("end_local", "06:00").put("time_zone", "America/Guatemala")
            .put("capture_interval_s", 60).put("sync_interval_s", 300).put("heartbeat_missing_after_s", 900)
            .put("valid_from", utc(start)).put("valid_until", utc(end + 3_600_000))
        val wire = JSONObject().put("schema_version", 1).put("capture_anchor_id", anchor)
            .put("device_id", device).put("installation_id", installation).put("assignment_version", 7)
            .put("active", true).put("policy_id", policyId).put("policy_revision", 2)
            .put("policy", policy).put("tzdb_version", "synthetic-2026a")
            .put("server_time", utc(start)).put("verified_at", utc(start)).put("offline_not_after", utc(end))
            .put("window_instances", JSONArray().put(JSONObject().put("scheduled_session_id", scheduled)
                .put("start_at", utc(start)).put("end_at", utc(end))))
        val parsed = ConfigParser.parse(wire.toString(), Identity(device, installation))
        check(parsed.policy?.healthIntervalS == 300)
        check(parsed.display == PolicyDisplay("Synthetic", listOf(1), "22:00", "06:00", "America/Guatemala"))
        val restored = StateCodec.decode(StateCodec.encode(AgentState(snapshot = parsed)))
        check(restored.snapshot?.display == parsed.display)
        check(runCatching { ConfigParser.parse(wire.put("device_id", UUID.randomUUID().toString()).toString(),
            Identity(device, installation)) }.isFailure)
        wire.put("device_id", device).put("admin_override", true)
        check(runCatching { ConfigParser.parse(wire.toString(), Identity(device, installation)) }.isFailure)
    }
    test("SPEC-00 Kotlin PoP bytes and ECDSA signature") {
        val nonce = "nonce"
        val proof = String(PopProof.bytes("GET", "/v1/device/config", byteArrayOf(), "token",
            "1792440000", nonce, device), Charsets.UTF_8)
        val enc = java.util.Base64.getUrlEncoder().withoutPadding()
        fun digest(s: String) = enc.encodeToString(MessageDigest.getInstance("SHA-256").digest(s.toByteArray()))
        check(proof == listOf("GEOPS-REQ-V1", "GET", "/v1/device/config", digest(""), digest("token"),
            "1792440000", nonce, device).joinToString("\n"))
        val pair = java.security.KeyPairGenerator.getInstance("EC").apply { initialize(256) }.generateKeyPair()
        val sig = EcdsaDeviceSigner(device, pair.private).sign(proof.toByteArray())
        check(java.security.Signature.getInstance("SHA256withECDSA").run {
            initVerify(pair.public); update(proof.toByteArray()); verify(sig)
        })
    }
    test("DuckDNS Staging URL and PoP use the canonical device path") {
        val vector = JSONObject(Thread.currentThread().contextClassLoader
            .getResourceAsStream("staging-pop-vector.json")!!.bufferedReader().use { it.readText() })
        check(vector.getString("base_url") == SYNTHETIC_STAGING_BASE_URL)
        val stage = DeviceRequestTarget(SYNTHETIC_STAGING_BASE_URL)
        val path = vector.getString("canonical_path")
        check(stage.publicUrl(path).path == vector.getString("public_path"))
        check(stage.publicUrl(path).host == "geops-staging.duckdns.org")
        val proof = PopProof.bytes(vector.getString("method"), path,
            vector.getString("body").toByteArray(Charsets.UTF_8), vector.getString("token"),
            vector.getString("timestamp"), vector.getString("nonce"), vector.getString("key_id"))
        check(java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(proof) ==
            vector.getString("proof_base64url"))
        check(!String(proof, Charsets.UTF_8).contains("/staging/"))
        for (badBase in listOf("http://geops-staging.duckdns.org/", "https://geops-staging.duckdns.org/other/",
            "https://geops-staging.duckdns.org/staging/", "https://geops-staging.duckdns.org/?q=1",
            "https://geops-staging.duckdns.org/#x"))
            check(runCatching { DeviceRequestTarget(badBase) }.isFailure)
        for (badPath in listOf("/staging/v1/device/config", "/v1/device/../config",
            "/v1/device//config", "/v1/device/config?x=1", "/v1/device/%63onfig"))
            check(runCatching { stage.publicUrl(badPath) }.isFailure)
    }
    test("FGS failure is MISSED_START, not STARTED; health survives no GPS") {
        val clock = FakeClock(); val (p, store) = engine(clock); p.load(snap())
        val runtime = FakeRuntime(false)
        val agent = TrackingController(Identity(device, installation), clock, p, store, runtime, FakeHealth())
        agent.tick()
        val types = store.read().pending.filter { it.kind == RecordKind.SESSION }.map { JSONObject(it.payload).getString("type") }
        check(types == listOf("START_ATTEMPT", "MISSED_START"))
        check(store.read().pending.count { it.kind == RecordKind.HEALTH } == 1)
        check(JSONObject(store.read().pending.first { it.kind == RecordKind.HEALTH }.payload)
            .getString("tracking_state") == "STOPPED")
        check(store.read().session == null)
    }
    test("running session, GPS and independent health cadence") {
        val clock = FakeClock(); val (p, store) = engine(clock); p.load(snap())
        val runtime = FakeRuntime()
        val health = FakeHealth()
        val agent = TrackingController(Identity(device, installation), clock, p, store, runtime, health)
        agent.tick()
        check(store.read().session?.state == "RUNNING")
        check(store.read().pending.any { it.kind == RecordKind.SESSION && JSONObject(it.payload).getString("type") == "STARTED" })
        check(JSONObject(store.read().pending.first { it.kind == RecordKind.HEALTH }.payload)
            .getString("tracking_state") == "RUNNING")
        clock.advance(60_000)
        check(agent.onLocation(LocationFix(14.6, -90.5, 10.0, clock.read())))
        check(agent.onLocationResult(LocationFix(14.6, -90.5, 10.0, clock.read())) ==
            LocationDecision.WAITING_INTERVAL)
        agent.tick(); check(store.read().pending.count { it.kind == RecordKind.HEALTH } == 1)
        clock.advance(240_000); health.value = HealthObservation(2, false, false, true, false, false)
        agent.tick(); check(store.read().pending.count { it.kind == RecordKind.HEALTH } == 2)
        val last = JSONObject(store.read().pending.last { it.kind == RecordKind.HEALTH }.payload)
        check(last.getInt("battery_percent") == 2 && !last.getBoolean("network_available") && !last.getBoolean("provider_available"))
        check(last.getJSONArray("observed_states").toString().contains("BATTERY_CRITICAL"))
        check(last.getString("boot_id") == clock.read().bootId)
        check(last.getString("capture_anchor_id").isNotBlank())
        check(last.getLong("elapsed_realtime_ms") >= last.getLong("anchor_elapsed_realtime_ms"))
        agent.interrupt("GPS_DISABLED"); check(store.read().session?.state == "INTERRUPTED")
        check(agent.resume()); check(store.read().session?.state == "RUNNING")
        clock.advance(end - clock.wall)
        check(agent.onLocationResult(LocationFix(14.6, -90.5, 10.0, clock.read())) == LocationDecision.NO_WINDOW)
        agent.tick(); check(store.read().session == null && !runtime.running)
        check(store.read().pending.any { it.kind == RecordKind.LOCATION })
    }
    test("health diagnosis separates GPS, network and uncertain battery cause") {
        val labels = HealthDiagnosis.classify(HealthObservation(2, false, false, true, false, false), false)
        check(labels.contains(ObservedHealthState.BATTERY_CRITICAL))
        check(labels.contains(ObservedHealthState.GPS_UNAVAILABLE))
        check(labels.contains(ObservedHealthState.NETWORK_UNAVAILABLE))
        check(HealthDiagnosis.classify(HealthObservation(null, null, null, null, null, null), false) ==
            setOf(ObservedHealthState.UNKNOWN))
    }
    test("policy replacement closes old session before applying new anchor") {
        val clock = FakeClock(); val (p, store) = engine(clock); p.load(snap())
        val runtime = FakeRuntime()
        val agent = TrackingController(Identity(device, installation), clock, p, store, runtime, FakeHealth())
        agent.tick()
        agent.refreshConfig(object : AuthenticatedConfigTransport { override fun fetch(identity: Identity) = snap(version = 8) })
        val stopped = store.read().pending.find { it.kind == RecordKind.SESSION && JSONObject(it.payload).optString("type") == "STOPPED" }
        check(stopped != null && JSONObject(stopped.payload).getString("reason_code") == "POLICY_REPLACED")
        check(JSONObject(stopped.payload).getLong("assignment_version") == 7L)
        agent.tick(); check(store.read().session?.assignmentVersion == 8L)
    }
    test("process restart and boot change never fabricate effective start") {
        val clock = FakeClock(); val (p, store) = engine(clock); p.load(snap())
        val agent = TrackingController(Identity(device, installation), clock, p, store, FakeRuntime(), FakeHealth())
        agent.tick(); val count = store.read().pending.count { it.kind == RecordKind.SESSION }
        agent.onProcessRestart(); check(store.read().session?.state == "UNKNOWN_END")
        clock.bootId = UUID.randomUUID().toString(); agent.tick()
        check(store.read().pending.count { it.kind == RecordKind.SESSION } == count)
    }
    test("AES-GCM persistence, original timestamp and tamper rejection") {
        val path = Files.createTempFile("geops-agent-", ".bin")
        Files.delete(path)
        val key = KeyGenerator.getInstance("AES").run { init(256); generateKey() }
        val clock = FakeClock()
        val store = EncryptedFileAgentStore(path, key)
        val (p, _) = engine(clock, store); p.load(snap())
        val firstNonce = Files.readAllBytes(path).copyOfRange(1, 13)
        store.update { it.pending.add(PendingRecord(UUID.randomUUID().toString(), RecordKind.LOCATION,
            "{\"latitude\":14.6}", start)) }
        val bytes = Files.readAllBytes(path)
        check(!firstNonce.contentEquals(bytes.copyOfRange(1, 13)))
        check(!String(bytes, Charsets.ISO_8859_1).contains("latitude"))
        val reopened = EncryptedFileAgentStore(path, key)
        check(reopened.read().pending.single().createdAtMs == start)
        val wrongKey = KeyGenerator.getInstance("AES").run { init(256); generateKey() }
        check(runCatching { EncryptedFileAgentStore(path, wrongKey).read() }.isFailure)
        check(runCatching { reopened.update { it.pending.add(PendingRecord(UUID.randomUUID().toString(),
            RecordKind.HEALTH, "x".repeat(4_000_000), start)) } }.isFailure)
        check(reopened.read().pending.size == 1)
        bytes[bytes.lastIndex] = (bytes.last().toInt() xor 1).toByte(); Files.write(path, bytes)
        check(runCatching { reopened.read() }.isFailure)
        Files.deleteIfExists(path)
    }
    test("existing version-one ciphertext remains readable") {
        val path = Files.createTempFile("geops-agent-legacy-", ".bin")
        val key = KeyGenerator.getInstance("AES").run { init(256); generateKey() }
        val nonce = ByteArray(12) { it.toByte() }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, nonce))
        cipher.updateAAD("GEOPS-AGENT-STATE-V1".toByteArray(Charsets.US_ASCII))
        val legacy = JSONObject(StateCodec.encode(AgentState(snapshot = snap())))
        listOf("locations_captured", "locations_acked", "last_location_captured", "last_location_acked")
            .forEach(legacy::remove)
        Files.write(path, byteArrayOf(1) + nonce + cipher.doFinal(legacy.toString().toByteArray()))
        val store = EncryptedFileAgentStore(path, key)
        check(store.read().highestAssignmentVersion == -1L)
        check(store.read().snapshot?.policy?.revision == 2 && store.read().snapshot?.display == null)
        check(store.read().locationsCaptured == 0L && store.read().locationsAcked == 0L)
        store.update { it.highestAssignmentVersion = 7 }
        check(store.read().highestAssignmentVersion == 7L)
        Files.deleteIfExists(path)
    }
    test("state from another device cannot trigger a false assignment downgrade") {
        val root = Files.createTempDirectory("geops-installation-state-")
        val key = KeyGenerator.getInstance("AES").run { init(256); generateKey() }
        val oldIdentity = Identity(device, installation)
        val oldFile = root.resolve("agent-state.bin")
        EncryptedFileAgentStore(oldFile, key).update { state ->
            state.snapshot = snap(version = 8)
            state.highestAssignmentVersion = 8
            state.pending.add(PendingRecord(UUID.randomUUID().toString(), RecordKind.LOCATION,
                "{}", start))
        }
        val oldBytes = Files.readAllBytes(oldFile)
        check(AgentStateFiles.resolve(root, oldIdentity, key) == oldFile)
        check(runCatching { AgentStateFiles.resolve(root,
            Identity(device, UUID.randomUUID().toString()), key) }.isFailure)
        val nextIdentity = Identity(UUID.randomUUID().toString(), UUID.randomUUID().toString())
        val nextFile = AgentStateFiles.resolve(root, nextIdentity, key)
        check(nextFile != oldFile && !Files.exists(nextFile))
        val nextStore = EncryptedFileAgentStore(nextFile, key)
        val nextPolicy = PolicyEngine(nextIdentity, FakeClock(), nextStore)
        nextPolicy.load(snap(version = 1).copy(identity = nextIdentity))
        check(nextStore.read().highestAssignmentVersion == 1L)
        check(Files.readAllBytes(oldFile).contentEquals(oldBytes))
        check(runCatching { PolicyEngine(oldIdentity, FakeClock(), EncryptedFileAgentStore(oldFile, key))
            .load(snap(version = 7)) }.isFailure)
        check(AgentStateFiles.resolve(root, nextIdentity, key) == nextFile)
        check(runCatching { AgentStateFiles.resolve(root,
            Identity(nextIdentity.deviceId, UUID.randomUUID().toString()), key) }.isFailure)
        Files.deleteIfExists(nextFile)
        Files.deleteIfExists(oldFile)
        Files.deleteIfExists(root)
    }
    test("202 has no ACK; 200 accepts duplicates; 422 isolates only invalid IDs") {
        val clock = FakeClock(); val store = MemoryAgentStore()
        val a = UUID.randomUUID().toString(); val b = UUID.randomUUID().toString()
        store.update { s -> listOf(a, b).forEach { s.pending.add(PendingRecord(it, RecordKind.HEALTH,
            JSONObject().put("event_id", it).toString(), start)) } }
        var calls = 0
        val transport = object : BatchTransport {
            override fun post(kind: RecordKind, body: String): HttpResult {
                calls++
                val o = JSONObject(body); val ids = o.getJSONArray("events")
                return when (calls) {
                    1 -> HttpResult(202, "{}", null)
                    2 -> HttpResult(422, JSONObject().put("invalid_event_ids", JSONArray().put(b)).toString(), null)
                    else -> HttpResult(200, JSONObject().put("batch_id", o.getString("batch_id"))
                        .put("persisted_at", utc(clock.wall)).put("accepted_event_ids", JSONArray())
                        .put("duplicate_event_ids", JSONArray().put(ids.getJSONObject(0).getString("event_id"))).toString(), null)
                }
            }
        }
        val sync = BatchSync(Identity(device, installation), store, clock, transport)
        check(sync.once(RecordKind.HEALTH) == SyncOutcome.PENDING)
        check(sync.lastDetail == SyncDetail.SERVER_PENDING)
        check(store.read().pending.size == 2)
        clock.advance(30_000)
        check(sync.once(RecordKind.HEALTH) == SyncOutcome.QUARANTINED)
        check(store.read().pending.single { it.id == b }.quarantined)
        check(sync.once(RecordKind.HEALTH) == SyncOutcome.ACKED)
        check(store.read().pending.single().id == b)
    }
    test("position counters change only on persisted capture and validated ACK") {
        val clock = FakeClock(); val (policy, store) = engine(clock); policy.load(snap())
        val runtime = FakeRuntime()
        val controller = TrackingController(Identity(device, installation), clock, policy, store, runtime, FakeHealth())
        controller.tick(); clock.advance(60_000)
        check(controller.onLocation(LocationFix(14.6, -90.5, 10.0, clock.read())))
        check(store.read().locationsCaptured == 1L && store.read().locationsAcked == 0L)
        val sessionTransport = object : BatchTransport {
            override fun post(kind: RecordKind, body: String): HttpResult {
                val batch = JSONObject(body)
                val ids = batch.getJSONArray("events")
                return HttpResult(200, JSONObject().put("batch_id", batch.getString("batch_id"))
                    .put("persisted_at", utc(clock.wall))
                    .put("accepted_event_ids", JSONArray().also { a ->
                        for (i in 0 until ids.length()) a.put(ids.getJSONObject(i).getString("event_id"))
                    }).put("duplicate_event_ids", JSONArray()).toString(), null)
            }
        }
        val sync = BatchSync(Identity(device, installation), store, clock, sessionTransport)
        check(sync.once(RecordKind.LOCATION) == SyncOutcome.PENDING)
        check(store.read().locationsAcked == 0L)
        check(sync.once(RecordKind.SESSION) == SyncOutcome.ACKED)
        check(sync.once(RecordKind.LOCATION) == SyncOutcome.ACKED)
        check(store.read().locationsAcked == 1L && store.read().lastLocationAckedMs == clock.wall)
        check(sync.once(RecordKind.LOCATION) == SyncOutcome.EMPTY)
        check(store.read().locationsAcked == 1L)
    }
    test("lost or malformed ACK retains original event and backs off") {
        val clock = FakeClock(); val store = MemoryAgentStore(); val id = UUID.randomUUID().toString()
        store.update { it.pending.add(PendingRecord(id, RecordKind.LOCATION,
            JSONObject().put("event_id", id).toString(), start)) }
        val transport = object : BatchTransport {
            override fun post(kind: RecordKind, body: String) = HttpResult(200,
                JSONObject().put("batch_id", JSONObject(body).getString("batch_id"))
                    .put("persisted_at", utc(start)).put("accepted_event_ids", JSONArray())
                    .put("duplicate_event_ids", JSONArray()).toString(), null)
        }
        val sync = BatchSync(Identity(device, installation), store, clock, transport)
        check(sync.once(RecordKind.LOCATION) == SyncOutcome.RETRY)
        check(sync.lastDetail == SyncDetail.INVALID_ACK)
        check(store.read().pending.single().id == id && store.read().pending.single().attempts == 1)
        check(sync.once(RecordKind.LOCATION) == SyncOutcome.EMPTY)
        check(sync.lastDetail == SyncDetail.BACKOFF)
    }
    test("web invitation QR is accepted only for staging and before expiry") {
        val now = Instant.parse("2026-10-19T12:00:00Z")
        val secret = java.util.Base64.getUrlEncoder().withoutPadding()
            .encodeToString(ByteArray(32) { 7 })
        val qr = JSONObject().put("format", "geops-enrollment-v1")
            .put("origin", "https://geops-staging.duckdns.org")
            .put("geops_device_id", device).put("mdm_device_id", "synthetic-$device")
            .put("invitation_id", scheduled).put("invitation_secret", secret)
            .put("expires_at", "2026-10-19T12:10:00Z")
        val ticket = EnrollmentTicket.parseActive(qr.toString(), now)
        check(ticket.deviceId == device && ticket.mdmDeviceId == "synthetic-$device")
        check(ticket.invitationId == scheduled && ticket.invitationSecret == secret)
        check(runCatching { EnrollmentTicket.parseActive(qr.toString(), now.plusSeconds(600)) }.isFailure)
        check(runCatching { EnrollmentTicket.parseActive(qr.put("origin", "https://evil.invalid").toString(), now) }.isFailure)
        check(runCatching { EnrollmentTicket.parseActive("https://geops-staging.duckdns.org", now) }.isFailure)
        qr.put("origin", "https://geops-staging.duckdns.org")
        check(runCatching { EnrollmentTicket.parseActive(qr.put("invitation_secret", "invalid").toString(), now) }.isFailure)
    }
    test("activation QR accepts only staging and canonical device identifiers") {
        val now = Instant.parse("2026-10-20T12:00:00Z")
        val qr = JSONObject().put("format", "geops-activation-v1")
            .put("origin", "https://geops-staging.duckdns.org")
            .put("geops_device_id", device).put("key_id", policyId)
            .put("installation_id", anchor).put("expires_at", "2026-10-20T12:15:00Z")
        val ticket = ActivationTicket.parseActive(qr.toString(), now)
        check(ticket.deviceId == device && ticket.keyId == policyId && ticket.installationId == anchor)
        check(runCatching { ActivationTicket.parseActive(qr.toString(), now.plusSeconds(900)) }.isFailure)
        check(runCatching { ActivationTicket.parse(qr.put("origin", "https://evil.invalid").toString()) }.isFailure)
        qr.put("origin", "https://geops-staging.duckdns.org")
        check(runCatching { ActivationTicket.parse(qr.put("key_id", "invalid").toString()) }.isFailure)
        qr.put("key_id", policyId)
        check(runCatching { ActivationTicket.parse(qr.put("extra", "value").toString()) }.isFailure)
    }
    test("an activation QR cannot create a session for an inactive device") {
        val signer = object : EnrollmentSigner {
            override val publicSpki = byteArrayOf(1)
            override fun sign(message: ByteArray) = byteArrayOf(1)
        }
        var attempts = 0
        val transport = object : EnrollmentTransport {
            override fun post(path: String, body: String): HttpResult {
                attempts++
                check(path == "/v1/device/sessions/challenge")
                return HttpResult(403, "{}", null)
            }
        }
        val provider = RefreshingSessionProvider(device, policyId, signer, transport)
        check(runCatching { provider.currentToken() }.isFailure)
        check(attempts == 1)
    }
    test("claim conflict keeps only an allowlisted code and never echoes the response") {
        val now = Instant.parse("2026-10-19T12:00:00Z")
        val secret = java.util.Base64.getUrlEncoder().withoutPadding()
            .encodeToString(ByteArray(32) { 7 })
        val ticket = EnrollmentTicket(device, "synthetic-$device", scheduled, secret, now.plusSeconds(600))
        val signer = object : EnrollmentSigner {
            override val publicSpki = byteArrayOf(1)
            override fun sign(message: ByteArray) = byteArrayOf()
        }
        fun rejected(code: String): EnrollmentHttpException {
            val client = EnrollmentClient(object : EnrollmentTransport {
                override fun post(path: String, body: String) = HttpResult(409,
                    JSONObject().put("code", code).put("secret", "must-not-echo").toString(), null)
            }) { now }
            return runCatching { client.claim(ticket, signer) }.exceptionOrNull() as EnrollmentHttpException
        }
        val conflict = rejected("invitation_consumed")
        check(conflict.operation == "claim" && conflict.status == 409 && conflict.code == "invitation_consumed")
        check("must-not-echo" !in conflict.message.orEmpty())
        check(rejected("untrusted-secret-value").code == null)
    }
    test("enrollment ticket rejects foreign origin and proof signs canonical bytes") {
        val now = Instant.parse("2026-10-19T12:00:00Z")
        val enc = java.util.Base64.getUrlEncoder().withoutPadding()
        val secret = enc.encodeToString(ByteArray(32) { 7 })
        val ticketJson = JSONObject().put("format", "geops-enrollment-v1")
            .put("origin", "https://geops-staging.duckdns.org")
            .put("geops_device_id", device).put("mdm_device_id", "fake-$device")
            .put("invitation_id", scheduled).put("invitation_secret", secret)
            .put("expires_at", "2026-10-19T12:10:00Z")
        check(runCatching { EnrollmentTicket.parse(ticketJson.put("origin", "https://evil.invalid").toString()) }.isFailure)
        ticketJson.put("origin", "https://geops-staging.duckdns.org")
        val ticket = EnrollmentTicket.parse(ticketJson.toString())
        val pair = java.security.KeyPairGenerator.getInstance("EC").apply { initialize(256) }.generateKeyPair()
        val signer = object : EnrollmentSigner {
            override val publicSpki = pair.public.encoded
            override fun sign(message: ByteArray) = java.security.Signature.getInstance("SHA256withECDSA").run {
                initSign(pair.private); update(message); sign()
            }
        }
        var sentClaim: JSONObject? = null
        val transport = object : EnrollmentTransport {
            override fun post(path: String, body: String): HttpResult {
                val value = JSONObject(body)
                return when (path) {
                    "/v1/device/enrollment/claims" -> {
                        sentClaim = value
                        HttpResult(201, JSONObject().put("claim_id", policyId)
                            .put("challenge_id", anchor).put("challenge", secret)
                            .put("expires_at", "2026-10-19T12:02:00Z").toString(), null)
                    }
                    "/v1/device/enrollment/claims/$policyId/proof" -> {
                        val nonce = sentClaim!!.getString("client_nonce")
                        val fingerprint = enc.encodeToString(MessageDigest.getInstance("SHA-256").digest(signer.publicSpki))
                        val proof = listOf("GEOPS-ENROLL-V1", policyId, anchor, secret, device,
                            "fake-$device", fingerprint, nonce).joinToString("\n").toByteArray()
                        check(java.security.Signature.getInstance("SHA256withECDSA").run {
                            initVerify(pair.public); update(proof)
                            verify(java.util.Base64.getUrlDecoder().decode(value.getString("signature")))
                        })
                        HttpResult(200, JSONObject().put("status", "PENDING_CONFIRMATION")
                            .put("pairing_code", "12345678")
                            .put("expires_at", "2026-10-19T12:10:00Z").toString(), null)
                    }
                    else -> error("unexpected_path")
                }
            }
        }
        val client = EnrollmentClient(transport) { now }
        val claim = client.claim(ticket, signer)
        check(sentClaim!!.getString("geops_device_id") == device)
        check(client.prove(ticket, claim, signer).pairingCode == "12345678")
        check(runCatching { EnrollmentClient(transport) { now.plusSeconds(601) }.claim(ticket, signer) }.isFailure)
    }
    test("session bootstrap signs SPEC-01 challenge and keeps bearer in memory") {
        val pair = java.security.KeyPairGenerator.getInstance("EC").apply { initialize(256) }.generateKeyPair()
        val signer = object : EnrollmentSigner {
            override val publicSpki = pair.public.encoded
            override fun sign(message: ByteArray) = java.security.Signature.getInstance("SHA256withECDSA").run {
                initSign(pair.private); update(message); sign()
            }
        }
        val challenge = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32) { 5 })
        val token = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32) { 6 })
        var calls = 0
        val transport = object : EnrollmentTransport {
            override fun post(path: String, body: String): HttpResult {
                calls++
                return when (path) {
                    "/v1/device/sessions/challenge" -> HttpResult(200,
                        JSONObject().put("challenge_id", anchor).put("challenge", challenge)
                            .put("expires_at", "2026-10-19T12:02:00Z").toString(), null)
                    "/v1/device/sessions" -> {
                        val proof = listOf("GEOPS-SESSION-V1", anchor, challenge, policyId, device)
                            .joinToString("\n").toByteArray()
                        check(java.security.Signature.getInstance("SHA256withECDSA").run {
                            initVerify(pair.public); update(proof)
                            verify(java.util.Base64.getUrlDecoder().decode(JSONObject(body).getString("signature")))
                        })
                        HttpResult(201, JSONObject().put("access_token", token)
                            .put("key_id", policyId).put("expires_at", "2026-10-19T12:15:00Z").toString(), null)
                    }
                    else -> error("unexpected_path")
                }
            }
        }
        val provider = RefreshingSessionProvider(device, policyId, signer, transport) {
            Instant.parse("2026-10-19T12:00:00Z")
        }
        check(provider.currentToken() == token)
        check(provider.currentToken() == token && calls == 2)
    }
}
