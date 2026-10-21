package com.geops.mobile

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.location.Location
import android.os.Build
import android.provider.Settings
import com.geops.agent.AndroidAgentClock
import com.geops.agent.AndroidHealthProbe
import com.geops.agent.AndroidKeys
import com.geops.agent.EncryptedFileAgentStore
import com.geops.agent.EncryptedDiagnosticJournal
import com.geops.agent.DiagnosticFiles
import com.geops.agent.GeopsLocationService
import com.geops.agent.Identity
import com.geops.agent.LocationFix
import com.geops.agent.PopConfigTransport
import com.geops.agent.PopHttpClient
import com.geops.agent.PolicyEngine
import com.geops.agent.RefreshingSessionProvider
import com.geops.agent.SYNTHETIC_STAGING_BASE_URL
import com.geops.agent.TrackingController
import com.geops.agent.TrackingIntent
import com.geops.agent.AgentStore
import com.geops.agent.summarizeDiagnostics
import java.time.Instant
import java.nio.file.Files
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ExecutorService
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit

/** One foreground tracking run, initiated only from a visible Activity. */
object AgentRuntime {
    const val SIGNING_ALIAS = "geops-test-identity-v1"
    internal const val STATE_ALIAS = "geops-test-state-v1"
    private var scheduler: ScheduledExecutorService? = null
    private var captureExecutor: ExecutorService? = null
    private var service: GeopsLocationService? = null
    private var activeStore: AgentStore? = null
    private var activeController: TrackingController? = null
    private var starting = false
    private var stopGeneration = 0L

    fun start(locationService: GeopsLocationService): String = startInternal(locationService, recovery = false)

    /** Invoked only for Android redelivery of an already-started foreground service. */
    fun recover(locationService: GeopsLocationService) {
        try { startInternal(locationService, recovery = true) }
        catch (failure: Exception) {
            if (failure.message == "already_running") return
            locationService.stopSelf()
            synchronized(this) { if (service === locationService) stop() }
        }
    }

