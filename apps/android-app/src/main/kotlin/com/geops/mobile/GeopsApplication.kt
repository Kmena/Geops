package com.geops.mobile

import android.app.Application
import com.geops.agent.GeopsLocationService
import java.util.concurrent.Executors

/** Wires system service redelivery without an alarm, boot receiver or unattended daily start. */
class GeopsApplication : Application() {
    private val recovery = Executors.newSingleThreadExecutor()

    override fun onCreate() {
        super.onCreate()
        // Upload-only persisted job; Android may defer it under Doze or OEM limits.
        runCatching { SyncJobs.ensureSweep(this) }
        GeopsLocationService.onSystemRedelivery = { service ->
            recovery.execute { AgentRuntime.recover(service) }
        }
        GeopsLocationService.onDestroyed = AgentRuntime::onServiceDestroyed
    }
}
