package com.geops.agent

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.os.Looper
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.Tasks
import java.util.concurrent.TimeUnit

/** Foreground service; autonomous starts remain subject to Android FGS restrictions. */
class GeopsLocationService : Service() {
    companion object {
        /** Installed by the application process before any service component is created. */
        @Volatile var onSystemRedelivery: ((GeopsLocationService) -> Unit)? = null
        @Volatile var onDestroyed: ((GeopsLocationService) -> Unit)? = null
        @Volatile var onAutonomousStart: ((GeopsLocationService) -> Unit)? = null
        const val ACTION_AUTONOMOUS_START = "com.geops.mobile.AUTONOMOUS_START"
    }
    private val binder = LocalBinder()
    @Volatile private var promoted = false
    @Volatile private var listener: LocationListener? = null
    @Volatile private var fusedCallback: LocationCallback? = null
    @Volatile private var provider = "NONE"
    @Volatile private var registeredAtMs = -1L
    @Volatile private var preferPlatformUntilMs = 0L
    fun isGpsRegistered(): Boolean = promoted && (listener != null || fusedCallback != null)
    fun providerName(): String = provider
    fun registeredAtMs(): Long = registeredAtMs
    fun preferPlatformProvider() { preferPlatformUntilMs = System.currentTimeMillis() + 3_600_000L }
    @Volatile private var listenerGeneration = 0L
    private var diagnostics: DiagnosticRecorder? = null
    private val earlyTransitions = ArrayDeque<DiagnosticEvent>()
    @Synchronized fun attachDiagnostics(recorder: DiagnosticRecorder) {
        diagnostics = recorder
        earlyTransitions.forEach(recorder::recordSafely)
        earlyTransitions.clear()
    }
    @Synchronized private fun observe(kind: DiagnosticKind) {
        val event = DiagnosticEvent(kind, System.currentTimeMillis())
        val sink = diagnostics
        if (sink == null) {
            if (earlyTransitions.size == 16) earlyTransitions.removeFirst()
            earlyTransitions.addLast(event)
        } else sink.recordSafely(event)
    }
    inner class LocalBinder : Binder() { fun service(): GeopsLocationService = this@GeopsLocationService }
    override fun onBind(intent: Intent?): IBinder = binder
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        observe(DiagnosticKind.FGS_START_COMMAND)
        try {
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(NotificationChannel("geops-tracking", "GEOPS tracking",
                NotificationManager.IMPORTANCE_LOW))
            val alreadyCapturing = isGpsRegistered()
            val notification = Notification.Builder(this, "geops-tracking")
                .setContentTitle(if (alreadyCapturing) "GEOPS: ubicación laboral activa" else "GEOPS: verificando política")
                .setContentText(if (alreadyCapturing) "Seguimiento durante horario autorizado" else "Sin captura hasta confirmar horario autorizado")
                .setSmallIcon(android.R.drawable.ic_menu_mylocation).setOngoing(true).build()
            if (Build.VERSION.SDK_INT >= 29) startForeground(701, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
            else startForeground(701, notification)
            promoted = true
            observe(DiagnosticKind.FGS_PROMOTED)
        } catch (_: RuntimeException) {
            promoted = false
            observe(DiagnosticKind.FGS_PROMOTION_FAILED)
            stopSelf()
        }
        if (!promoted) return START_NOT_STICKY
        if (intent?.action == ACTION_AUTONOMOUS_START) {
            val handler = onAutonomousStart
            if (handler == null) stopSelf() else handler(this)
        } else if ((flags and START_FLAG_REDELIVERY) != 0 || (flags and START_FLAG_RETRY) != 0) {
            val handler = onSystemRedelivery
            if (handler == null) stopSelf() else handler(this)
        }
        // Android may attempt redelivery. The encrypted intent and current window still gate capture.
        return START_REDELIVER_INTENT
    }
    fun isCurrentListener(generation: Long): Boolean = isGpsRegistered() &&
        listenerGeneration == generation

