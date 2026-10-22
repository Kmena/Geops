package com.geops.mobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Rebuilds the persistent window alarm after boot, package replacement or clock changes. */
class AutonomousBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        when (intent?.action) {
            Intent.ACTION_BOOT_COMPLETED -> {
                AgentRuntime.markBoot(context)
                WindowWakeScheduler.reconcile(context)
            }
            Intent.ACTION_MY_PACKAGE_REPLACED, Intent.ACTION_TIME_CHANGED,
            Intent.ACTION_TIMEZONE_CHANGED, Intent.ACTION_USER_UNLOCKED,
            android.app.AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED ->
                WindowWakeScheduler.reconcile(context)
        }
    }
}