    private fun startInternal(locationService: GeopsLocationService, recovery: Boolean): String {
        val runGeneration: Long
        synchronized(this) {
            if (scheduler != null && service === locationService) return "Seguimiento ya activo."
            require(!starting && scheduler == null) { "already_running" }
            starting = true
            service = locationService
            runGeneration = stopGeneration
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
            synchronized(this) { activeStore = store }
            val identity = Identity(deviceId, installationId)
            val diagnostics = EncryptedDiagnosticJournal(DiagnosticFiles.scoped(context.noBackupFilesDir.toPath(), identity), stateKey)
            locationService.attachDiagnostics(diagnostics)
            val signer = AndroidKeys.existingEnrollmentSigner(SIGNING_ALIAS)
            val sessionProvider = RefreshingSessionProvider(deviceId, keyId, signer,
                com.geops.agent.HttpsEnrollmentTransport(SYNTHETIC_STAGING_BASE_URL))
            val http = PopHttpClient(SYNTHETIC_STAGING_BASE_URL, sessionProvider,
                AndroidKeys.existingSigningKey(SIGNING_ALIAS, keyId), clock)
            val policy = PolicyEngine(identity, clock, store)
            val priorIntent = store.read().trackingIntent
            if (recovery) {
                require(priorIntent != null && policy.mayRecover(priorIntent) &&
                    !userRequestedExit(context, priorIntent.requestedAtMs)) { "recovery_not_authorized" }
            }
            // Process death is not evidence of an observed STOPPED event.
            store.update { if (it.session != null) it.session?.state = "UNKNOWN_END" }
            lateinit var controller: TrackingController
            val capture = Executors.newSingleThreadExecutor()
            synchronized(this) { captureExecutor = capture }
            val runtime = locationService.runtime { fix: Location, listenerToken: Long ->
                val received = clock.read()
                val reading = received.copy(wallMs = fix.time,
                    elapsedMs = fix.elapsedRealtimeNanos / 1_000_000L)
                try {
                    if (!capture.isShutdown) capture.execute {
                        try {
                            synchronized(this) {
                                if (stopGeneration != runGeneration ||
                                    !locationService.isCurrentListener(listenerToken)) return@execute
                                controller.onLocation(LocationFix(fix.latitude, fix.longitude,
                                    fix.accuracy.toDouble(), reading, received.wallMs))
                            }
                        } catch (_: Exception) {
                            try { controller.stop("BUFFER_UNAVAILABLE") } catch (_: Exception) { }
                            locationService.stopSelf()
                            stop()
                        }
                    }
                } catch (_: RejectedExecutionException) { /* Service is stopping. */ }
            }
            controller = TrackingController(identity, clock, policy, store, runtime,
                AndroidHealthProbe(context), diagnostics) {
                val queued = store.read()
                if (!queued.uploadAuthBlocked) SyncJobs.enqueuePending(context,
                    (queued.snapshot?.policy?.syncIntervalS ?: 300) * 1000L)
            }
            synchronized(this) { activeController = controller }
            val config = PopConfigTransport(http)
            if (recovery) {
                try { controller.refreshConfig(config) }
                catch (failure: Exception) {
                    if (!transientConfigFailure(failure)) throw failure
                    // The same verified instance may continue only until its bounded offline expiry.
                }
            } else controller.refreshConfig(config)
            // A fresh authenticated config is required to clear a prior upload-auth rejection.
            if (store.read().uploadAuthBlocked) {
                require(!recovery) { "upload_auth_blocked" }
                store.update { it.uploadAuthBlocked = false }
            }
            synchronized(this) {
                require(runGeneration == stopGeneration) { "tracking_stopped" }
                controller.tick()
                if (!runtime.isRegistered()) {
                    locationService.stopSelf()
                    return "Sin ventana autorizada o inicio GPS bloqueado; se conservó el diagnóstico."
                }
                persistIntent(store, policy, identity, clock.read().bootId,
                    priorIntent?.requestedAtMs.takeIf { recovery } ?: clock.read().wallMs)
            }
            if (store.read().pending.any { !it.quarantined }) SyncJobs.enqueuePending(context,
                (store.read().snapshot?.policy?.syncIntervalS ?: 300) * 1000L)
            val timer = Executors.newSingleThreadScheduledExecutor()
            synchronized(this) { scheduler = timer }
            var lastConfigAt = System.currentTimeMillis()
            timer.scheduleAtFixedRate({
                try {
                    if (synchronized(this) { runGeneration != stopGeneration }) return@scheduleAtFixedRate
                    if (System.currentTimeMillis() - lastConfigAt >= 300_000L) {
                        try { controller.refreshConfig(config); lastConfigAt = System.currentTimeMillis() }
                        catch (failure: Exception) {
                            if (!transientConfigFailure(failure)) {
                                controller.stop("AUTH_REVOKED")
                                locationService.stopSelf()
                                stop()
                                return@scheduleAtFixedRate
                            }
                        }
                    }
                    synchronized(this) {
                        if (runGeneration != stopGeneration) return@scheduleAtFixedRate
                        controller.tick()
                        if (runtime.isRegistered()) persistIntent(store, policy, identity,
                            clock.read().bootId, store.read().trackingIntent?.requestedAtMs ?: clock.read().wallMs)
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
        } finally {
            synchronized(this) { starting = false }
        }
    }

    private fun persistIntent(store: AgentStore, policy: PolicyEngine, identity: Identity,
                              boot: String, requestedAtMs: Long) {
        val allowed = policy.current() ?: return
        val instance = store.read().validatedInstance ?: return
        require(instance.scheduledId == allowed.window.scheduledSessionId) { "instance_changed" }
        store.update { it.trackingIntent = TrackingIntent(identity.installationId,
            instance, requestedAtMs, boot) }
    }

    @Synchronized fun stop() {
        stopGeneration++
        scheduler?.shutdownNow()
        captureExecutor?.shutdownNow()
        try { activeStore?.update { it.trackingIntent = null } } catch (_: Exception) { }
        scheduler = null
        captureExecutor = null
        activeStore = null
        activeController = null
        service = null
    }

    fun stopByUser(context: Context) {
        val runningService: GeopsLocationService?
        synchronized(this) {
            try { activeController?.stop("USER_REQUESTED") } catch (_: Exception) { }
            runningService = service
            stop()
        }
        if (runningService == null) {
            val key = AndroidKeys.existingStateKey(STATE_ALIAS)
            EncryptedFileAgentStore(context.filesDir.toPath().resolve("agent-state.bin"), key)
                .update { it.trackingIntent = null }
        }
        runningService?.stopSelf()
    }

    /** Called by upload-only JobService after a definitive 401/403. Never starts capture. */
    fun onUploadAuthorizationRejected() {
        val runningService: GeopsLocationService?
        synchronized(this) {
            try { activeController?.stop("AUTH_REVOKED") } catch (_: Exception) { }
            runningService = service
            stop()
        }
        runningService?.stopSelf()
    }

    fun onServiceDestroyed(destroyed: GeopsLocationService) {
        synchronized(this) { if (service === destroyed) stop() }
    }

    private fun userRequestedExit(context: Context, sinceMs: Long): Boolean {
        if (Build.VERSION.SDK_INT < 30) return false
        val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        return manager.getHistoricalProcessExitReasons(context.packageName, 0, 1)
            .any { it.reason == ApplicationExitInfo.REASON_USER_REQUESTED && it.timestamp >= sinceMs }
    }

    private fun transientConfigFailure(failure: Exception): Boolean {
        val code = failure.message?.removePrefix("config_http_")?.toIntOrNull()
        if (code == 429 || (code != null && code in 500..599)) return true
        var cause: Throwable? = failure
        while (cause != null) {
            if (cause is SocketTimeoutException || cause is UnknownHostException ||
                cause is ConnectException || cause is NoRouteToHostException) return true
            cause = cause.cause
        }
        return false
    }

    /** Local, visible-app diagnostic view. No raw queue payload, identifiers or coordinates leave storage. */
    fun diagnosticSummary(context: Context): String {
        val key = AndroidKeys.existingStateKey(STATE_ALIAS)
        val root = context.filesDir.toPath()
        val preferences = context.getSharedPreferences("geops_agent_identity", Context.MODE_PRIVATE)
        val identity = Identity(preferences.getString("device_id", null) ?: error("device_missing"),
            preferences.getString("installation_id", null) ?: error("installation_missing"))
        val events = EncryptedDiagnosticJournal(
            DiagnosticFiles.scoped(context.noBackupFilesDir.toPath(), identity), key).recent()
        val pending = EncryptedFileAgentStore(root.resolve("agent-state.bin"), key).read().pending
        val summary = summarizeDiagnostics(events, pending)
        fun time(value: Long?) = value?.let { Instant.ofEpochMilli(it).toString() } ?: "desconocido"
        return "Diagnóstico local (últimas 24 h)\n" +
            "Callbacks: ${summary.callbacks}; capturas aceptadas: ${summary.accepted}; rechazadas: ${summary.rejected}\n" +
            "Pendientes: ${summary.pendingLocations}; en cuarentena: ${summary.quarantinedLocations}\n" +
            "Último fix original: ${time(summary.lastFixAtMs)}\n" +
            "Último callback recibido: ${time(summary.lastCallbackAtMs)}\n" +
            "Última captura guardada: ${time(summary.lastAcceptedAtMs)}\n" +
            "Último ACK de posiciones: ${time(summary.lastAckAtMs)}\n" +
            "Último rechazo: ${summary.lastRejectReason ?: "ninguno"}\n" +
            "Último estado del servicio: ${summary.lastServiceEvent ?: "desconocido"}\n" +
            "Último resultado de sincronización: ${summary.lastSyncReason ?: "desconocido"}"
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
