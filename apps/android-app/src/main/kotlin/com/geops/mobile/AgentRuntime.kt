package com.geops.mobile

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.Manifest
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.provider.Settings
import com.geops.agent.AndroidAgentClock
import com.geops.agent.AndroidHealthProbe
import com.geops.agent.AndroidKeys
import com.geops.agent.EncryptedFileAgentStore
import com.geops.agent.AgentState
import com.geops.agent.AgentStateFiles
import com.geops.agent.LocationDecision
import com.geops.agent.EncryptedDiagnosticJournal
import com.geops.agent.DiagnosticFiles
import com.geops.agent.GeopsLocationService
import com.geops.agent.Identity
import com.geops.agent.LocationFix
import com.geops.agent.RecordKind
import com.geops.agent.PopConfigTransport
import com.geops.agent.PopHttpClient
import com.geops.agent.PolicyEngine
import com.geops.agent.RefreshingSessionProvider
import com.geops.agent.SYNTHETIC_STAGING_BASE_URL
import com.geops.agent.TrackingController
import com.geops.agent.TrackingIntent
import com.geops.agent.AgentStore
import com.geops.agent.summarizeDiagnostics
import java.nio.file.Files
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
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

/** Foreground tracking run, bounded by the locally authorized assignment. */
object AgentRuntime {
    const val SIGNING_ALIAS = "geops-test-identity-v1"
    internal const val STATE_ALIAS = "geops-test-state-v1"
    private var scheduler: ScheduledExecutorService? = null
    private var captureExecutor: ExecutorService? = null
    private var service: GeopsLocationService? = null
    @Volatile private var lastConfigIssue: String? = null
    @Volatile private var lastRuntimeIssue: String? = null
    @Volatile private var lastGpsCallbackMs: Long = -1
    @Volatile private var lastGpsDecision: LocationDecision? = null

    @Synchronized fun isRunning(): Boolean = scheduler != null
    private var activeStore: AgentStore? = null
    private var activeController: TrackingController? = null
    private var starting = false
    private var stopGeneration = 0L

    fun start(locationService: GeopsLocationService): String = startInternal(locationService, recovery = false)

