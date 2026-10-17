package com.geops.weekendpoc

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.location.LocationManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import org.json.JSONObject
import java.time.Duration
import java.time.Instant
import java.io.IOException
import java.util.concurrent.Executors
import javax.net.ssl.SSLException

class MainActivity : ComponentActivity() {
    private val background = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var state: TextView
    private lateinit var enrollmentStatus: TextView
    private lateinit var syncStatus: TextView
    private lateinit var scanButton: Button
    private val enrollmentGate = EnrollmentAttemptGate()
    private lateinit var credentials: PocCredentials
    private val scan = registerForActivityResult(ScanContract()) { result ->
        val raw = result.contents
        if (raw.isNullOrBlank()) {
            enrollmentGate.finish()
            scanButton.isEnabled = true
            enrollmentStatus.text = if (raw == null) "Escaneo cancelado." else "QR inválido: contenido vacío."
        } else if (enrollmentGate.acceptResult()) {
            enroll(raw)
        }
    }
    private val permissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        if (result[Manifest.permission.ACCESS_FINE_LOCATION] == true &&
            (Build.VERSION.SDK_INT < 33 || result[Manifest.permission.POST_NOTIFICATIONS] == true)) {
            launchTrackingService()
        } else state.text = "Faltan permisos de ubicación o notificación."
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        credentials = PocCredentials(this)
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(24, 24, 24, 24)
        }
        state = TextView(this).apply { textSize = 17f }
        fun button(label: String, action: () -> Unit): Button {
            val item = Button(this).apply { text = label; setOnClickListener { action() } }
            column.addView(item, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            return item
        }
        column.addView(TextView(this).apply { text = "GEOPS · GPS PoC visible"; textSize = 24f })
        column.addView(TextView(this).apply {
            text = if (BuildConfig.REAL_CAPTURE_ENABLED)
                "Modo de campo: GPS disponible solo con inicio manual."
            else "Modo diagnóstico: captura GPS desactivada."
        })
        scanButton = button("Escanear QR e inscribir") {
            if (enrollmentGate.begin()) {
                scanButton.isEnabled = false
                enrollmentStatus.text = "Esperando código QR…"
                scan.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                    .setOrientationLocked(false).setPrompt("Escanea la invitación temporal"))
            }
        }
        button("Iniciar seguimiento", { start() })
        button("Detener seguimiento", {
            stopService(Intent(this, TrackingService::class.java)); refresh()
        })
        button("Verificar identidad (sin GPS)", { verifyIdentity() })
        button("Sincronizar pendientes", { syncPending() })
        enrollmentStatus = TextView(this).apply { textSize = 17f; text = localStatus() }
        column.addView(enrollmentStatus)
        syncStatus = TextView(this).apply { textSize = 16f }
        column.addView(syncStatus)
        column.addView(state)
        setContentView(ScrollView(this).apply { addView(column) })
        if (savedInstanceState?.getBoolean("scanPending") == true && enrollmentGate.begin()) {
            scanButton.isEnabled = false
            enrollmentStatus.text = "Esperando código QR…"
        }
        refresh()
    }
    private fun enroll(raw: String) {
        background.execute {
            try {
                EnrollmentCoordinator(
                    HttpsEnrollmentTransport(),
                    { base, device -> credentials.saveEnrollment(base, device) },
                    { event, status ->
                        Log.i("GeopsPocEnroll", event.name + (status?.let { " HTTP " + it } ?: ""))
                    }
                ).enroll(raw, BuildConfig.POC_API_ORIGIN)
                runOnUiThread {
                    enrollmentStatus.text = "Inscripción confirmada por el servidor (HTTP 201)."
                    refresh()
                }
            } catch (failure: EnrollmentFailure) {
                runOnUiThread { enrollmentStatus.text = enrollmentMessage(failure) }
            } catch (_: Exception) {
                runOnUiThread { enrollmentStatus.text = "Error interno de inscripción." }
            } finally {
                runOnUiThread {
                    enrollmentGate.finish()
                    scanButton.isEnabled = true
                }
            }
        }
    }
    private fun enrollmentMessage(failure: EnrollmentFailure): String {
        val code = failure.httpStatus?.let { " (HTTP $it)" } ?: ""
        return when (failure.kind) {
            EnrollmentFailureKind.INVALID_QR -> "QR inválido o invitación no válida$code. Genera uno nuevo."
            EnrollmentFailureKind.ORIGIN_MISMATCH -> "El origen del QR no coincide con el configurado en esta APK. Reconstruye con pocApiOrigin."
            EnrollmentFailureKind.INVITATION_EXPIRED -> "Invitación expirada$code. Genera un QR nuevo."
            EnrollmentFailureKind.INVITATION_USED -> "Invitación ya utilizada$code. Genera un QR nuevo."
            EnrollmentFailureKind.CONNECTION -> "Error de conexión. Comprueba Internet y el servidor HTTPS."
            EnrollmentFailureKind.TLS -> "Error TLS. Comprueba el certificado y la dirección HTTPS."
            EnrollmentFailureKind.HTTP -> "Servidor rechazó la inscripción$code."
            EnrollmentFailureKind.INVALID_RESPONSE -> "Respuesta de inscripción inválida$code."
            EnrollmentFailureKind.LOCAL_STORAGE -> "Servidor confirmó inscripción$code, pero falló el guardado local. Revoca el dispositivo desde el panel antes de reintentar."
            EnrollmentFailureKind.INTERNAL -> "Error interno de inscripción$code."
        }
    }
    private fun localStatus(): String = localIdentityMessage(
        credentials.deviceId,
        runCatching { canonicalOrigin(credentials.apiBase) == canonicalOrigin(BuildConfig.POC_API_ORIGIN) }
            .getOrDefault(false),
        runCatching { credentials.token.isNotBlank() }.getOrDefault(false)
    )
    private fun verifyIdentity() {
        enrollmentStatus.text = "Verificando identidad con el servidor…"
        background.execute {
            val deviceId = credentials.deviceId
            val base = credentials.apiBase
            val token = try { credentials.token } catch (_: Exception) { "" }
            val originMatches = runCatching { canonicalOrigin(base) == canonicalOrigin(BuildConfig.POC_API_ORIGIN) }
                .getOrDefault(false)
            if (deviceId.isBlank() || !originMatches || token.isBlank()) {
                runOnUiThread { enrollmentStatus.text = localIdentityMessage(deviceId, originMatches, token.isNotBlank()) }
                return@execute
            }
            val message = try {
                val (http, status) = DeviceStatusVerifier(HttpsDeviceStatusTransport())
                    .verify(base, deviceId, token)
                Log.i("GeopsPocIdentity", "STATUS_RESPONSE HTTP $http")
                "Identidad activa y confirmada (HTTP 200). Captura del servidor: " +
                    if (status.captureEnabled) "habilitada." else "deshabilitada."
            } catch (failure: DeviceStatusFailure) {
                when {
                    failure.invalidResponse -> "Respuesta de estado inválida (HTTP ${failure.status}); identidad sin verificar."
                    failure.status == 401 -> "Credencial no reconocida (HTTP 401); identidad sin verificar."
                    failure.status == 403 -> "Acceso del dispositivo denegado (HTTP 403); identidad sin verificar."
                    else -> "Consulta de estado falló (HTTP ${failure.status}); identidad sin verificar."
                }
            } catch (_: SSLException) {
                "Error TLS al verificar identidad; comprueba el certificado HTTPS."
            } catch (_: IOException) {
                "Error de conexión al verificar identidad; comprueba Internet y el servidor."
            } catch (_: Exception) {
                "Error interno al verificar identidad."
            }
            runOnUiThread { enrollmentStatus.text = message }
        }
    }
    private fun syncPending() {
        background.execute {
            val deviceId = credentials.deviceId
            val pending = LocationDatabase.get(this).locations().pendingCountForDevice(deviceId)
            runOnUiThread {
                if (deviceId.isBlank()) {
                    syncStatus.text = "Sin identidad para sincronizar."
                } else if (pending == 0) {
                    syncStatus.text = emptySyncMessage(0)
                } else {
                    SyncWorker.enqueue(this)
                    syncStatus.text = emptySyncMessage(pending)
                }
                refresh()
            }
        }
    }
    private fun start() {
        if (!BuildConfig.REAL_CAPTURE_ENABLED) { state.text = "Captura física bloqueada en esta compilación."; return }
        val tokenAvailable = runCatching { credentials.token.isNotBlank() }.getOrDefault(false)
        if (!captureReady(BuildConfig.REAL_CAPTURE_ENABLED, credentials.deviceId, credentials.apiBase,
                BuildConfig.POC_API_ORIGIN, tokenAvailable)) {
            state.text = "Identidad, credencial u origen no disponible para captura."; return
        }
        if (!getSystemService(LocationManager::class.java).isProviderEnabled(LocationManager.GPS_PROVIDER)) {
            state.text = "Activa el proveedor GPS antes de iniciar el seguimiento."; return
        }
        val required = mutableListOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        if (Build.VERSION.SDK_INT >= 33) required.add(Manifest.permission.POST_NOTIFICATIONS)
        if (required.any { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }) {
            permissions.launch(required.toTypedArray())
        } else launchTrackingService()
    }
    private fun launchTrackingService() {
        try {
            ContextCompat.startForegroundService(this, Intent(this, TrackingService::class.java))
        } catch (_: SecurityException) {
            state.text = "Android rechazó el permiso de ubicación para el servicio."
        } catch (_: IllegalStateException) {
            state.text = "Android no permitió iniciar el servicio; abre la APK y reintenta."
        }
    }
    private fun refresh() {
        val prefs = getSharedPreferences("poc-state", MODE_PRIVATE)
        val running = prefs.getBoolean("running", false)
        val started = prefs.getLong("startedAt", 0)
        val network = getSystemService(ConnectivityManager::class.java)
        val internet = network.getNetworkCapabilities(network.activeNetwork)
            ?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true
        val gps = getSystemService(LocationManager::class.java).isProviderEnabled(LocationManager.GPS_PROVIDER)
        val battery = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            ?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        background.execute {
            val dao = LocationDatabase.get(this).locations()
            val count = dao.pendingCount()
            val latest = dao.latest(credentials.deviceId)
            val last = try { latest?.let { JSONObject(CryptoBox().decrypt(it.encryptedPayload)) } } catch (_: Exception) { null }
            val synced = prefs.getLong("lastSyncAt", 0)
            val text = buildString {
                append("Inscripción: "); append(if (credentials.deviceId.isBlank()) "pendiente" else credentials.deviceId.take(8))
                append("\nSeguimiento: "); append(if (running) "activo" else "detenido")
                append("\nGPS: "); append(if (gps) "proveedor habilitado" else "proveedor GPS no disponible")
                append("\nInternet: "); append(if (internet) "conectado" else "sin conexión")
                append("\nÚltima coordenada: "); append(last?.optString("latitude") ?: "—")
                append(", "); append(last?.optString("longitude") ?: "—")
                append("\nPrecisión: "); append(last?.optString("accuracy_m") ?: "—"); append(" m")
                append("\nCaptura: "); append(last?.optString("captured_at") ?: "—")
                append("\nÚltima sincronización: "); append(if (synced > 0) Instant.ofEpochMilli(synced).toString() else "—")
                append("\nBatería: "); append(battery); append("%")
                append("\nPendientes totales: "); append(count)
                append("\nPendientes de identidad actual: "); append(dao.pendingCountForDevice(credentials.deviceId))
                append("\nDuración: "); append(if (running && started > 0)
                    Duration.between(Instant.ofEpochMilli(started), Instant.now()).toMinutes().toString() + " min" else (prefs.getLong("lastDuration", 0) / 60_000).toString() + " min")
                val elapsed = if (running && started > 0) System.currentTimeMillis() - started
                    else prefs.getLong("lastDuration", 0)
                val offlineSince = prefs.getLong("offlineSince", 0)
                val offline = prefs.getLong("offlineTotal", 0) +
                    if (running && offlineSince > 0) System.currentTimeMillis() - offlineSince else 0L
                val lastFixAt = prefs.getLong("lastFixAt", 0)
                append("\nCapturas esperadas aprox.: "); append(elapsed / 60_000)
                append("\nCapturas guardadas: "); append(prefs.getInt("capturedCount", 0))
                append("\nError de sincronización: "); append(prefs.getString("syncError", null) ?: "ninguno")
                append("\nError de captura: "); append(prefs.getString("captureError", null) ?: "ninguno")
                append("\nEventos confirmados: "); append(prefs.getInt("ackCount", 0))
                append("\nDuplicados ACK: "); append(prefs.getInt("duplicateCount", 0))
                append("\nSin Internet acumulado: "); append(offline / 60_000); append(" min")
                append("\nÚltimo fix hace: "); append(if (lastFixAt > 0) ((System.currentTimeMillis() - lastFixAt) / 60_000).toString() + " min" else "—")
                append("\nBatería inicial/final: "); append(prefs.getInt("batteryStart", -1))
                append("% / "); append(prefs.getInt("batteryEnd", -1)); append("%")
                append("\nFixes inválidos: "); append(prefs.getInt("invalidFixes", 0))
                append("\nFallos de guardado: "); append(prefs.getInt("writeFailures", 0))
            }
            runOnUiThread { state.text = text }
        }
        handler.removeCallbacksAndMessages(null)
        handler.postDelayed({ refresh() }, 5000)
    }
    override fun onSaveInstanceState(outState: Bundle) {
        outState.putBoolean("scanPending", enrollmentGate.isScanning())
        super.onSaveInstanceState(outState)
    }
    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        background.shutdown()
        super.onDestroy()
    }
}
