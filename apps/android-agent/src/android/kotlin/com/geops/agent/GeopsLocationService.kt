package com.geops.agent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.os.Looper

/** Explicitly started by a visible, authorized app flow. Never started from BOOT_COMPLETED. */
class GeopsLocationService : Service() {
    private val binder = LocalBinder()
    private var promoted = false
    private var listener: LocationListener? = null
    inner class LocalBinder : Binder() { fun service(): GeopsLocationService = this@GeopsLocationService }
    override fun onBind(intent: Intent?): IBinder = binder
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try {
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(NotificationChannel("geops-tracking", "GEOPS tracking",
                NotificationManager.IMPORTANCE_LOW))
            val notification = Notification.Builder(this, "geops-tracking")
                .setContentTitle("GEOPS: verificando política")
                .setContentText("Sin captura hasta confirmar horario autorizado")
                .setSmallIcon(android.R.drawable.ic_menu_mylocation).setOngoing(true).build()
            if (Build.VERSION.SDK_INT >= 29) startForeground(701, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
            else startForeground(701, notification)
            promoted = true
        } catch (_: RuntimeException) {
            promoted = false
            stopSelf()
        }
        return START_NOT_STICKY
    }
    fun runtime(onFix: (Location) -> Unit): TrackingRuntime = object : TrackingRuntime {
        override fun startVisibleAndRegister(intervalSeconds: Int): Boolean {
            if (!promoted || listener != null) return false
            val location = getSystemService(Context.LOCATION_SERVICE) as LocationManager
            if (!location.isProviderEnabled(LocationManager.GPS_PROVIDER)) return false
            val next = LocationListener { fix -> onFix(fix) }
            try {
                location.requestLocationUpdates(LocationManager.GPS_PROVIDER, intervalSeconds * 1000L,
                    0f, next, Looper.getMainLooper())
            } catch (_: SecurityException) { return false }
              catch (_: IllegalArgumentException) { return false }
            listener = next
            val active = Notification.Builder(this@GeopsLocationService, "geops-tracking")
                .setContentTitle("GEOPS: ubicación laboral activa")
                .setContentText("Seguimiento durante horario autorizado")
                .setSmallIcon(android.R.drawable.ic_menu_mylocation).setOngoing(true).build()
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(701, active)
            return true
        }
        override fun stopAndUnregister() { unregister(); stopForeground(STOP_FOREGROUND_REMOVE); promoted = false; stopSelf() }
        override fun isRegistered() = promoted && listener != null
    }
    private fun unregister() {
        listener?.let { (getSystemService(Context.LOCATION_SERVICE) as LocationManager).removeUpdates(it) }
        listener = null
    }
    override fun onDestroy() { unregister(); promoted = false; super.onDestroy() }
}