    /** Invoked for system redelivery or an explicitly eligible autonomous start. */
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
            if (scheduler != null && service === locationService)
                return "El seguimiento ya está iniciado. Consulta las sesiones y ubicaciones en GEOPS Web."
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
            val identity = Identity(deviceId, installationId)
            val boot = bootId(context)
            val clock = AndroidAgentClock(context) { boot }
            val stateRoot = context.filesDir.toPath()
            val legacyStateFile = stateRoot.resolve("agent-state.bin")
            val scopedStateFile = AgentStateFiles.scoped(stateRoot, identity)
            val stateKey = try { AndroidKeys.existingStateKey(STATE_ALIAS) } catch (missing: IllegalStateException) {
                if (Files.exists(legacyStateFile) || Files.exists(scopedStateFile)) throw missing
                AndroidKeys.createStateKey(STATE_ALIAS)
            }
            val stateFile = AgentStateFiles.resolve(stateRoot, identity, stateKey)
            val store = EncryptedFileAgentStore(stateFile, stateKey)
            synchronized(this) { activeStore = store }
            val diagnostics = EncryptedDiagnosticJournal(DiagnosticFiles.scoped(context.noBackupFilesDir.toPath(), identity), stateKey)
            locationService.attachDiagnostics(diagnostics)
            val signer = AndroidKeys.existingEnrollmentSigner(SIGNING_ALIAS)
            val sessionProvider = RefreshingSessionProvider(deviceId, keyId, signer,
                com.geops.agent.HttpsEnrollmentTransport(SYNTHETIC_STAGING_BASE_URL))
            val http = PopHttpClient(SYNTHETIC_STAGING_BASE_URL, sessionProvider,
                AndroidKeys.existingSigningKey(SIGNING_ALIAS, keyId), clock)
            val policy = PolicyEngine(identity, clock, store)
            lastGpsCallbackMs = -1
            lastGpsDecision = null
            val priorIntent = store.read().trackingIntent
            if (recovery) {
                val v1Recovery = priorIntent != null && policy.mayRecover(priorIntent) &&
                    !userRequestedExit(context, priorIntent.requestedAtMs)
                require(v1Recovery || policy.autonomousEligible()) { "recovery_not_authorized" }
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
                                lastGpsCallbackMs = received.wallMs
                                lastGpsDecision = controller.onLocationResult(LocationFix(fix.latitude, fix.longitude,
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
            try { controller.refreshConfig(config); lastConfigIssue = null }
            catch (failure: Exception) {
                if (!transientConfigFailure(failure) ||
                    !(recovery || policy.autonomousEligible())) throw failure
                lastConfigIssue = "Sin conexión; se usa la última política válida dentro de su vigencia."
            }
            // A fresh authenticated config is required to clear a prior upload-auth rejection.
            if (store.read().uploadAuthBlocked) {
                if (!recovery && lastConfigIssue == null) store.update { it.uploadAuthBlocked = false }
            }
            synchronized(this) {
                require(runGeneration == stopGeneration) { "tracking_stopped" }
                controller.tick()
                if (!runtime.isRegistered() && !policy.autonomousEligible()) {
                    lastRuntimeIssue = "El GPS no inició: comprueba el horario, el permiso y el GPS del teléfono."
                    locationService.stopSelf()
                    return "Sin ventana autorizada o inicio GPS bloqueado; se conservó el diagnóstico."
                }
                lastRuntimeIssue = null
                if (runtime.isRegistered()) persistIntent(store, policy, identity, clock.read().bootId,
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
                        try { controller.refreshConfig(config); lastConfigAt = System.currentTimeMillis(); lastConfigIssue = null }
                        catch (failure: Exception) {
                            lastConfigIssue = if (failure.message == "config_http_401" || failure.message == "config_http_403")
                                "El servidor rechazó la configuración: sesión o dispositivo revocado."
                            else "No se pudo actualizar la política; se usa la última copia válida mientras siga autorizada."
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
                    if (runtime.isRegistered() &&
                        System.currentTimeMillis() - locationService.registeredAtMs() > 180_000L &&
                        lastGpsCallbackMs < System.currentTimeMillis() - 180_000L) {
                        if (locationService.providerName() == "FUSED_GMS") locationService.preferPlatformProvider()
                        controller.recoverListener()
                    }
                    if (!runtime.isRegistered() && !policy.autonomousEligible()) {
                        lastRuntimeIssue = "El servicio GPS dejó de estar registrado. Reabre GEOPS para revisar la política."
                        locationService.stopSelf(); stop()
                    }
                } catch (_: Exception) {
                    // The encrypted queue is retained for the next visible recovery; no event is ACKed here.
                    lastRuntimeIssue = "El seguimiento se detuvo por un error local. Los eventos pendientes siguen cifrados."
                    locationService.stopSelf()
                    stop()
                }
            }, 0, 30, TimeUnit.SECONDS)
            return "Seguimiento autorizado iniciado con notificación visible."
        } catch (failure: Exception) {
            lastRuntimeIssue = when (failure.message) {
                "assignment_downgrade" -> "Versión de asignación anterior a la guardada para este dispositivo; seguimiento bloqueado."
                "legacy_state_identity_unknown", "state_identity_mismatch" ->
                    "La identidad del estado cifrado no pudo verificarse; seguimiento bloqueado."
                "config_http_401", "config_http_403" -> "El servidor rechazó la configuración: verifica la activación."
                else -> "No se pudo iniciar o descargar la política. Revisa conexión, permisos y horario."
            }
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

    @Synchronized fun stop(preserveRecoveryIntent: Boolean = false) {
        stopGeneration++
        scheduler?.shutdownNow()
        captureExecutor?.shutdownNow()
        if (!preserveRecoveryIntent) {
            try { activeStore?.update { it.trackingIntent = null } } catch (_: Exception) { }
        }
        scheduler = null
        captureExecutor = null
        activeStore = null
        activeController = null
        service = null
    }

    /** Read-only local diagnosis. No coordinates, identifiers, tokens or raw HTTP bodies leave this method. */
    fun diagnostics(context: Context): String {
        val saved = context.getSharedPreferences("geops_agent_identity", Context.MODE_PRIVATE)
        val device = saved.getString("device_id", null)
        val installation = saved.getString("installation_id", null)
        if (device.isNullOrBlank() || installation.isNullOrBlank())
            return "Política: sin inscripción local.\nEnvío: detenido; primero inscribe y activa este teléfono."
        val stateRoot = context.filesDir.toPath()
        val identity = Identity(device, installation)
        val legacyStateFile = stateRoot.resolve("agent-state.bin")
        val scopedStateFile = AgentStateFiles.scoped(stateRoot, identity)
        if (!Files.exists(legacyStateFile) && !Files.exists(scopedStateFile))
            return "Política: aún no descargada.\nEnvío: detenido. Pulsa Iniciar seguimiento para consultar la política."
        val state = try {
            val key = AndroidKeys.existingStateKey(STATE_ALIAS)
            val stateFile = AgentStateFiles.resolve(stateRoot, identity, key)
            EncryptedFileAgentStore(stateFile, key).read()
        } catch (_: Exception) {
            return "Política: no disponible.\nEnvío: detenido; no se pudo leer el estado cifrado. Revisa la activación."
        }
        val events = try {
            val key = AndroidKeys.existingStateKey(STATE_ALIAS)
            EncryptedDiagnosticJournal(DiagnosticFiles.scoped(context.noBackupFilesDir.toPath(), identity), key).recent()
        } catch (_: Exception) { emptyList() }
        return renderDiagnostics(context, state, device, installation, events)
    }

    private fun renderDiagnostics(context: Context, state: AgentState, device: String,
                                  installation: String, events: List<com.geops.agent.DiagnosticEvent>): String {
        val snapshot = state.snapshot
        val policy = snapshot?.policy
        val display = snapshot?.display
        val evaluation = try {
            PolicyEngine(Identity(device, installation), AndroidAgentClock(context) { bootId(context) },
                object : com.geops.agent.AgentStore {
                    override fun read() = state
                    override fun update(block: (AgentState) -> Unit) = error("read_only")
                }).evaluate()
        } catch (_: Exception) { null }
        val pending = state.pending.count { it.kind == RecordKind.LOCATION && !it.quarantined }
        val quarantined = state.pending.count { it.kind == RecordKind.LOCATION && it.quarantined }
        val summary = summarizeDiagnostics(events, state.pending)
        val lastSync = events.lastOrNull { it.kind.name.startsWith("SYNC_") }
        val lastSyncAttemptMs = events.lastOrNull { it.kind == com.geops.agent.DiagnosticKind.SYNC_ATTEMPT }?.atMs ?: -1L
        val activeService = synchronized(this) { scheduler != null && service?.isGpsRegistered() == true }
        val gpsGap = policy?.captureIntervalS?.times(3_000L) ?: 180_000L
        val authorization = when (evaluation?.reason) {
            null -> if (evaluation?.window != null) "Dentro de ventana autorizada" else "No comprobable"
            "NO_CONFIG" -> "Sin política descargada"
            "NO_ACTIVE_POLICY" -> "Sin política publicada y asignada"
            "OUTSIDE_WINDOW" -> "Fuera del horario autorizado"
            "POLICY_NOT_YET_VALID" -> "La política aún no entra en vigencia"
            "POLICY_EXPIRED" -> "La política venció"
            "CONFIG_EXPIRED" -> "La autorización offline venció; se requiere conexión"
            "INSTANCE_NOT_ONLINE_VERIFIED" -> "Esta jornada aún no fue validada en línea; se requiere conexión"
            "REBOOT_REQUIRES_REFRESH" -> "Reinicio detectado; se requiere validar la política con el servidor"
            "CLOCK_DRIFT", "CLOCK_INVALID" -> "La hora del teléfono no coincide con la autorización"
            else -> "La autorización cambió; se requiere actualizar la política"
        }
        val reason = when {
            evaluation?.window == null -> authorization
            context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED ->
                "Falta permiso de ubicación precisa."
            !((context.getSystemService(Context.LOCATION_SERVICE) as LocationManager)
                .isProviderEnabled(LocationManager.GPS_PROVIDER)) -> "GPS del teléfono desactivado."
            lastRuntimeIssue != null -> lastRuntimeIssue!!
            !activeService -> "Servicio de seguimiento detenido. Pulsa Iniciar seguimiento."
            quarantined > 0 -> "Hay $quarantined posiciones retenidas por rechazo del servidor; requieren revisión."
            state.uploadAuthBlocked -> "El servidor rechazó el envío por autorización."
            lastSync?.reason == com.geops.agent.DiagnosticReason.RATE_LIMIT && pending > 0 ->
                "El servidor limitó la frecuencia de envíos; la cola esperará y reintentará."
            lastSync?.reason == com.geops.agent.DiagnosticReason.INVALID_ACK && pending > 0 ->
                "La respuesta del servidor no confirmó el lote; se conserva para reintento."
            lastSync?.reason == com.geops.agent.DiagnosticReason.SERVER_ERROR && pending > 0 ->
                "El servidor respondió con error; la cola reintentará."
            lastSync?.reason == com.geops.agent.DiagnosticReason.NETWORK && pending > 0 ->
                "No se completó la conexión al servidor; la cola reintentará."
            lastSync?.reason == com.geops.agent.DiagnosticReason.BACKOFF && pending > 0 ->
                "Los envíos están en espera tras un fallo anterior; se reintentará."
            lastSync?.reason == com.geops.agent.DiagnosticReason.WAITING_SESSION && pending > 0 ->
                "Esperando confirmación de inicio de sesión antes de enviar posiciones."
            lastSync?.reason == com.geops.agent.DiagnosticReason.SERVER_PENDING && pending > 0 ->
                "El servidor aún no confirmó el lote; se reintentará."
            pending > 0 -> "Hay posiciones en cola; próximo intento según la frecuencia de sincronización."
            lastGpsCallbackMs < 0 -> "Android aún no entregó una lectura GPS en este inicio. Comprueba señal y permisos."
            activeService && System.currentTimeMillis() - lastGpsCallbackMs > gpsGap ->
                "Android no ha entregado nuevas lecturas GPS durante más de tres intervalos solicitados."
            lastGpsDecision != null && lastGpsDecision != LocationDecision.SAVED ->
                "Última lectura GPS descartada: ${locationReason(lastGpsDecision!!)}"
            state.locationsCaptured == 0L -> "Aún no hay capturas aceptadas para enviar."
            else -> "Sin posiciones pendientes de envío."
        }
        val days = display?.daysIso?.joinToString(", ") {
            listOf("Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom").getOrElse(it - 1) { "?" }
        } ?: "No disponible"
        return buildString {
            append("Política: ").append(display?.name ?: if (policy == null) "Ninguna activa" else "Nombre no disponible")
            if (policy != null) append(" · versión ").append(policy.revision)
            append("\nÚltima política recibida: ").append(time(snapshot?.verifiedAtMs ?: -1))
            append("\nHorario: ").append(days)
            if (display != null) append(" · ").append(display.startLocal).append("–")
                .append(display.endLocal).append(" (").append(display.timeZone).append(")")
            append("\nAutorización ahora: ").append(authorization)
            append("\nGPS: ").append(if (activeService) "Activo" else "Detenido")
            if (policy != null) append(" · solicitud cada ").append(policy.captureIntervalS).append(" s")
                .append(" · envío cada ").append(policy.syncIntervalS).append(" s")
            append("\nCapturadas en este teléfono desde esta versión: ").append(state.locationsCaptured)
            append("\nÚltima captura: ").append(time(state.lastLocationCapturedMs))
            append("\nÚltima lectura entregada por Android en este inicio: ").append(time(lastGpsCallbackMs))
            if (lastGpsDecision != null) append(" · ").append(locationReason(lastGpsDecision!!))
            append("\nPendientes de confirmación: ").append(pending)
            append("\nBuffer cifrado: ").append(state.bufferUsageBytes).append(" / ")
                .append(EncryptedFileAgentStore.MAX_BYTES).append(" bytes")
            if (state.bufferAlertLevel > 0)
                append(" · alerta ").append(state.bufferAlertLevel).append(" %")
            append("\nConfirmadas por servidor desde esta versión: ").append(state.locationsAcked)
            append("\nÚltimo envío confirmado: ").append(time(state.lastLocationAckedMs))
            append("\nÚltima revisión de envíos: ").append(time(lastSyncAttemptMs))
            append("\nDiagnóstico reciente: ").append(summary.callbacks).append(" lecturas, ")
                .append(summary.accepted).append(" aceptadas, ").append(summary.rejected).append(" rechazadas")
            append("\nEstado de envío: ").append(reason)
            if (lastRuntimeIssue != null) append("\nÚltimo bloqueo: ").append(lastRuntimeIssue)
            if (lastConfigIssue != null) append("\nActualización de política: ").append(lastConfigIssue)
            append("\nLa frecuencia GPS es solicitada a Android; cada lectura no está garantizada.")
        }
    }

    private fun time(value: Long): String = if (value < 0) "Aún no" else
        DateTimeFormatter.ofPattern("dd/MM/yyyy HH:mm:ss").withZone(ZoneId.systemDefault())
            .format(Instant.ofEpochMilli(value))

    private fun locationReason(value: LocationDecision): String = when (value) {
        LocationDecision.SAVED -> "Guardada en la cola cifrada"
        LocationDecision.NO_WINDOW -> "fuera de ventana autorizada o autorización vencida"
        LocationDecision.NO_SESSION -> "no existe una sesión iniciada"
        LocationDecision.SERVICE_STOPPED -> "servicio GPS detenido"
        LocationDecision.SESSION_CHANGED -> "la sesión o política cambió"
        LocationDecision.INVALID_TIME -> "hora de lectura fuera de la ventana válida"
        LocationDecision.INVALID_FIX -> "lectura GPS inválida"
        LocationDecision.WAITING_INTERVAL -> "aún no se cumple el intervalo de captura"
    }

    fun stopByUser(context: Context) {
        val runningService: GeopsLocationService?
        synchronized(this) {
            try { activeController?.stop("USER_REQUESTED") } catch (_: Exception) { }
            try { activeStore?.update { it.autonomousEnabled = false } } catch (_: Exception) { }
            runningService = service
            stop()
        }
        if (runningService == null) {
            val key = AndroidKeys.existingStateKey(STATE_ALIAS)
            val preferences = context.getSharedPreferences("geops_agent_identity", Context.MODE_PRIVATE)
            val identity = Identity(preferences.getString("device_id", null) ?: error("device_missing"),
                preferences.getString("installation_id", null) ?: error("installation_missing"))
            val file = AgentStateFiles.resolve(context.filesDir.toPath(), identity, key)
            EncryptedFileAgentStore(file, key)
                .update { it.trackingIntent = null; it.autonomousEnabled = false }
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
        // Android destruction alone is not an explicit user stop. The bounded intent
        // remains subject to the same instance, boot, policy and offline expiry checks.
        synchronized(this) { if (service === destroyed) stop(preserveRecoveryIntent = true) }
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
        val stateFile = AgentStateFiles.resolve(root, identity, key)
        val pending = EncryptedFileAgentStore(stateFile, key).read().pending
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
        val epoch = System.currentTimeMillis() - android.os.SystemClock.elapsedRealtime()
        if (count >= 0 && count == previous && saved != null) return saved
        if (count < 0 && saved != null &&
            kotlin.math.abs(epoch - preferences.getLong("epoch", Long.MIN_VALUE)) <= 120_000L)
            return saved
        val next = UUID.randomUUID().toString()
        preferences.edit().putInt("count", count).putLong("epoch", epoch).putString("id", next).apply()
        return next
    }

    fun markBoot(context: Context) {
        val preferences = context.getSharedPreferences("geops_agent_boot", Context.MODE_PRIVATE)
        val count = Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT, -1)
        val epoch = System.currentTimeMillis() - android.os.SystemClock.elapsedRealtime()
        preferences.edit().putInt("count", count).putLong("epoch", epoch)
            .putString("id", UUID.randomUUID().toString()).commit()
    }

    /** Called by the boot receiver before trying Android's restricted FGS start. */
    fun mayAutostart(context: Context): Boolean = try {
        if (context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED ||
            (Build.VERSION.SDK_INT >= 29 && context.checkSelfPermission(
                Manifest.permission.ACCESS_BACKGROUND_LOCATION) != PackageManager.PERMISSION_GRANTED)) false
        else {
            val preferences = context.getSharedPreferences("geops_agent_identity", Context.MODE_PRIVATE)
            val identity = Identity(preferences.getString("device_id", null) ?: return false,
                preferences.getString("installation_id", null) ?: return false)
            val key = AndroidKeys.existingStateKey(STATE_ALIAS)
            val file = AgentStateFiles.resolve(context.filesDir.toPath(), identity, key)
            PolicyEngine(identity, AndroidAgentClock(context) { bootId(context) },
                EncryptedFileAgentStore(file, key)).autonomousEligible()
        }
    } catch (_: Exception) { false }
}
