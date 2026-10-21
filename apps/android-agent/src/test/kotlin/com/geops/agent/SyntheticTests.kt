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
private class FakeClock(var wall: Long = start, var elapsed: Long = 1000, var bootId: String = boot,
                        var automaticTime: Boolean = true) : AgentClock {
    override fun read() = ClockReading(wall, elapsed, bootId, automaticTime)
    fun advance(delta: Long) { wall += delta; elapsed += delta }
}
private class FakeRuntime(var allowed: Boolean = true) : TrackingRuntime {
    var running = false
    var pauses = 0
    var hardStops = 0
    var registrations = 0
    override fun startVisibleAndRegister(intervalSeconds: Int): Boolean {
        if (running) return false
        running = allowed
        if (running) registrations++
        return running
    }
    override fun pauseCapture() { running = false; pauses++ }
    override fun stopAndUnregister() { running = false; hardStops++ }
    override fun isRegistered() = running
}
private class FakeHealth(var value: HealthObservation = HealthObservation(80, false, false, false, true, true)) : HealthProbe {
    override fun observe() = value
}
private class RecordingDiagnostics : DiagnosticRecorder {
    val events = mutableListOf<DiagnosticEvent>()
    override fun record(event: DiagnosticEvent) { events.add(event) }
    override fun recent(): List<DiagnosticEvent> = events.toList()
}
private fun engine(clock: FakeClock, store: AgentStore = MemoryAgentStore()): Pair<PolicyEngine, AgentStore> =
    PolicyEngine(Identity(device, installation), clock, store) to store
private fun PolicyEngine.load(snapshot: Snapshot) { refresh(object : AuthenticatedConfigTransport {
    override fun fetch(identity: Identity) = snapshot
}) }
private fun test(name: String, block: () -> Unit) { block(); println("PASS $name") }

