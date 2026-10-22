package com.geops.mobile

import android.app.Application
import com.geops.agent.GeopsLocationService
import java.util.concurrent.Executors

/** Wires Android service redelivery and bounded autonomous policy recovery. */
class GeopsApplication : Application() {
    private val recovery = Executors.newSingleThreadExecutor()

    override fun onCreate() {
        super.onCreate()
        // Upload-only persisted job; Android may defer it under Doze or OEM limits.
        runCatching { SyncJobs.ensureSweep(this) }
        GeopsLocationService.onSystemRedelivery = { service ->
            recovery.execute { AgentRuntime.recover(service) }
        }
        GeopsLocationService.onAutonomousStart = { service ->
            recovery.execute { AgentRuntime.recover(service) }
        }
        GeopsLocationService.onDestroyed = AgentRuntime::onServiceDestroyed
        // A persisted upload job or a visible launch can revive this process after an OEM kill.
        // Recreate the next window alarm without requesting a location here.
        runCatching { WindowWakeScheduler.reconcile(this) }
    }
}
