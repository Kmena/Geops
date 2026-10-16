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
import java.net.URL
import java.time.Duration
import java.time.Instant
import java.util.concurrent.Executors

class MainActivity : ComponentActivity() {
    private val background = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var state: TextView
    private lateinit var credentials: PocCredentials
    private val scan = registerForActivityResult(ScanContract()) { result ->
        result.contents?.let { enroll(it) }
    }
    private val permissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        if (result[Manifest.permission.ACCESS_FINE_LOCATION] == true &&
            (Build.VERSION.SDK_INT < 33 || result[Manifest.permission.POST_NOTIFICATIONS] == true)) {
            ContextCompat.startForegroundService(this, Intent(this, TrackingService::class.java))
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
        fun button(label: String, action: () -> Unit) {
            column.addView(Button(this).apply { text = label; setOnClickListener { action() } },
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        }
        column.addView(TextView(this).apply { text = "GEOPS · GPS PoC visible"; textSize = 24f })
        button("Escanear QR e inscribir", {
            scan.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt("Escanea la invitación temporal"))
        })
        button("Iniciar seguimiento", { start() })
        button("Detener seguimiento", {
            startService(Intent(this, TrackingService::class.java).setAction("STOP")); refresh()
        })
        button("Sincronizar pendientes", { SyncWorker.enqueue(this); refresh() })
        column.addView(state)
        setContentView(ScrollView(this).apply { addView(column) })
        refresh()
    }
    private fun enroll(raw: String) {
        background.execute {
            try {
                val qr = JSONObject(raw)
                val base = qr.getString("api_base")
                val url = URL(base)
                require(base == BuildConfig.POC_API_ORIGIN && url.protocol == "https" && url.userInfo == null && url.query == null && url.ref == null &&
                    qr.getString("environment_id") == "weekend-gps-poc-v1")
                val payload = JSONObject().put("environment_id", qr.getString("environment_id"))
                    .put("invitation_id", qr.getString("invitation_id"))
                    .put("invitation_secret", qr.getString("invitation_secret"))
                val conn = URL(base + "/api/device/enroll").openConnection() as java.net.HttpURLConnection
                conn.instanceFollowRedirects = false
                conn.requestMethod = "POST"; conn.connectTimeout = 15000; conn.readTimeout = 15000
                conn.doOutput = true; conn.setRequestProperty("Content-Type", "application/json")
                conn.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }
                require(conn.responseCode == 201)
                val answer = JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
                require(answer.getString("environment_id") == "weekend-gps-poc-v1")
                credentials.apiBase = base
                credentials.token = answer.getString("device_token")
                credentials.deviceId = answer.getString("device_id")
                runOnUiThread { state.text = "Inscrito en entorno experimental."; refresh() }
            } catch (_: Exception) { runOnUiThread { state.text = "Inscripción fallida. Revisa QR, HTTPS y conexión." } }
        }
    }
    private fun start() {
        if (!BuildConfig.REAL_CAPTURE_ENABLED) { state.text = "Captura física bloqueada en esta compilación."; return }
        if (credentials.deviceId.isBlank() || credentials.apiBase != BuildConfig.POC_API_ORIGIN) {
            state.text = "Inscripción/origen no aprobado."; return
        }
        val required = mutableListOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        if (Build.VERSION.SDK_INT >= 33) required.add(Manifest.permission.POST_NOTIFICATIONS)
        if (required.any { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }) {
            permissions.launch(required.toTypedArray())
        } else ContextCompat.startForegroundService(this, Intent(this, TrackingService::class.java))
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
    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        background.shutdown()
        super.onDestroy()
    }
}
