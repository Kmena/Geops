package com.geops.mobile

import android.content.Context
import android.location.Location
import android.provider.Settings
import com.geops.agent.AndroidAgentClock
import com.geops.agent.AndroidHealthProbe
import com.geops.agent.AndroidKeys
import com.geops.agent.BatchSync
import com.geops.agent.EncryptedFileAgentStore
import com.geops.agent.GeopsLocationService
import com.geops.agent.Identity
import com.geops.agent.LocationFix
import com.geops.agent.PopBatchTransport
import com.geops.agent.PopConfigTransport
import com.geops.agent.PopHttpClient
import com.geops.agent.PolicyEngine
import com.geops.agent.RecordKind
import com.geops.agent.RefreshingSessionProvider
import com.geops.agent.SYNTHETIC_STAGING_BASE_URL
import com.geops.agent.SyncOutcome
import com.geops.agent.TrackingController
import java.nio.file.Files
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ExecutorService
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit

/** One foreground tracking run, initiated only from a visible Activity. */
object AgentRuntime {
    const val SIGNING_ALIAS = "geops-test-identity-v1"
    private const val STATE_ALIAS = "geops-test-state-v1"
    private var scheduler: ScheduledExecutorService? = null
    private var captureExecutor: ExecutorService? = null
    private var service: GeopsLocationService? = null

    fun start(locationService: GeopsLocationService): String {
        synchronized(this) {
            require(scheduler == null) { "already_running" }
            service = locationService
        }
        try {
            val context = locationService.applicationContext
            val preferences = context.getSharedPreferences("geops_agent_identity", Context.MODE_PRIVATE)
            val deviceId = preferences.getString("device_id", null) ?: error("device_missing")
            val keyId = preferences.getString("key_id", null) ?: error("key_missing")
            val installationId = preferences.getString("installation_id", null) ?: error("installation_missing")
            val boot = bootId(context)
            val clock = AndroidAgentClock { boot }
            val stateFile = context.filesDir.toPath().resolve("agent-state.bin")
            val stateKey = try { AndroidKeys.existingStateKey(STATE_ALIAS) } catch (missing: IllegalStateException) {
                if (Files.exists(stateFile)) throw missing
                AndroidKeys.createStateKey(STATE_ALIAS)
            }
            val store = EncryptedFileAgentStore(stateFile, stateKey)
            // A process restart is never proof of an observed STOPPED event.
            store.update { if (it.session != null) it.session?.state = "UNKNOWN_END" }
            val identity = Identity(deviceId, installationId)
            val signer = AndroidKeys.existingEnrollmentSigner(SIGNING_ALIAS)
            val sessionProvider = RefreshingSessionProvider(deviceId, keyId, signer,
                com.geops.agent.HttpsEnrollmentTransport(SYNTHETIC_STAGING_BASE_URL))
            val http = PopHttpClient(SYNTHETIC_STAGING_BASE_URL, sessionProvider,
                AndroidKeys.existingSigningKey(SIGNING_ALIAS, keyId), clock)
            val policy = PolicyEngine(identity, clock, store)
            lateinit var controller: TrackingController
            val capture = Executors.newSingleThreadExecutor()
            synchronized(this) { captureExecutor = capture }
            val runtime = locationService.runtime { fix: Location ->
                val reading = clock.read().copy(wallMs = fix.time,
                    elapsedMs = fix.elapsedRealtimeNanos / 1_000_000L)
                try {
                    if (!capture.isShutdown) capture.execute {
                        try {
                            controller.onLocation(LocationFix(fix.latitude, fix.longitude,
                                fix.accuracy.toDouble(), reading))
                        } catch (_: Exception) {
                            try { controller.stop("BUFFER_UNAVAILABLE") } catch (_: Exception) { }
                            locationService.stopSelf()
                            stop()
                        }
                    }
                } catch (_: RejectedExecutionException) { /* Service is stopping. */ }
            }
            controller = TrackingController(identity, clock, policy, store, runtime,
                AndroidHealthProbe(context))
            val config = PopConfigTransport(http)
            controller.refreshConfig(config)
            controller.tick()
            if (!runtime.isRegistered()) {
                locationService.stopSelf()
                return "Sin ventana autorizada o inicio GPS bloqueado; se conservó el diagnóstico."
            }
            val sync = BatchSync(identity, store, clock, PopBatchTransport(http, healthContractApproved = true))
            val timer = Executors.newSingleThreadScheduledExecutor()
            synchronized(this) { scheduler = timer }
            var lastConfigAt = System.currentTimeMillis()
            var lastSyncAt = 0L
            timer.scheduleAtFixedRate({
                try {
                    if (System.currentTimeMillis() - lastConfigAt >= 300_000L) {
                        try { controller.refreshConfig(config); lastConfigAt = System.currentTimeMillis() }
                        catch (failure: Exception) {
                            if (failure.message == "config_http_401" || failure.message == "config_http_403") {
                                controller.stop("AUTH_REVOKED")
                                locationService.stopSelf()
                                stop()
                                return@scheduleAtFixedRate
                            }
                        }
                    }
                    controller.tick()
                    val now = System.currentTimeMillis()
                    val syncEvery = (policy.snapshot()?.policy?.syncIntervalS ?: 300) * 1000L
                    if (now - lastSyncAt >= syncEvery) {
                        for (kind in listOf(RecordKind.SESSION, RecordKind.LOCATION, RecordKind.HEALTH)) {
                            if (sync.once(kind) == SyncOutcome.AUTH_REQUIRED) {
                                controller.stop("AUTH_REVOKED")
                                locationService.stopSelf()
                                stop()
                                return@scheduleAtFixedRate
                            }
                        }
                        lastSyncAt = now
                    }
                    if (!runtime.isRegistered()) { locationService.stopSelf(); stop() }
                } catch (_: Exception) {
                    // The encrypted queue is retained for the next visible recovery; no event is ACKed here.
                    locationService.stopSelf()
                    stop()
                }
            }, 0, 30, TimeUnit.SECONDS)
            return "Seguimiento autorizado iniciado con notificación visible."
        } catch (failure: Exception) {
            locationService.stopSelf()
            stop()
            throw failure
        }
    }

    @Synchronized fun stop() {
        scheduler?.shutdownNow()
        captureExecutor?.shutdownNow()
        scheduler = null
        captureExecutor = null
        service = null
    }

    private fun bootId(context: Context): String {
        val preferences = context.getSharedPreferences("geops_agent_boot", Context.MODE_PRIVATE)
        val count = Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT, -1)
        val previous = preferences.getInt("count", -2)
        val saved = preferences.getString("id", null)
        if (count >= 0 && count == previous && saved != null) return saved
        val next = UUID.randomUUID().toString()
        if (count >= 0) preferences.edit().putInt("count", count).putString("id", next).apply()
        return next
    }
}