fun main() {
    test("R1 encrypted bounded diagnostics retain only closed metadata") {
        val path = Files.createTempFile("geops-diagnostic-", ".bin")
        Files.delete(path)
        check(DiagnosticFiles.scoped(path.parent, Identity(device, installation)) !=
            DiagnosticFiles.scoped(path.parent, Identity(device, UUID.randomUUID().toString())))
        val key = KeyGenerator.getInstance("AES").run { init(256); generateKey() }
        var now = start
        val journal = EncryptedDiagnosticJournal(path, key) { now }
        journal.record(DiagnosticEvent(DiagnosticKind.CALLBACK_RECEIVED, now,
            fixAtMs = now - 1000, receivedAtMs = now, assignmentVersion = 7, policyRevision = 2))
        val first = Files.readAllBytes(path)
        check(first[0] == 1.toByte() && !String(first, Charsets.ISO_8859_1).contains("CALLBACK_RECEIVED"))
        check(!String(first, Charsets.ISO_8859_1).contains("latitude"))
        check(journal.recent().single().fixAtMs == now - 1000)
        journal.record(DiagnosticEvent(DiagnosticKind.CAPTURE_REJECTED, now,
            DiagnosticReason.TIME_IN_FUTURE))
        check(!first.copyOfRange(1, 13).contentEquals(Files.readAllBytes(path).copyOfRange(1, 13)))
        val writers = (0..1).map { index -> Thread {
            val otherHandle = EncryptedDiagnosticJournal(path, key) { now }
            repeat(5) { otherHandle.record(DiagnosticEvent(DiagnosticKind.SYNC_RETRY, now,
                DiagnosticReason.NETWORK, count = index + 1)) }
        } }
        writers.forEach(Thread::start)
        writers.forEach(Thread::join)
        check(journal.recent().size == 12)
        val tampered = Files.readAllBytes(path)
        tampered[tampered.lastIndex] = (tampered.last().toInt() xor 1).toByte()
        Files.write(path, tampered)
        check(runCatching { journal.recent() }.isFailure)
        Files.delete(path)
        journal.record(DiagnosticEvent(DiagnosticKind.CALLBACK_RECEIVED, now, fixAtMs = now))
        now += 24 * 3_600_000L + 1
        check(journal.recent().isEmpty())
        check(!Files.exists(path))
        journal.record(DiagnosticEvent(DiagnosticKind.FGS_DESTROYED, now))
        check(journal.recent().map { it.kind } == listOf(DiagnosticKind.FGS_DESTROYED))
        Files.deleteIfExists(path)
    }
    test("R1 callback, capture, rejection, queue and policy diagnostics") {
        val clock = FakeClock(); val (policy, store) = engine(clock); policy.load(snap())
        val diagnostics = RecordingDiagnostics()
        val agent = TrackingController(Identity(device, installation), clock, policy, store,
            FakeRuntime(), FakeHealth(), diagnostics)
        agent.tick()
        check(diagnostics.events.any { it.kind == DiagnosticKind.WINDOW_ENTERED })
        clock.advance(120_000)
        val accepted = agent.onLocationDecision(LocationFix(14.6, -90.5, 10.0, clock.read(), clock.wall - 25))
        check(accepted == DiagnosticReason.NONE)
        check(diagnostics.events.first { it.kind == DiagnosticKind.CALLBACK_RECEIVED }.receivedAtMs == clock.wall - 25)
        check(agent.onLocationDecision(LocationFix(14.6, -90.5, 10.0, clock.read())) == DiagnosticReason.WAITING_INTERVAL)
        val future = clock.read().copy(wallMs = clock.wall + 30_000, elapsedMs = clock.elapsed + 30_000)
        check(agent.onLocationDecision(LocationFix(14.6, -90.5, 10.0, future)) == DiagnosticReason.TIME_IN_FUTURE)
        val foreignBoot = clock.read().copy(bootId = UUID.randomUUID().toString())
        check(agent.onLocationDecision(LocationFix(14.6, -90.5, 10.0, foreignBoot)) == DiagnosticReason.TIME_BOOT_CHANGED)
        check(agent.onLocationDecision(LocationFix(999.0, -90.5, 10.0, clock.read())) == DiagnosticReason.INVALID_FIX)
        val beforeAnchor = clock.read().copy(wallMs = start - 1, elapsedMs = 999)
        check(agent.onLocationDecision(LocationFix(14.6, -90.5, 10.0, beforeAnchor)) == DiagnosticReason.TIME_ANCHOR_INVALID)
        val summary = summarizeDiagnostics(diagnostics.events, store.read().pending)
        check(summary.callbacks == 6 && summary.accepted == 1 && summary.rejected == 5)
        check(summary.pendingLocations == 1 && summary.lastRejectReason == DiagnosticReason.TIME_ANCHOR_INVALID)
        check(diagnostics.events.none { it.toString().contains("14.6") || it.toString().contains("-90.5") })
        agent.refreshConfig(object : AuthenticatedConfigTransport {
            override fun fetch(identity: Identity) = snap(version = 8, active = false)
                .copy(serverTimeMs = clock.wall, verifiedAtMs = clock.wall, offlineNotAfterMs = end)
        })
        check(diagnostics.events.any { it.kind == DiagnosticKind.POLICY_RECEIVED && it.assignmentVersion == 8L })
        agent.tick()
        check(diagnostics.events.any { it.kind == DiagnosticKind.WINDOW_LEFT })
    }
    test("ADR-017 R2: only the instance validated online may continue offline") {
        val clock = FakeClock(); val (policy, _) = engine(clock); policy.load(snap())
        clock.advance(60_000); check(policy.current() != null)
        clock.advance(end - clock.wall)
        check(policy.current() == null && policy.assess().reason == DiagnosticReason.WINDOW_ENDED)
        val expiryClock = FakeClock(); val (expired, _) = engine(expiryClock)
        expired.load(snap().copy(offlineNotAfterMs = start + 120_000))
        expiryClock.advance(120_000)
        check(expired.assess().reason == DiagnosticReason.OFFLINE_EXPIRED)
        val futureClock = FakeClock(); val (futurePolicy, _) = engine(futureClock)
        futurePolicy.load(snap(windows = listOf(Window(scheduled, start + 3_600_000, start + 7_200_000))))
        check(futurePolicy.current() == null)
        futureClock.advance(3_600_000)
        check(futurePolicy.current() == null &&
            futurePolicy.assess().reason == DiagnosticReason.INSTANCE_NOT_ONLINE_VERIFIED)
        futurePolicy.load(snap(windows = listOf(Window(scheduled, start + 3_600_000, start + 7_200_000)))
            .copy(serverTimeMs = futureClock.wall, verifiedAtMs = futureClock.wall))
        check(futurePolicy.current() != null)
        val previousDay = ms("2026-10-20T23:30:00Z")
        val newDay = ms("2026-10-21T00:00:00Z")
        val newDayClock = FakeClock(wall = previousDay)
        val (newDayPolicy, _) = engine(newDayClock)
        newDayPolicy.load(Snapshot(Identity(device, installation), 7, true, anchor,
            previousDay, previousDay, previousDay + 12 * 3_600_000L,
            listOf(Window(scheduled, newDay, newDay + 3_600_000L)),
            Policy(policyId, 2, 60, 300, previousDay, newDay + 7_200_000L)))
        check(newDayPolicy.current() == null)
        newDayClock.advance(30 * 60_000L)
        check(newDayPolicy.current() == null &&
            newDayPolicy.assess().reason == DiagnosticReason.INSTANCE_NOT_ONLINE_VERIFIED)
        val reductionClock = FakeClock(); val (reduced, _) = engine(reductionClock)
        reduced.load(snap())
        reductionClock.advance(60_000)
        check(reduced.current() != null)
        reduced.load(snap(version = 8, windows = listOf(Window(UUID.randomUUID().toString(),
            start + 3_600_000, end))).copy(serverTimeMs = reductionClock.wall,
            verifiedAtMs = reductionClock.wall))
        check(reduced.current() == null)
    }
    test("R2 recovery intent is encrypted-state compatible and bound to the same instance and boot") {
        val clock = FakeClock(); val (policy, store) = engine(clock)
        policy.load(snap())
        val instance = requireNotNull(store.read().validatedInstance)
        val intent = TrackingIntent(installation, instance, start, boot)
        store.update { it.trackingIntent = intent }
        check(policy.mayRecover(intent))
        val persisted = StateCodec.decode(StateCodec.encode(store.read()))
        check(persisted.validatedInstance == instance && persisted.trackingIntent == intent)
        val legacy = JSONObject(StateCodec.encode(store.read()))
        legacy.remove("validated_instance"); legacy.remove("tracking_intent")
        check(StateCodec.decode(legacy.toString()).validatedInstance == null)
        check(!policy.mayRecover(intent.copy(installationId = UUID.randomUUID().toString())))
        clock.bootId = UUID.randomUUID().toString()
        check(!policy.mayRecover(intent))
        clock.bootId = boot
        store.update { it.trackingIntent = null }
        check(!policy.mayRecover(intent))
        store.update { it.trackingIntent = intent }
        clock.advance(end - clock.wall)
        check(!policy.mayRecover(intent))
    }
    test("R2 policy transition pauses the old listener and resumes only after online validation") {
        val clock = FakeClock(); val (policy, store) = engine(clock); policy.load(snap())
        val runtime = FakeRuntime(); val diagnostics = RecordingDiagnostics()
        val agent = TrackingController(Identity(device, installation), clock, policy, store,
            runtime, FakeHealth(), diagnostics)
        agent.tick()
        check(runtime.running && runtime.registrations == 1)
        clock.advance(60_000)
        val oldFix = clock.read().copy(wallMs = clock.wall - 1_000, elapsedMs = clock.elapsed - 1_000)
        agent.refreshConfig(object : AuthenticatedConfigTransport {
            override fun fetch(identity: Identity) = snap(version = 8)
                .copy(serverTimeMs = clock.wall, verifiedAtMs = clock.wall)
        })
        check(!runtime.running && runtime.pauses == 1 && runtime.hardStops == 0)
        agent.tick()
        check(runtime.running && runtime.registrations == 2 && runtime.hardStops == 0)
        check(agent.onLocationDecision(LocationFix(14.6, -90.5, 10.0, oldFix)) != DiagnosticReason.NONE)
        agent.refreshConfig(object : AuthenticatedConfigTransport {
            override fun fetch(identity: Identity) = snap(version = 9, active = false)
                .copy(serverTimeMs = clock.wall, verifiedAtMs = clock.wall)
        })
        agent.tick()
        check(!runtime.running && runtime.pauses == 2 && runtime.registrations == 2)
        check(policy.current() == null)
    }
    test("R1 synchronization records attempt, ACK and quarantine without payload") {
        val clock = FakeClock(); val store = MemoryAgentStore(); val diagnostics = RecordingDiagnostics()
        val first = UUID.randomUUID().toString(); val second = UUID.randomUUID().toString()
        fun add(id: String) = store.update { it.pending.add(PendingRecord(id, RecordKind.HEALTH,
            JSONObject().put("event_id", id).put("private_marker", "must-not-leak").toString(), start)) }
        add(first)
        var calls = 0
        val transport = object : BatchTransport {
            override fun post(kind: RecordKind, body: String): HttpResult {
                calls++
                if (calls == 2) return HttpResult(409, "{}", null)
                val batch = JSONObject(body)
                return HttpResult(200, JSONObject().put("batch_id", batch.getString("batch_id"))
                    .put("persisted_at", utc(clock.wall)).put("accepted_event_ids", JSONArray().put(first))
                    .put("duplicate_event_ids", JSONArray()).toString(), null)
            }
        }
        val sync = BatchSync(Identity(device, installation), store, clock, transport, diagnostics)
        check(sync.once(RecordKind.HEALTH) == SyncOutcome.ACKED)
        add(second)
        check(sync.once(RecordKind.HEALTH) == SyncOutcome.QUARANTINED)
        check(store.read().pending.single().quarantined)
        check(diagnostics.events.count { it.kind == DiagnosticKind.SYNC_ATTEMPT } == 2)
        check(diagnostics.events.any { it.kind == DiagnosticKind.SYNC_ACK && it.count == 1 })
        check(diagnostics.events.any { it.kind == DiagnosticKind.SYNC_QUARANTINE && it.count == 1 })
        check(diagnostics.events.none { it.toString().contains("must-not-leak") })
    }
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
        check(p.current() == null); clock.advance(3_600_000)
        check(p.current() == null)
        p.load(snap(version = 8, windows = listOf(Window(scheduled, start + 3_600_000, end)))
            .copy(serverTimeMs = clock.wall, verifiedAtMs = clock.wall))
        check(p.current() != null)
        clock.wall += 300_001; check(p.current() == null); clock.wall -= 300_001
        clock.bootId = UUID.randomUUID().toString(); check(p.current() == null)
        clock.bootId = boot; clock.advance(7 * 3_600_000); check(p.current() == null)
    }
    test("ADR-020 v2 authorizes later offline journeys and survives restart within explicit validity") {
        val clock = FakeClock()
        val (policy, store) = engine(clock)
        val offline = snap(until = start + 4 * 86_400_000L).copy(
            schemaVersion = 2, assignmentStartMs = start,
            authorizedUntilMs = start + 4 * 86_400_000L, tzdbVersion = "2026a",
            display = PolicyDisplay("Offline", (1..7).toList(), "22:00", "06:00", "America/Guatemala"))
        policy.load(offline)
        check(policy.current() != null)
        clock.automaticTime = false
        check(policy.current() == null && !policy.autonomousEligible())
        clock.automaticTime = true
        clock.advance(14 * 3_600_000L)
        check(policy.current() == null && policy.autonomousEligible())
        clock.advance(10 * 3_600_000L)
        check(policy.current() != null && policy.current()!!.window.startMs == start + 86_400_000L)
        val restarted = PolicyEngine(Identity(device, installation), clock, store)
        check(restarted.current() != null)
        clock.wall += 86_400_000L; clock.elapsed = 1000
        clock.bootId = UUID.randomUUID().toString()
        check(restarted.current() != null)
        clock.wall = start - 1000; clock.bootId = UUID.randomUUID().toString()
        check(restarted.current() == null)
        clock.wall = start + 2 * 86_400_000L; clock.bootId = UUID.randomUUID().toString()
        clock.automaticTime = false
        check(restarted.current() == null)
        clock.automaticTime = true
        clock.wall = start + 4 * 86_400_000L
        check(restarted.current() == null)
    }
    test("ADR-020 v2 exception OFF and replacement are enforced offline") {
        val clock = FakeClock()
        val (policy, _) = engine(clock)
        policy.load(snap(until = start + 4 * 86_400_000L).copy(
            schemaVersion = 2, assignmentStartMs = start,
            authorizedUntilMs = start + 4 * 86_400_000L, tzdbVersion = "2026a",
            display = PolicyDisplay("Exceptions", (1..7).toList(), "22:00", "06:00", "America/Guatemala",
                listOf(PolicyException("2026-10-20", "OFF"),
                    PolicyException("2026-10-21", "REPLACE", "23:00", "05:00")))))
        clock.advance(86_400_000L)
        check(policy.current() == null)
        clock.advance(86_400_000L)
        check(policy.current() == null)
        clock.advance(3_600_000L)
        check(policy.current() != null)
    }
    test("policy diagnostic distinguishes no assignment, scheduled window and clock drift") {
        val clock = FakeClock(); val (p, store) = engine(clock)
        check(p.evaluate().reason == "NO_CONFIG")
        p.load(snap(active = false)); check(p.evaluate().reason == "NO_ACTIVE_POLICY")
        p.load(snap(version = 8, windows = listOf(Window(scheduled, start + 3_600_000, end))))
        check(p.evaluate().reason == "OUTSIDE_WINDOW")
        clock.advance(3_600_000)
        check(p.evaluate().reason == "INSTANCE_NOT_ONLINE_VERIFIED")
        p.load(snap(version = 8, windows = listOf(Window(scheduled, start + 3_600_000, end)))
            .copy(serverTimeMs = clock.wall, verifiedAtMs = clock.wall))
        check(p.evaluate().window != null)
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
            RecordKind.HEALTH, "x".repeat(34_000_000), start)) } }.isFailure)
        check(reopened.read().pending.size == 1)
        bytes[bytes.lastIndex] = (bytes.last().toInt() xor 1).toByte(); Files.write(path, bytes)
        check(runCatching { reopened.read() }.isFailure)
        Files.deleteIfExists(path)
    }
    test("Wave C encrypted queue retains 4320 locations and reports 70/90 percent capacity") {
        val path = Files.createTempFile("geops-capacity-", ".bin")
        Files.delete(path)
        val key = KeyGenerator.getInstance("AES").run { init(256); generateKey() }
        val store = EncryptedFileAgentStore(path, key)
        store.update { state -> repeat(4320) { index ->
            state.pending.add(PendingRecord(UUID.randomUUID().toString(), RecordKind.LOCATION,
                JSONObject().put("event_id", UUID.randomUUID().toString())
                    .put("captured_at", utc(start + index * 60_000L))
                    .put("latitude", 14.6).put("longitude", -90.5).toString(),
                start + index * 60_000L, wireVersion = 3))
        } }
        val recovered = EncryptedFileAgentStore(path, key).read()
        check(recovered.pending.size == 4320 && recovered.pending.first().id == store.read().pending.first().id)
        check(recovered.pending.last().createdAtMs == start + 4319 * 60_000L)
        check(recovered.bufferUsageBytes < EncryptedFileAgentStore.MAX_BYTES)
        check(EncryptedFileAgentStore.alertLevel(23_500_000, 0) == 70)
        check(EncryptedFileAgentStore.alertLevel(30_300_000, 0) == 90)
        check(EncryptedFileAgentStore.alertLevel(0, 9000) == 90)
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
        repeat(3) {
            if (store.read().pending.any { it.kind == RecordKind.SESSION })
                check(sync.once(RecordKind.SESSION) == SyncOutcome.ACKED)
        }
        val locationOutcome = sync.once(RecordKind.LOCATION)
        check(locationOutcome == SyncOutcome.ACKED)
        check(store.read().locationsAcked == 1L && store.read().lastLocationAckedMs == clock.wall)
        check(sync.once(RecordKind.LOCATION) == SyncOutcome.EMPTY)
        check(store.read().locationsAcked == 1L)
    }
    test("v2 quarantines one local session without blocking another session's positions") {
        val clock = FakeClock()
        val store = MemoryAgentStore()
        val a = UUID.randomUUID().toString(); val b = UUID.randomUUID().toString()
        fun record(kind: RecordKind, clientId: String, type: String? = null): PendingRecord {
            val id = UUID.randomUUID().toString()
            val payload = JSONObject().put("event_id", id).put("client_session_id", clientId)
            if (type != null) payload.put("type", type)
            return PendingRecord(id, kind, payload.toString(), start)
        }
        val aStart = record(RecordKind.SESSION, a, "STARTED")
        val bStart = record(RecordKind.SESSION, b, "STARTED").copy(createdAtMs = start + 1)
        val aPoint = record(RecordKind.LOCATION, a)
        val bPoint = record(RecordKind.LOCATION, b).copy(createdAtMs = start + 1)
        store.update { it.pending.addAll(listOf(aStart, bStart, aPoint, bPoint)) }
        val attempted = mutableListOf<String>()
        val transport = object : BatchTransport {
            override fun post(kind: RecordKind, body: String): HttpResult = error("v1 not used")
            override fun supportsMixed() = true
            override fun postMixed(body: String): HttpResult {
                val batch = JSONObject(body)
                val clientId = batch.getString("client_session_id")
                attempted.add(clientId)
                val events = batch.getJSONArray("events")
                check(events.length() == 2 && events.getJSONObject(0).getString("kind") == "SESSION" &&
                    events.getJSONObject(1).getString("kind") == "POSITION")
                if (clientId == a) return HttpResult(409, "{}", null)
                val ids = JSONArray().put(bStart.id).put(bPoint.id)
                return HttpResult(200, JSONObject().put("batch_id", batch.getString("batch_id"))
                    .put("persisted_at", utc(clock.wall)).put("accepted_event_ids", ids)
                    .put("duplicate_event_ids", JSONArray()).put("session_mappings", JSONArray().put(
                        JSONObject().put("client_session_id", b).put("session_id", UUID.randomUUID().toString())))
                    .toString(), null)
            }
        }
        val sync = BatchSync(Identity(device, installation), store, clock, transport)
        check(sync.once(RecordKind.LOCATION) == SyncOutcome.QUARANTINED)
        check(store.read().pending.filter { it.quarantined }.map { it.id }.toSet() ==
            setOf(aStart.id, aPoint.id))
        check(sync.once(RecordKind.LOCATION) == SyncOutcome.ACKED)
        check(attempted == listOf(a, b) && store.read().pending.map { it.id }.toSet() ==
            setOf(aStart.id, aPoint.id))
        check(store.read().locationsAcked == 1L)
    }
    test("Wave D v3 retries one offline session without downgrade or premature deletion") {
        val clock = FakeClock()
        val store = MemoryAgentStore()
        val client = UUID.randomUUID().toString()
        val started = UUID.randomUUID().toString()
        val point = UUID.randomUUID().toString()
        store.update { state ->
            state.pending.add(PendingRecord(started, RecordKind.SESSION,
                JSONObject().put("event_id", started).put("client_session_id", client)
                    .put("type", "STARTED").toString(), start, wireVersion = 3))
            state.pending.add(PendingRecord(point, RecordKind.LOCATION,
                JSONObject().put("event_id", point).put("client_session_id", client).toString(),
                start + 1000, wireVersion = 3))
        }
        var calls = 0
        val transport = object : BatchTransport {
            override fun supportsOffline() = true
            override fun post(kind: RecordKind, body: String): HttpResult = error("v1 downgrade")
            override fun postOffline(body: String): HttpResult {
                calls++
                val batch = JSONObject(body)
                check(batch.getInt("schema_version") == 3 && batch.getJSONArray("events").length() == 2)
                if (calls == 1) return HttpResult(429, "{}", 30)
                return HttpResult(200, JSONObject().put("batch_id", batch.getString("batch_id"))
                    .put("persisted_at", utc(clock.wall))
                    .put("accepted_event_ids", JSONArray().put(started).put(point))
                    .put("duplicate_event_ids", JSONArray())
                    .put("session_mappings", JSONArray().put(JSONObject()
                        .put("client_session_id", client).put("session_id", UUID.randomUUID().toString())))
                    .toString(), null)
            }
        }
        val sync = BatchSync(Identity(device, installation), store, clock, transport)
        check(sync.once(RecordKind.LOCATION) == SyncOutcome.RETRY)
        check(store.read().pending.size == 2 && sync.nextEligibleAtMs() == clock.wall + 30_000L)
        check(sync.once(RecordKind.LOCATION) == SyncOutcome.EMPTY && calls == 1)
        clock.advance(30_000)
        check(sync.once(RecordKind.LOCATION) == SyncOutcome.ACKED && calls == 2)
        check(store.read().pending.isEmpty() && store.read().locationsAcked == 1L)
    }
    test("Wave D v3 STARTED backoff does not block another offline session") {
        val clock = FakeClock()
        val store = MemoryAgentStore()
        val first = UUID.randomUUID().toString(); val second = UUID.randomUUID().toString()
        val ids = mutableMapOf<String, List<String>>()
        store.update { state ->
            for ((index, client) in listOf(first, second).withIndex()) {
                val started = UUID.randomUUID().toString(); val point = UUID.randomUUID().toString()
                ids[client] = listOf(started, point)
                state.pending.add(PendingRecord(started, RecordKind.SESSION,
                    JSONObject().put("event_id", started).put("client_session_id", client)
                        .put("type", "STARTED").toString(), start + index, wireVersion = 3))
                state.pending.add(PendingRecord(point, RecordKind.LOCATION,
                    JSONObject().put("event_id", point).put("client_session_id", client).toString(),
                    start + index + 1000, wireVersion = 3))
            }
        }
        val attempted = mutableListOf<String>()
        val transport = object : BatchTransport {
            override fun supportsOffline() = true
            override fun post(kind: RecordKind, body: String): HttpResult = error("v1 downgrade")
            override fun postOffline(body: String): HttpResult {
                val batch = JSONObject(body)
                val client = batch.getString("client_session_id")
                attempted.add(client)
                if (client == first) return HttpResult(429, "{}", 30)
                return HttpResult(200, JSONObject().put("batch_id", batch.getString("batch_id"))
                    .put("persisted_at", utc(clock.wall))
                    .put("accepted_event_ids", JSONArray().put(ids[client]!![0]).put(ids[client]!![1]))
                    .put("duplicate_event_ids", JSONArray())
                    .put("session_mappings", JSONArray().put(JSONObject()
                        .put("client_session_id", client).put("session_id", UUID.randomUUID().toString())))
                    .toString(), null)
            }
        }
        val sync = BatchSync(Identity(device, installation), store, clock, transport)
        check(sync.once(RecordKind.LOCATION) == SyncOutcome.RETRY)
        check(sync.once(RecordKind.LOCATION) == SyncOutcome.ACKED)
        check(attempted == listOf(first, second) && store.read().pending.map { it.id }.toSet() ==
            ids[first]!!.toSet())
    }
    test("upload loop sends STARTED and first position together before v1 session transport") {
        val clock = FakeClock(wall = end + 3_600_000)
        val store = MemoryAgentStore()
        val clientId = UUID.randomUUID().toString()
        val startedId = UUID.randomUUID().toString()
        val pointId = UUID.randomUUID().toString()
        store.update { state ->
            state.snapshot = snap()
            state.pending.add(PendingRecord(startedId, RecordKind.SESSION,
                JSONObject().put("event_id", startedId).put("client_session_id", clientId)
                    .put("type", "STARTED").toString(), start))
            state.pending.add(PendingRecord(pointId, RecordKind.LOCATION,
                JSONObject().put("event_id", pointId).put("client_session_id", clientId)
                    .toString(), start + 60_000))
        }
        var mixedCalls = 0
        val transport = object : BatchTransport {
            override fun supportsMixed() = true
            override fun post(kind: RecordKind, body: String): HttpResult = error("v1 must not run")
            override fun postMixed(body: String): HttpResult {
                mixedCalls++
                val batch = JSONObject(body)
                val events = batch.getJSONArray("events")
                check(events.length() == 2 && events.getJSONObject(0).getString("kind") == "SESSION")
                return HttpResult(200, JSONObject().put("batch_id", batch.getString("batch_id"))
                    .put("persisted_at", utc(clock.wall))
                    .put("accepted_event_ids", JSONArray().put(startedId).put(pointId))
                    .put("duplicate_event_ids", JSONArray()).put("session_mappings", JSONArray().put(
                        JSONObject().put("client_session_id", clientId)
                            .put("session_id", UUID.randomUUID().toString())))
                    .toString(), null)
            }
        }
        val identity = Identity(device, installation)
        val result = PendingUpload(identity, store, clock, BatchSync(identity, store, clock, transport)).run()
        check(result.status == UploadStatus.EMPTY && mixedCalls == 1 && store.read().pending.isEmpty())
    }
    test("v2 rate limit keeps STARTED and position in backoff without a v1 bypass") {
        val clock = FakeClock(wall = end + 3_600_000)
        val store = MemoryAgentStore()
        val clientId = UUID.randomUUID().toString()
        val startedId = UUID.randomUUID().toString()
        val pointId = UUID.randomUUID().toString()
        store.update { state ->
            state.snapshot = snap()
            state.pending.add(PendingRecord(startedId, RecordKind.SESSION,
                JSONObject().put("event_id", startedId).put("client_session_id", clientId)
                    .put("type", "STARTED").toString(), start))
            state.pending.add(PendingRecord(pointId, RecordKind.LOCATION,
                JSONObject().put("event_id", pointId).put("client_session_id", clientId)
                    .toString(), start + 60_000))
        }
        var v1Calls = 0
        var v2Calls = 0
        val transport = object : BatchTransport {
            override fun supportsMixed() = true
            override fun post(kind: RecordKind, body: String): HttpResult {
                v1Calls++
                return HttpResult(200, "{}", null)
            }
            override fun postMixed(body: String): HttpResult {
                v2Calls++
                return HttpResult(429, "{}", 30)
            }
        }
        val identity = Identity(device, installation)
        val sync = BatchSync(identity, store, clock, transport)
        val result = PendingUpload(identity, store, clock, sync).run()
        check(result.status == UploadStatus.PENDING && v2Calls == 1 && v1Calls == 0)
        check(store.read().pending.all { it.retryAfterMs > clock.wall })
        val freshId = UUID.randomUUID().toString()
        store.update { it.pending.add(PendingRecord(freshId, RecordKind.LOCATION,
            JSONObject().put("event_id", freshId).put("client_session_id", clientId)
                .toString(), start + 120_000)) }
        val deferred = PendingUpload(identity, store, clock, sync).run()
        check(deferred.status == UploadStatus.PENDING && deferred.nextDelayMs >= 30_000 &&
            v2Calls == 1 && v1Calls == 0)
        check(sync.once(RecordKind.LOCATION) == SyncOutcome.EMPTY &&
            sync.lastDetail == SyncDetail.BACKOFF && v2Calls == 1)
        val otherClient = UUID.randomUUID().toString()
        val otherStart = UUID.randomUUID().toString()
        val otherPoint = UUID.randomUUID().toString()
        store.update { state ->
            state.pending.add(PendingRecord(otherStart, RecordKind.SESSION,
                JSONObject().put("event_id", otherStart).put("client_session_id", otherClient)
                    .put("type", "STARTED").toString(), start + 180_000))
            state.pending.add(PendingRecord(otherPoint, RecordKind.LOCATION,
                JSONObject().put("event_id", otherPoint).put("client_session_id", otherClient)
                    .toString(), start + 180_000))
        }
        check(sync.nextEligibleAtMs()!! <= clock.wall)
        check(sync.once(RecordKind.LOCATION) == SyncOutcome.RETRY && v2Calls == 2 && v1Calls == 0)
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
    test("R3 uploads multiple encrypted backlog batches after the work window without a tracking runtime") {
        val clock = FakeClock(wall = end + 3_600_000)
        val store = MemoryAgentStore()
        val ids = (0 until 205).map { UUID.randomUUID().toString() }
        store.update { state ->
            state.snapshot = snap()
            ids.forEach { id -> state.pending.add(PendingRecord(id, RecordKind.LOCATION,
                JSONObject().put("event_id", id).put("assignment_version", 7).toString(), start)) }
        }
        var calls = 0
        val transport = object : BatchTransport {
            override fun post(kind: RecordKind, body: String): HttpResult {
                check(kind == RecordKind.LOCATION)
                calls++
                val batch = JSONObject(body)
                val events = batch.getJSONArray("events")
                val accepted = JSONArray()
                repeat(events.length()) { accepted.put(events.getJSONObject(it).getString("event_id")) }
                return HttpResult(200, JSONObject().put("batch_id", batch.getString("batch_id"))
                    .put("persisted_at", utc(clock.wall)).put("accepted_event_ids", accepted)
                    .put("duplicate_event_ids", JSONArray()).toString(), null)
            }
        }
        val result = PendingUpload(Identity(device, installation), store, clock,
            BatchSync(Identity(device, installation), store, clock, transport)).run()
        check(result.status == UploadStatus.EMPTY && calls == 3 && store.read().pending.isEmpty())
    }
    test("R3 lost HTTP response retries identical event and accepts duplicate ACK") {
        val clock = FakeClock(wall = end + 1000)
        val store = MemoryAgentStore()
        val id = UUID.randomUUID().toString()
        store.update { it.snapshot = snap(); it.pending.add(PendingRecord(id, RecordKind.LOCATION,
            JSONObject().put("event_id", id).put("assignment_version", 7).toString(), start)) }
        var calls = 0
        val transport = object : BatchTransport {
            override fun post(kind: RecordKind, body: String): HttpResult {
                calls++
                if (calls == 1) throw java.net.SocketTimeoutException()
                val batch = JSONObject(body)
                check(batch.getJSONArray("events").getJSONObject(0).getString("event_id") == id)
                return HttpResult(200, JSONObject().put("batch_id", batch.getString("batch_id"))
                    .put("persisted_at", utc(clock.wall)).put("accepted_event_ids", JSONArray())
                    .put("duplicate_event_ids", JSONArray().put(id)).toString(), null)
            }
        }
        val upload = PendingUpload(Identity(device, installation), store, clock,
            BatchSync(Identity(device, installation), store, clock, transport))
        check(upload.run().status == UploadStatus.PENDING && calls == 1)
        clock.advance(3000)
        check(upload.run().status == UploadStatus.EMPTY && calls == 2 && store.read().pending.isEmpty())
    }
    test("R3 network return during the shift drains ciphertext after a new store instance") {
        val path = Files.createTempFile("geops-r3-restart-", ".bin")
        Files.delete(path)
        val key = KeyGenerator.getInstance("AES").run { init(256); generateKey() }
        val before = EncryptedFileAgentStore(path, key)
        val id = UUID.randomUUID().toString()
        before.update { it.snapshot = snap(); it.pending.add(PendingRecord(id, RecordKind.LOCATION,
            JSONObject().put("event_id", id).put("captured_at", utc(start + 60_000)).toString(), start + 60_000)) }
        val clock = FakeClock(wall = start + 360_000)
        var network = false
        val transport = object : BatchTransport {
            override fun post(kind: RecordKind, body: String): HttpResult {
                if (!network) throw java.net.UnknownHostException()
                val batch = JSONObject(body)
                return HttpResult(200, JSONObject().put("batch_id", batch.getString("batch_id"))
                    .put("persisted_at", utc(clock.wall))
                    .put("accepted_event_ids", JSONArray().put(id))
                    .put("duplicate_event_ids", JSONArray()).toString(), null)
            }
        }
        val identity = Identity(device, installation)
        check(PendingUpload(identity, before, clock, BatchSync(identity, before, clock, transport))
            .run().status == UploadStatus.PENDING)
        check(before.read().pending.single().id == id)
        // A new handle models process recreation; upload has no boot-bound capture authorization.
        val after = EncryptedFileAgentStore(path, key)
        network = true; clock.advance(3000); clock.bootId = UUID.randomUUID().toString()
        check(PendingUpload(identity, after, clock, BatchSync(identity, after, clock, transport))
            .run().status == UploadStatus.EMPTY)
        check(after.read().pending.isEmpty())
        Files.deleteIfExists(path)
    }
    test("R3 safety sweep does not send a new event before policy sync interval") {
        val clock = FakeClock(wall = start + 1000); val store = MemoryAgentStore()
        val id = UUID.randomUUID().toString()
        store.update { it.snapshot = snap(); it.pending.add(PendingRecord(id, RecordKind.HEALTH,
            JSONObject().put("event_id", id).toString(), start)) }
        var calls = 0
        val transport = object : BatchTransport {
            override fun post(kind: RecordKind, body: String): HttpResult {
                calls++
                val batch = JSONObject(body)
                return HttpResult(200, JSONObject().put("batch_id", batch.getString("batch_id"))
                    .put("persisted_at", utc(clock.wall))
                    .put("accepted_event_ids", JSONArray().put(id))
                    .put("duplicate_event_ids", JSONArray()).toString(), null)
            }
        }
        val identity = Identity(device, installation)
        val upload = PendingUpload(identity, store, clock, BatchSync(identity, store, clock, transport))
        val waiting = upload.run()
        check(waiting.status == UploadStatus.PENDING && waiting.nextDelayMs == 299_000L && calls == 0)
        clock.advance(waiting.nextDelayMs)
        check(upload.run().status == UploadStatus.EMPTY && calls == 1)
    }
    test("R3 401 and 403 block further uploads; foreign identity is never posted") {
        for (status in listOf(401, 403)) {
            val clock = FakeClock(wall = start + 300_001); val store = MemoryAgentStore(); var calls = 0
            val id = UUID.randomUUID().toString()
            store.update { it.snapshot = snap(); it.pending.add(PendingRecord(id, RecordKind.HEALTH,
                JSONObject().put("event_id", id).toString(), start)) }
            val sync = BatchSync(Identity(device, installation), store, clock, object : BatchTransport {
                override fun post(kind: RecordKind, body: String): HttpResult {
                    calls++; return HttpResult(status, "{}", null)
                }
            })
            val upload = PendingUpload(Identity(device, installation), store, clock, sync)
            check(upload.run().status == UploadStatus.AUTH_REQUIRED)
            check(upload.run().status == UploadStatus.AUTH_REQUIRED && calls == 1)
            check(store.read().pending.single().id == id)
        }
        val store = MemoryAgentStore(); store.update { it.snapshot = snap() }
        var called = false
        val sync = BatchSync(Identity(device, UUID.randomUUID().toString()), store, FakeClock(),
            object : BatchTransport { override fun post(kind: RecordKind, body: String): HttpResult {
                called = true; error("foreign_upload")
            } })
        check(PendingUpload(Identity(device, UUID.randomUUID().toString()), store, FakeClock(), sync)
            .run().status == UploadStatus.IDENTITY_MISMATCH && !called)
    }
    test("R3 revoked PoP session challenge fails closed without discarding the queue") {
        val clock = FakeClock(wall = start + 300_001); val store = MemoryAgentStore()
        val id = UUID.randomUUID().toString()
        store.update { it.snapshot = snap(); it.pending.add(PendingRecord(id, RecordKind.HEALTH,
            JSONObject().put("event_id", id).toString(), start)) }
        val sync = BatchSync(Identity(device, installation), store, clock, object : BatchTransport {
            override fun post(kind: RecordKind, body: String): HttpResult =
                throw IllegalArgumentException("session_challenge_http_403")
        })
        check(PendingUpload(Identity(device, installation), store, clock, sync).run().status == UploadStatus.AUTH_REQUIRED)
        check(store.read().uploadAuthBlocked && store.read().pending.single().id == id)
    }
    test("R3 policy replacement cannot reattribute pending events to a new installation") {
        val clock = FakeClock(); val store = MemoryAgentStore()
        val oldIdentity = Identity(device, installation)
        val newIdentity = Identity(device, UUID.randomUUID().toString())
        store.update { it.snapshot = snap(); it.highestAssignmentVersion = 7
            it.pending.add(PendingRecord(UUID.randomUUID().toString(), RecordKind.LOCATION,
                JSONObject().put("event_id", UUID.randomUUID().toString()).toString(), start)) }
        val incoming = snap(version = 8).copy(identity = newIdentity)
        val engine = PolicyEngine(newIdentity, clock, store)
        check(runCatching { engine.refresh(object : AuthenticatedConfigTransport {
            override fun fetch(identity: Identity) = incoming
        }) }.exceptionOrNull()?.message == "pending_foreign_identity")
        check(store.read().snapshot?.identity == oldIdentity && store.read().pending.size == 1)
    }
    test("R3 policy revision during upload leaves the historical event version unchanged") {
        val clock = FakeClock(wall = end + 1000); val store = MemoryAgentStore()
        val id = UUID.randomUUID().toString()
        store.update { it.snapshot = snap(); it.pending.add(PendingRecord(id, RecordKind.LOCATION,
            JSONObject().put("event_id", id).put("assignment_version", 7).toString(), start)) }
        val transport = object : BatchTransport {
            override fun post(kind: RecordKind, body: String): HttpResult {
                val batch = JSONObject(body)
                check(batch.getJSONArray("events").getJSONObject(0).getInt("assignment_version") == 7)
                store.update { it.snapshot = snap(version = 8); it.highestAssignmentVersion = 8 }
                return HttpResult(200, JSONObject().put("batch_id", batch.getString("batch_id"))
                    .put("persisted_at", utc(clock.wall))
                    .put("accepted_event_ids", JSONArray().put(id))
                    .put("duplicate_event_ids", JSONArray()).toString(), null)
            }
        }
        val upload = PendingUpload(Identity(device, installation), store, clock,
            BatchSync(Identity(device, installation), store, clock, transport))
        check(upload.run().status == UploadStatus.EMPTY)
        check(store.read().snapshot?.assignmentVersion == 8L && store.read().pending.isEmpty())
    }
    test("R3 429 and 5xx preserve ciphertext queue and retry after backoff") {
        for (status in listOf(429, 500, 503)) {
            val clock = FakeClock(wall = start + 300_001); val store = MemoryAgentStore()
            val id = UUID.randomUUID().toString()
            store.update { it.snapshot = snap(); it.pending.add(PendingRecord(id, RecordKind.HEALTH,
                JSONObject().put("event_id", id).toString(), start)) }
            val transport = object : BatchTransport {
                override fun post(kind: RecordKind, body: String) = HttpResult(status, "{}", 45)
            }
            val upload = PendingUpload(Identity(device, installation), store, clock,
                BatchSync(Identity(device, installation), store, clock, transport))
            check(upload.run().status == UploadStatus.PENDING)
            check(store.read().pending.single().retryAfterMs > clock.wall)
            check(store.read().pending.single().id == id)
        }
    }
    test("R3 separate encrypted store handles serialize capture and ACK updates") {
        val path = Files.createTempFile("geops-r3-state-", ".bin")
        Files.delete(path)
        val key = KeyGenerator.getInstance("AES").run { init(256); generateKey() }
        val first = EncryptedFileAgentStore(path, key)
        val second = EncryptedFileAgentStore(path, key)
        val ids = (0 until 40).map { UUID.randomUUID().toString() }
        val threads = listOf(first, second).mapIndexed { index, store ->
            Thread { ids.drop(index * 20).take(20).forEach { id -> store.update { state ->
                state.pending.add(PendingRecord(id, RecordKind.HEALTH,
                    JSONObject().put("event_id", id).toString(), start))
            } } }
        }
        threads.forEach(Thread::start); threads.forEach(Thread::join)
        check(first.read().pending.map { it.id }.toSet() == ids.toSet())
        Files.deleteIfExists(path)
    }
    test("R3 scheduling failure is diagnosable without losing a persisted event") {
        val clock = FakeClock(); val store = MemoryAgentStore()
        val policy = PolicyEngine(Identity(device, installation), clock, store)
        policy.load(snap())
        val diagnostics = RecordingDiagnostics()
        val controller = TrackingController(Identity(device, installation), clock, policy, store,
            FakeRuntime(), FakeHealth(), diagnostics) { throw IllegalStateException("job_unavailable") }
        controller.tick()
        check(store.read().pending.isNotEmpty())
        check(diagnostics.events.any { it.kind == DiagnosticKind.SYNC_RETRY &&
            it.reason == DiagnosticReason.SCHEDULING_FAILED })
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
