package com.geops.mobile

import android.content.Context
import android.Manifest
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.provider.Settings
import com.geops.agent.AndroidAgentClock
import com.geops.agent.AndroidHealthProbe
import com.geops.agent.AndroidKeys
import com.geops.agent.BatchSync
import com.geops.agent.EncryptedFileAgentStore
import com.geops.agent.AgentState
import com.geops.agent.AgentStateFiles
import com.geops.agent.GeopsLocationService
import com.geops.agent.Identity
import com.geops.agent.LocationFix
import com.geops.agent.LocationDecision
import com.geops.agent.PopBatchTransport
import com.geops.agent.PopConfigTransport
import com.geops.agent.PopHttpClient
import com.geops.agent.PolicyEngine
import com.geops.agent.RecordKind
import com.geops.agent.RefreshingSessionProvider
import com.geops.agent.SYNTHETIC_STAGING_BASE_URL
import com.geops.agent.SyncOutcome
import com.geops.agent.SyncDetail
import com.geops.agent.TrackingController
import java.nio.file.Files
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
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
    @Volatile private var lastLocationSync: SyncOutcome? = null
    @Volatile private var lastLocationDetail: SyncDetail? = null
    @Volatile private var lastSyncAttemptMs: Long = -1
    @Volatile private var lastConfigIssue: String? = null
    @Volatile private var lastRuntimeIssue: String? = null
    @Volatile private var lastGpsCallbackMs: Long = -1
    @Volatile private var lastGpsDecision: LocationDecision? = null

    @Synchronized fun isRunning(): Boolean = scheduler != null

    fun start(locationService: GeopsLocationService): String {
        synchronized(this) {
            if (scheduler != null) return "El seguimiento ya está iniciado. Consulta las sesiones y ubicaciones en GEOPS Web."
            service = locationService
        }
        try {
            val context = locationService.applicationContext
            val preferences = context.getSharedPreferences("geops_agent_identity", Context.MODE_PRIVATE)
            val deviceId = preferences.getString("device_id", null) ?: error("device_missing")
            val keyId = preferences.getString("key_id", null) ?: error("key_missing")
            val installationId = preferences.getString("installation_id", null) ?: error("installation_missing")
            val identity = Identity(deviceId, installationId)
            val boot = bootId(context)
            val clock = AndroidAgentClock { boot }
            val stateRoot = context.filesDir.toPath()
            val legacyStateFile = stateRoot.resolve("agent-state.bin")
            val scopedStateFile = AgentStateFiles.scoped(stateRoot, identity)
            val stateKey = try { AndroidKeys.existingStateKey(STATE_ALIAS) } catch (missing: IllegalStateException) {
                if (Files.exists(legacyStateFile) || Files.exists(scopedStateFile)) throw missing
                AndroidKeys.createStateKey(STATE_ALIAS)
            }
            val stateFile = AgentStateFiles.resolve(stateRoot, identity, stateKey)
            val store = EncryptedFileAgentStore(stateFile, stateKey)
            // A process restart is never proof of an observed STOPPED event.
            store.update { if (it.session != null) it.session?.state = "UNKNOWN_END" }
            val signer = AndroidKeys.existingEnrollmentSigner(SIGNING_ALIAS)
            val sessionProvider = RefreshingSessionProvider(deviceId, keyId, signer,
                com.geops.agent.HttpsEnrollmentTransport(SYNTHETIC_STAGING_BASE_URL))
            val http = PopHttpClient(SYNTHETIC_STAGING_BASE_URL, sessionProvider,
                AndroidKeys.existingSigningKey(SIGNING_ALIAS, keyId), clock)
            val policy = PolicyEngine(identity, clock, store)
            lastGpsCallbackMs = -1
            lastGpsDecision = null
            lastLocationSync = null
            lastLocationDetail = null
            lastSyncAttemptMs = -1
            lateinit var controller: TrackingController
            val capture = Executors.newSingleThreadExecutor()
            synchronized(this) { captureExecutor = capture }
            val runtime = locationService.runtime { fix: Location ->
                lastGpsCallbackMs = System.currentTimeMillis()
                val reading = clock.read().copy(wallMs = fix.time,
                    elapsedMs = fix.elapsedRealtimeNanos / 1_000_000L)
                try {
                    if (!capture.isShutdown) capture.execute {
                        try {
                            lastGpsDecision = controller.onLocationResult(LocationFix(fix.latitude, fix.longitude,
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
            lastConfigIssue = null
            controller.tick()
            if (!runtime.isRegistered()) {
                lastRuntimeIssue = "El GPS no inició: comprueba el horario, el permiso y el GPS del teléfono."
                locationService.stopSelf()
                stop()
                return "Sin ventana autorizada o inicio GPS bloqueado; se conservó el diagnóstico."
            }
            lastRuntimeIssue = null
            val sync = BatchSync(identity, store, clock, PopBatchTransport(http, healthContractApproved = true))
            val timer = Executors.newSingleThreadScheduledExecutor()
            synchronized(this) { scheduler = timer }
            var lastConfigAt = System.currentTimeMillis()
            var lastSyncAt = 0L
            timer.scheduleAtFixedRate({
                try {
                    if (System.currentTimeMillis() - lastConfigAt >= 300_000L) {
                        try { controller.refreshConfig(config); lastConfigAt = System.currentTimeMillis(); lastConfigIssue = null }
                        catch (failure: Exception) {
                            lastConfigIssue = if (failure.message == "config_http_401" || failure.message == "config_http_403")
                                "El servidor rechazó la configuración: sesión o dispositivo revocado."
                            else "No se pudo actualizar la política; se usa la última copia válida mientras siga autorizada."
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
                            val outcome = sync.once(kind)
                            if (kind == RecordKind.LOCATION) {
                                lastLocationSync = outcome
                                if (sync.lastDetail != SyncDetail.BACKOFF && sync.lastDetail != SyncDetail.NONE)
                                    lastLocationDetail = sync.lastDetail
                                lastSyncAttemptMs = now
                            }
                            if (outcome == SyncOutcome.AUTH_REQUIRED) {
                                lastRuntimeIssue = "El servidor rechazó el envío: sesión o dispositivo revocado."
                                controller.stop("AUTH_REVOKED")
                                locationService.stopSelf()
                                stop()
                                return@scheduleAtFixedRate
                            }
                        }
                        lastSyncAt = now
                    }
                    if (!runtime.isRegistered()) {
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
        }
    }

    @Synchronized fun stop() {
        scheduler?.shutdownNow()
        captureExecutor?.shutdownNow()
        scheduler = null
        captureExecutor = null
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
        return renderDiagnostics(context, state, device, installation)
    }

    private fun renderDiagnostics(context: Context, state: AgentState, device: String,
                                  installation: String): String {
        val snapshot = state.snapshot
        val policy = snapshot?.policy
        val display = snapshot?.display
        val evaluation = try {
            PolicyEngine(Identity(device, installation), AndroidAgentClock { bootId(context) },
                object : com.geops.agent.AgentStore {
                    override fun read() = state
                    override fun update(block: (AgentState) -> Unit) = error("read_only")
                }).evaluate()
        } catch (_: Exception) { null }
        val pending = state.pending.count { it.kind == RecordKind.LOCATION && !it.quarantined }
        val quarantined = state.pending.count { it.kind == RecordKind.LOCATION && it.quarantined }
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
            lastLocationSync == SyncOutcome.AUTH_REQUIRED -> "El servidor rechazó el envío por autorización."
            lastLocationSync == SyncOutcome.QUARANTINED -> "El servidor rechazó posiciones; requieren revisión."
            lastLocationDetail == SyncDetail.RATE_LIMIT && pending > 0 ->
                "El servidor limitó la frecuencia de envíos; la cola esperará y reintentará."
            lastLocationDetail == SyncDetail.INVALID_ACK && pending > 0 ->
                "La respuesta del servidor no confirmó el lote; se conserva para reintento."
            lastLocationDetail == SyncDetail.SERVER_ERROR && pending > 0 ->
                "El servidor respondió con error; la cola reintentará."
            lastLocationDetail == SyncDetail.NETWORK && pending > 0 ->
                "No se completó la conexión al servidor; la cola reintentará."
            lastLocationDetail == SyncDetail.BACKOFF && pending > 0 ->
                "Los envíos están en espera tras un fallo anterior; se reintentará."
            lastLocationSync == SyncOutcome.RETRY && pending > 0 -> "Falló el envío; la cola cifrada reintentará. Revisa la conexión."
            lastLocationSync == SyncOutcome.PENDING && pending > 0 ->
                if (state.pending.any { it.kind == RecordKind.SESSION && !it.quarantined &&
                    runCatching { org.json.JSONObject(it.payload).optString("type") == "STARTED" }.getOrDefault(false) })
                    "Esperando confirmación de inicio de sesión antes de enviar posiciones."
                else "El servidor aún no confirmó el lote; se reintentará."
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
            append("\nConfirmadas por servidor desde esta versión: ").append(state.locationsAcked)
            append("\nÚltimo envío confirmado: ").append(time(state.lastLocationAckedMs))
            append("\nÚltima revisión de envíos: ").append(time(lastSyncAttemptMs))
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
