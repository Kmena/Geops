package com.geops.agent

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.location.LocationManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.PowerManager
import android.os.SystemClock

/** Platform adapter only. No receiver, service or device is started by this class. */
class AndroidHealthProbe(private val context: Context) : HealthProbe {
    override fun observe(): HealthObservation {
        val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = battery?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = battery?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val percent = if (level >= 0 && scale > 0) (level * 100 / scale).coerceIn(0, 100) else null
        val status = battery?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val plugged = battery?.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1) ?: -1
        val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        val location = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val network = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val networkAvailable = try {
            network.getNetworkCapabilities(network.activeNetwork)
                ?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        } catch (_: SecurityException) { null }
        return HealthObservation(percent,
            if (status < 0) null else status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL,
            if (plugged < 0) null else plugged != 0,
            power.isPowerSaveMode,
            try { location.isProviderEnabled(LocationManager.GPS_PROVIDER) } catch (_: SecurityException) { null },
            networkAvailable)
    }
}

class AndroidAgentClock(private val context: Context, private val bootId: () -> String) : AgentClock {
    override fun read(): ClockReading = ClockReading(System.currentTimeMillis(), SystemClock.elapsedRealtime(),
        bootId(), android.provider.Settings.Global.getInt(
            context.contentResolver, android.provider.Settings.Global.AUTO_TIME, 0) == 1)
}