    fun runtime(onFix: (Location, Long) -> Unit): TrackingRuntime = object : TrackingRuntime {
        override fun startVisibleAndRegister(intervalSeconds: Int): Boolean {
            if (!promoted || isGpsRegistered()) return false
            if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) !=
                PackageManager.PERMISSION_GRANTED) return false
            val generation = listenerGeneration + 1
            listenerGeneration = generation
            if ((System.currentTimeMillis() < preferPlatformUntilMs ||
                    !registerFused(intervalSeconds, generation, onFix)) &&
                !registerGps(intervalSeconds, generation, onFix)) return false
            val active = Notification.Builder(this@GeopsLocationService, "geops-tracking")
                .setContentTitle("GEOPS: ubicación laboral activa")
                .setContentText("Seguimiento durante horario autorizado")
                .setSmallIcon(android.R.drawable.ic_menu_mylocation).setOngoing(true).build()
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(701, active)
            registeredAtMs = System.currentTimeMillis()
            observe(DiagnosticKind.LISTENER_REGISTERED)
            return true
        }
        override fun pauseCapture() {
            unregister()
            if (promoted) {
                val waiting = Notification.Builder(this@GeopsLocationService, "geops-tracking")
                    .setContentTitle("GEOPS: verificando política")
                    .setContentText("Sin captura hasta confirmar horario autorizado")
                    .setSmallIcon(android.R.drawable.ic_menu_mylocation).setOngoing(true).build()
                (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(701, waiting)
            }
        }
        override fun stopAndUnregister() { unregister(); stopForeground(STOP_FOREGROUND_REMOVE); promoted = false; stopSelf() }
        override fun isRegistered() = isGpsRegistered()
    }
    private fun registerFused(intervalSeconds: Int, generation: Long,
                              onFix: (Location, Long) -> Unit): Boolean {
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) !=
            PackageManager.PERMISSION_GRANTED) return false
        if (GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(this) != ConnectionResult.SUCCESS)
            return false
        val callback = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                result.locations.forEach { fix ->
                    if (provider == "FUSED_GMS" && fusedCallback === this &&
                        isCurrentListener(generation)) onFix(fix, generation)
                }
            }
        }
        return try {
            val client = LocationServices.getFusedLocationProviderClient(this)
            val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY,
                intervalSeconds * 1000L).setMinUpdateIntervalMillis(intervalSeconds * 1000L).build()
            Tasks.await(client.requestLocationUpdates(request, callback, Looper.getMainLooper()),
                10, TimeUnit.SECONDS)
            fusedCallback = callback
            provider = "FUSED_GMS"
            observe(DiagnosticKind.PROVIDER_FUSED)
            true
        } catch (_: SecurityException) {
            runCatching { LocationServices.getFusedLocationProviderClient(this).removeLocationUpdates(callback) }
            false
        } catch (_: Exception) {
            runCatching { LocationServices.getFusedLocationProviderClient(this).removeLocationUpdates(callback) }
            false
        }
    }

    private fun registerGps(intervalSeconds: Int, generation: Long,
                            onFix: (Location, Long) -> Unit): Boolean {
        val location = getSystemService(Context.LOCATION_SERVICE) as LocationManager
        if (!location.isProviderEnabled(LocationManager.GPS_PROVIDER)) return false
        val next = LocationListener { fix ->
            if (provider == "GPS_PLATFORM" && isCurrentListener(generation)) onFix(fix, generation)
        }
        return try {
            listener = next
            location.requestLocationUpdates(LocationManager.GPS_PROVIDER, intervalSeconds * 1000L,
                0f, next, Looper.getMainLooper())
            provider = "GPS_PLATFORM"
            observe(DiagnosticKind.PROVIDER_GPS)
            true
        } catch (_: SecurityException) { listener = null; listenerGeneration++; false }
          catch (_: IllegalArgumentException) { listener = null; listenerGeneration++; false }
    }
    private fun unregister() {
        listenerGeneration++
        listener?.let {
            (getSystemService(Context.LOCATION_SERVICE) as LocationManager).removeUpdates(it)
            observe(DiagnosticKind.LISTENER_UNREGISTERED)
        }
        listener = null
        fusedCallback?.let {
            runCatching { LocationServices.getFusedLocationProviderClient(this).removeLocationUpdates(it) }
            observe(DiagnosticKind.LISTENER_UNREGISTERED)
        }
        fusedCallback = null
        provider = "NONE"
        registeredAtMs = -1L
    }
    override fun onDestroy() {
        unregister(); promoted = false; observe(DiagnosticKind.FGS_DESTROYED)
        onDestroyed?.invoke(this)
        super.onDestroy()
    }
}
