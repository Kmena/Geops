package com.geops.mobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import com.geops.agent.GeopsLocationService

/** A boot broadcast is best effort: force-stop and device restrictions can suppress it. */
class AutonomousBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        if (action == Intent.ACTION_BOOT_COMPLETED) AgentRuntime.markBoot(context)
        if (!AgentRuntime.mayAutostart(context)) return
        val service = Intent(context, GeopsLocationService::class.java)
            .setAction(GeopsLocationService.ACTION_AUTONOMOUS_START)
        try {
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(service)
            else context.startService(service)
        } catch (_: RuntimeException) {
            // Android/OEM may reject background FGS starts; a later allowed start can recover.
        }
    }
}
