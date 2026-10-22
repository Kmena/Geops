package com.geops.mobile

import android.Manifest
import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import com.geops.agent.AndroidAgentClock
import com.geops.agent.AndroidKeys
import com.geops.agent.AgentStore
import com.geops.agent.AgentStateFiles
import com.geops.agent.DiagnosticEvent
import com.geops.agent.DiagnosticFiles
import com.geops.agent.DiagnosticKind
import com.geops.agent.DiagnosticReason
import com.geops.agent.EncryptedDiagnosticJournal
import com.geops.agent.EncryptedFileAgentStore
import com.geops.agent.GeopsLocationService
import com.geops.agent.Identity
import com.geops.agent.PolicyEngine
import com.geops.agent.recordSafely

/** A process-independent wake for the next signed/local policy window. It never obtains a fix. */
internal object WindowWakeScheduler {
    const val ACTION_WAKE = "com.geops.mobile.WINDOW_WAKE"
    private const val REQUEST_CODE = 41303
    private const val RETRY_MS = 5 * 60_000L

    private data class LocalState(
        val policy: PolicyEngine,
        val diagnostics: EncryptedDiagnosticJournal,
        val store: AgentStore
    )

    private fun local(context: Context): LocalState? = runCatching {
        val preferences = context.getSharedPreferences("geops_agent_identity", Context.MODE_PRIVATE)
        val identity = Identity(preferences.getString("device_id", null) ?: return null,
            preferences.getString("installation_id", null) ?: return null)
        val key = AndroidKeys.existingStateKey(AgentRuntime.STATE_ALIAS)
        val store = EncryptedFileAgentStore(
            AgentStateFiles.resolve(context.filesDir.toPath(), identity, key), key)
        LocalState(PolicyEngine(identity, AndroidAgentClock(context) { AgentRuntime.currentBootId(context) },
            store) { android.icu.util.TimeZone.getTZDataVersion() },
            EncryptedDiagnosticJournal(
                DiagnosticFiles.scoped(context.noBackupFilesDir.toPath(), identity), key), store)
    }.getOrNull()

    private fun pendingIntent(context: Context, flags: Int): PendingIntent? = PendingIntent.getBroadcast(
        context, REQUEST_CODE, Intent(context, WindowWakeReceiver::class.java).setAction(ACTION_WAKE),
        flags or PendingIntent.FLAG_IMMUTABLE)

    private fun cancel(context: Context) {
        val pending = pendingIntent(context, PendingIntent.FLAG_NO_CREATE) ?: return
        (context.getSystemService(Context.ALARM_SERVICE) as AlarmManager).cancel(pending)
        pending.cancel()
    }

    fun cancelForUser(context: Context) = synchronized(this) { cancel(context) }

    private fun record(local: LocalState?, kind: DiagnosticKind, reason: DiagnosticReason,
                       atMs: Long = System.currentTimeMillis()) {
        local?.diagnostics?.recordSafely(DiagnosticEvent(kind, System.currentTimeMillis(), reason,
            windowStartMs = atMs))
    }

