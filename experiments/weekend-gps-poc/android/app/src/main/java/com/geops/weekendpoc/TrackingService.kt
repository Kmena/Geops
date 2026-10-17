package com.geops.weekendpoc

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import org.json.JSONObject
import java.time.Instant
import java.util.UUID
import java.util.concurrent.Executors

class TrackingService : Service() {
    private val executor = Executors.newSingleThreadExecutor()
    private var trackingStarted = false
    private val fused by lazy { LocationServices.getFusedLocationProviderClient(this) }
    private val state by lazy { getSharedPreferences("poc-state", MODE_PRIVATE) }
    private val connectivity by lazy { getSystemService(ConnectivityManager::class.java) }
    private val callback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            result.locations.forEach { persist(it) }
        }
    }
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
            updateOnline(caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED))
        }
        override fun onLost(network: Network) { updateOnline(false) }
    }
    private fun updateOnline(online: Boolean) {
        synchronized(this) {
            val now = System.currentTimeMillis()
            val since = state.getLong("offlineSince", 0)
            if (!online && since == 0L) state.edit().putLong("offlineSince", now).apply()
            if (online && since > 0L) state.edit()
                .putLong("offlineTotal", state.getLong("offlineTotal", 0) + now - since)
                .putLong("offlineSince", 0).apply()
        }
    }
    private fun battery(): Int = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        ?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
    private fun persist(location: Location) {
        if (!location.hasAccuracy() || !location.accuracy.isFinite() || location.accuracy <= 0f ||
            !location.latitude.isFinite() || !location.longitude.isFinite()) {
            state.edit().putInt("invalidFixes", state.getInt("invalidFixes", 0) + 1).apply()
            return
        }
        val event = JSONObject().put("event_id", UUID.randomUUID().toString())
            .put("captured_at", Instant.ofEpochMilli(location.time).toString())
            .put("latitude", location.latitude).put("longitude", location.longitude)
            .put("accuracy_m", location.accuracy.toDouble())
        executor.execute {
            try {
                val dao = LocationDatabase.get(applicationContext).locations()
                val boundDevice = PocCredentials(applicationContext).deviceId
                require(boundDevice.isNotBlank())
                dao.insert(PendingLocation(event.getString("event_id"), boundDevice, event.getString("captured_at"),
                    CryptoBox().encrypt(event.toString())))
                state.edit().putLong("lastFixAt", location.time)
                    .putInt("capturedCount", state.getInt("capturedCount", 0) + 1).apply()
                SyncWorker.enqueue(applicationContext)
            } catch (_: Exception) {
                state.edit().putInt("writeFailures", state.getInt("writeFailures", 0) + 1).apply()
                stopSelf()
            }
        }
    }
    override fun onCreate() {
        super.onCreate()
        state.edit().putLong("startedAt", System.currentTimeMillis()).putBoolean("running", true)
            .remove("captureError")
            .putLong("offlineTotal", 0).putLong("offlineSince", 0)
            .putInt("invalidFixes", 0).putInt("writeFailures", 0)
            .putInt("capturedCount", 0).putInt("ackCount", 0).putInt("duplicateCount", 0)
            .putInt("batteryStart", battery()).apply()
        val channel = NotificationChannel("gps-poc", "GPS PoC en curso", NotificationManager.IMPORTANCE_LOW)
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        try {
            connectivity.registerDefaultNetworkCallback(networkCallback)
            val caps = connectivity.getNetworkCapabilities(connectivity.activeNetwork)
            updateOnline(caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true)
        } catch (_: Exception) { updateOnline(false) }
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "STOP") { stopSelf(); return START_NOT_STICKY }
        val credentials = PocCredentials(this)
        val tokenAvailable = runCatching { credentials.token.isNotBlank() }.getOrDefault(false)
        if (!captureReady(BuildConfig.REAL_CAPTURE_ENABLED, credentials.deviceId, credentials.apiBase,
                BuildConfig.POC_API_ORIGIN, tokenAvailable) ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED ||
            (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)) {
            state.edit().putString("captureError", "Permiso o identidad no disponible para iniciar.").apply()
            stopSelf(); return START_NOT_STICKY
        }
        if (trackingStarted) return START_NOT_STICKY
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification: Notification = NotificationCompat.Builder(this, "gps-poc")
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle("GEOPS GPS PoC activo")
            .setContentText("La ubicación se captura hasta que la detengas.")
            .setOngoing(true).setContentIntent(open).build()
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(11, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
            else startForeground(11, notification)
        } catch (_: SecurityException) {
            state.edit().putString("captureError", "Android rechazó el servicio de ubicación.").apply()
            stopSelf(); return START_NOT_STICKY
        } catch (_: IllegalStateException) {
            state.edit().putString("captureError", "Android no permitió iniciar el servicio.").apply()
            stopSelf(); return START_NOT_STICKY
        }
        val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 60_000L)
            .setMinUpdateIntervalMillis(60_000L).build()
        try {
            trackingStarted = true
            fused.requestLocationUpdates(request, callback, Looper.getMainLooper())
                .addOnFailureListener {
                    trackingStarted = false
                    state.edit().putString("captureError", "El proveedor rechazó las actualizaciones de ubicación.").apply()
                    stopSelf()
                }
        } catch (_: SecurityException) {
            trackingStarted = false
            state.edit().putString("captureError", "Permiso de ubicación rechazado.").apply()
            stopSelf()
        }
        return START_NOT_STICKY
    }
    override fun onDestroy() {
        try { fused.removeLocationUpdates(callback) } catch (_: Exception) {}
        try { connectivity.unregisterNetworkCallback(networkCallback) } catch (_: Exception) {}
        val now = System.currentTimeMillis()
        val started = state.getLong("startedAt", now)
        val offlineSince = state.getLong("offlineSince", 0)
        val total = state.getLong("offlineTotal", 0) + if (offlineSince > 0) now - offlineSince else 0L
        state.edit().putBoolean("running", false).putLong("lastDuration", now - started)
            .putLong("offlineTotal", total).putLong("offlineSince", 0)
            .putInt("batteryEnd", battery()).apply()
        executor.shutdown()
        super.onDestroy()
    }
    override fun onBind(intent: Intent?): IBinder? = null
}
