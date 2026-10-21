package com.geops.mobile

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import com.geops.agent.AndroidAgentClock
import com.geops.agent.AndroidKeys
import com.geops.agent.BatchSync
import com.geops.agent.DiagnosticFiles
import com.geops.agent.EncryptedDiagnosticJournal
import com.geops.agent.EncryptedFileAgentStore
import com.geops.agent.HttpsEnrollmentTransport
import com.geops.agent.Identity
import com.geops.agent.PendingUpload
import com.geops.agent.PopBatchTransport
import com.geops.agent.PopHttpClient
import com.geops.agent.RefreshingSessionProvider
import com.geops.agent.SYNTHETIC_STAGING_BASE_URL
import com.geops.agent.UploadStatus
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** Platform JobScheduler uploads only encrypted, already queued records. It never obtains a location. */
class PendingUploadJobService : JobService() {
    companion object {
        private val running = AtomicBoolean(false)
        internal fun isRunning() = running.get()
    }
    private val executor = Executors.newSingleThreadExecutor()
    private val stopped = AtomicBoolean(false)

    override fun onStartJob(params: JobParameters): Boolean {
        if (!running.compareAndSet(false, true)) return false // The other job drains the same queue.
        stopped.set(false)
        executor.execute {
            var retry = false
            try {
                val context = applicationContext
                val preferences = context.getSharedPreferences("geops_agent_identity", Context.MODE_PRIVATE)
                val deviceId = preferences.getString("device_id", null)
                val keyId = preferences.getString("key_id", null)
                val installationId = preferences.getString("installation_id", null)
                if (deviceId != null && keyId != null && installationId != null) {
                    val identity = Identity(deviceId, installationId)
                    val key = AndroidKeys.existingStateKey(AgentRuntime.STATE_ALIAS)
                    val store = EncryptedFileAgentStore(context.filesDir.toPath().resolve("agent-state.bin"), key)
                    if (store.read().pending.any { !it.quarantined } && !store.read().uploadAuthBlocked) {
                        val clock = AndroidAgentClock { "upload-only" }
                        val diagnostics = EncryptedDiagnosticJournal(
                            DiagnosticFiles.scoped(context.noBackupFilesDir.toPath(), identity), key)
                        val signer = AndroidKeys.existingEnrollmentSigner(AgentRuntime.SIGNING_ALIAS)
                        val session = RefreshingSessionProvider(deviceId, keyId, signer,
                            HttpsEnrollmentTransport(SYNTHETIC_STAGING_BASE_URL))
                        val http = PopHttpClient(SYNTHETIC_STAGING_BASE_URL, session,
                            AndroidKeys.existingSigningKey(AgentRuntime.SIGNING_ALIAS, keyId), clock)
                        val sync = BatchSync(identity, store, clock,
                            PopBatchTransport(http, healthContractApproved = true), diagnostics)
                        val result = PendingUpload(identity, store, clock, sync).run(12) { stopped.get() }
                        when (result.status) {
                            UploadStatus.PENDING -> retry = true
                            UploadStatus.AUTH_REQUIRED -> {
                                SyncJobs.cancelUploads(context)
                                AgentRuntime.onUploadAuthorizationRejected()
                            }
                            UploadStatus.IDENTITY_MISMATCH -> SyncJobs.cancelUploads(context)
                            UploadStatus.EMPTY -> Unit
                        }
                    }
                }
            } catch (_: Exception) {
                // The encrypted queue is left intact. Never log exception text or request payloads.
                retry = true
            } finally {
                running.set(false)
                if (!stopped.get()) jobFinished(params, retry)
            }
        }
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean {
        stopped.set(true)
        return true // Retry when Android next permits a network-constrained job.
    }

    override fun onDestroy() {
        stopped.set(true)
        executor.shutdownNow()
        super.onDestroy()
    }
}

/** Distinct persisted jobs: prompt upload and a 15-minute backlog safety sweep. */
object SyncJobs {
    private const val PROMPT_ID = 41301
    private const val SWEEP_ID = 41302
    private const val SWEEP_MS = 15 * 60_000L

    private fun scheduler(context: Context) = context.getSystemService(JobScheduler::class.java)
    private fun builder(context: Context, id: Int) = JobInfo.Builder(id,
        ComponentName(context, PendingUploadJobService::class.java))
        .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
        .setPersisted(true)
        .setBackoffCriteria(30_000L, JobInfo.BACKOFF_POLICY_EXPONENTIAL)

    @Synchronized fun ensureSweep(context: Context) {
        val jobs = scheduler(context)
        if (jobs.getPendingJob(SWEEP_ID) == null)
            check(jobs.schedule(builder(context, SWEEP_ID).setPeriodic(SWEEP_MS).build()) == JobScheduler.RESULT_SUCCESS)
    }

    @Synchronized fun enqueuePending(context: Context, minimumDelayMs: Long = 300_000L) {
        ensureSweep(context)
        val jobs = scheduler(context)
        if (!PendingUploadJobService.isRunning() && jobs.getPendingJob(PROMPT_ID) == null)
            check(jobs.schedule(builder(context, PROMPT_ID)
                .setMinimumLatency(minimumDelayMs.coerceIn(0, 3_600_000L)).build()) == JobScheduler.RESULT_SUCCESS)
    }

    @Synchronized fun cancelUploads(context: Context) {
        scheduler(context).cancel(PROMPT_ID)
        scheduler(context).cancel(SWEEP_ID)
    }
}