    private fun setAlarm(context: Context, local: LocalState, atMs: Long) {
        val manager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val pending = pendingIntent(context, PendingIntent.FLAG_UPDATE_CURRENT) ?: return
        val exact = Build.VERSION.SDK_INT < 31 || manager.canScheduleExactAlarms()
        try {
            if (exact) manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, pending)
            else manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, pending)
            record(local, DiagnosticKind.WINDOW_WAKE_SCHEDULED,
                if (exact) DiagnosticReason.NONE else DiagnosticReason.EXACT_ALARM_UNAVAILABLE, atMs)
        } catch (_: SecurityException) {
            // An exact-alarm grant can be revoked between the capability check and scheduling.
            try {
                manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, pending)
                record(local, DiagnosticKind.WINDOW_WAKE_SCHEDULED,
                    DiagnosticReason.EXACT_ALARM_UNAVAILABLE, atMs)
            } catch (_: RuntimeException) {
                record(local, DiagnosticKind.WINDOW_WAKE_BLOCKED, DiagnosticReason.SCHEDULING_FAILED)
            }
        } catch (_: RuntimeException) {
            record(local, DiagnosticKind.WINDOW_WAKE_BLOCKED, DiagnosticReason.SCHEDULING_FAILED)
        }
    }

    /** Idempotent: the same PendingIntent replaces the prior alarm after a policy change. */
    @Synchronized fun reconcile(context: Context, includeCurrentWindow: Boolean = true) {
        val app = context.applicationContext
        val local = local(app)
        if (local == null || !local.policy.autonomousEligible()) {
            cancel(app)
            return
        }
        val now = System.currentTimeMillis()
        val current = if (includeCurrentWindow && !AgentRuntime.isRunning())
            local.policy.assessReadOnly().window else null
        val next = if (current != null) now + 2_000L else local.policy.nextWindowStartReadOnly()
        if (next == null) cancel(app) else setAlarm(app, local, next)
    }

    private fun retryWithinWindow(context: Context, local: LocalState, windowEndMs: Long) {
        val retryAt = System.currentTimeMillis() + RETRY_MS
        if (retryAt < windowEndMs) setAlarm(context, local, retryAt)
        else reconcile(context, includeCurrentWindow = false)
    }

    /** Called only by our explicit alarm receiver; authorization is checked again at delivery. */
    @Synchronized fun onAlarm(context: Context) {
        val app = context.applicationContext
        val local = local(app) ?: run { cancel(app); return }
        record(local, DiagnosticKind.WINDOW_WAKE_ATTEMPT, DiagnosticReason.NONE)
        if (!local.policy.autonomousEligible()) {
            record(local, DiagnosticKind.WINDOW_WAKE_BLOCKED, DiagnosticReason.RECOVERY_NOT_AUTHORIZED)
            reconcile(app, includeCurrentWindow = false)
            return
        }
        val assessment = local.policy.assessReadOnly()
        val window = assessment.window
        if (window == null) {
            record(local, DiagnosticKind.WINDOW_WAKE_BLOCKED, assessment.reason)
            reconcile(app, includeCurrentWindow = false)
            return
        }
        if (AgentRuntime.isRunning()) {
            if (AgentRuntime.isGpsActive()) {
                record(local, DiagnosticKind.WINDOW_WAKE_ACTIVE, DiagnosticReason.NONE)
                reconcile(app, includeCurrentWindow = false)
            } else {
                record(local, DiagnosticKind.WINDOW_WAKE_BLOCKED, DiagnosticReason.RECOVERY_FAILED)
                retryWithinWindow(app, local, window.window.endMs)
            }
            return
        }
        val missing = when {
            app.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) !=
                PackageManager.PERMISSION_GRANTED -> DiagnosticReason.FINE_LOCATION_MISSING
            Build.VERSION.SDK_INT >= 29 && app.checkSelfPermission(
                Manifest.permission.ACCESS_BACKGROUND_LOCATION) != PackageManager.PERMISSION_GRANTED ->
                DiagnosticReason.BACKGROUND_LOCATION_MISSING
            !(app.getSystemService(Context.LOCATION_SERVICE) as LocationManager)
                .isProviderEnabled(LocationManager.GPS_PROVIDER) -> DiagnosticReason.GPS_DISABLED
            else -> null
        }
        if (missing != null) {
            record(local, DiagnosticKind.WINDOW_WAKE_BLOCKED, missing)
            retryWithinWindow(app, local, window.window.endMs)
            return
        }
        try {
            app.startForegroundService(Intent(app, GeopsLocationService::class.java)
                .setAction(GeopsLocationService.ACTION_AUTONOMOUS_START))
            record(local, DiagnosticKind.WINDOW_WAKE_DISPATCHED, DiagnosticReason.NONE)
            reconcile(app, includeCurrentWindow = false)
        } catch (_: SecurityException) {
            record(local, DiagnosticKind.WINDOW_WAKE_BLOCKED, DiagnosticReason.FGS_PERMISSION_DENIED)
            retryWithinWindow(app, local, window.window.endMs)
        } catch (_: RuntimeException) {
            record(local, DiagnosticKind.WINDOW_WAKE_BLOCKED, DiagnosticReason.FGS_START_RESTRICTED)
            retryWithinWindow(app, local, window.window.endMs)
        }
    }

    @Synchronized fun onRecoveryResult(context: Context, active: Boolean,
                                        reason: DiagnosticReason = DiagnosticReason.NONE) {
        val local = local(context) ?: return
        record(local, if (active) DiagnosticKind.WINDOW_WAKE_ACTIVE else DiagnosticKind.WINDOW_WAKE_BLOCKED,
            if (active) DiagnosticReason.NONE else reason)
        if (active) reconcile(context, includeCurrentWindow = false)
        else if (reason == DiagnosticReason.AUTH_REJECTED) {
            runCatching { local.store.update {
                it.autonomousEnabled = false
                it.uploadAuthBlocked = true
            } }
            cancel(context)
        }
        else {
            val window = local.policy.assessReadOnly().window
            if (window != null) retryWithinWindow(context, local, window.window.endMs)
            else reconcile(context, includeCurrentWindow = false)
        }
    }

    @Synchronized fun blockForAuthorization(context: Context) {
        val local = local(context)
        record(local, DiagnosticKind.WINDOW_WAKE_BLOCKED, DiagnosticReason.AUTH_REJECTED)
        runCatching { local?.store?.update {
            it.autonomousEnabled = false
            it.uploadAuthBlocked = true
        } }
        cancel(context)
    }

    /** A failed promotion can destroy the service before recovery reports its result. */
    @Synchronized fun onServiceDestroyed(context: Context) {
        val local = local(context) ?: return
        if (AgentRuntime.isGpsActive()) {
            reconcile(context, includeCurrentWindow = false)
            return
        }
        val window = local.policy.assessReadOnly().window
        if (window != null && local.policy.autonomousEligible())
            retryWithinWindow(context, local, window.window.endMs)
        else reconcile(context, includeCurrentWindow = false)
    }
}

class WindowWakeReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action == WindowWakeScheduler.ACTION_WAKE) WindowWakeScheduler.onAlarm(context)
    }
}
