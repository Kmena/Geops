package com.geops.mobile

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import com.geops.agent.AndroidAgentClock
import com.geops.agent.AndroidKeys
import com.geops.agent.AgentStateFiles
import com.geops.agent.BatchSync
import com.geops.agent.DiagnosticFiles
import com.geops.agent.DiagnosticEvent
import com.geops.agent.DiagnosticKind
import com.geops.agent.DiagnosticReason
import com.geops.agent.EncryptedDiagnosticJournal
import com.geops.agent.EncryptedFileAgentStore
import com.geops.agent.HttpsEnrollmentTransport
import com.geops.agent.Identity
import com.geops.agent.PendingUpload
import com.geops.agent.PopBatchTransport
import com.geops.agent.PopConfigTransport
import com.geops.agent.PopHttpClient
import com.geops.agent.PolicyEngine
import com.geops.agent.RefreshingSessionProvider
import com.geops.agent.SYNTHETIC_STAGING_BASE_URL
import com.geops.agent.UploadStatus
import com.geops.agent.recordSafely
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** Platform JobScheduler drains the encrypted queue and refreshes a dormant policy. No GPS access. */
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
            var nextDelayMs: Long? = null
            try {
                val context = applicationContext
                val preferences = context.getSharedPreferences("geops_agent_identity", Context.MODE_PRIVATE)
                val deviceId = preferences.getString("device_id", null)
                val keyId = preferences.getString("key_id", null)
                val installationId = preferences.getString("installation_id", null)
                if (deviceId != null && keyId != null && installationId != null) {
                    val identity = Identity(deviceId, installationId)
                    val key = AndroidKeys.existingStateKey(AgentRuntime.STATE_ALIAS)
                    val stateFile = AgentStateFiles.resolve(context.filesDir.toPath(), identity, key)
                    val store = EncryptedFileAgentStore(stateFile, key)
                    if (store.read().pending.any { !it.quarantined } && !store.read().uploadAuthBlocked) {
                        val clock = AndroidAgentClock(applicationContext) { "upload-only" }
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
                            UploadStatus.PENDING -> nextDelayMs = result.nextDelayMs
                            UploadStatus.AUTH_REQUIRED -> {
                                SyncJobs.cancelUploads(context)
                                AgentRuntime.onUploadAuthorizationRejected(context)
                            }
                            UploadStatus.IDENTITY_MISMATCH -> SyncJobs.cancelUploads(context)
                            UploadStatus.EMPTY -> Unit
                        }
                    }
                    if (!stopped.get() && !AgentRuntime.isRunning())
                        refreshDormantPolicy(context, identity, keyId, store, key)
                }
            } catch (_: Exception) {
                // The encrypted queue is left intact. Never log exception text or request payloads.
                retry = true
            } finally {
                running.set(false)
                if (!stopped.get()) {
                    jobFinished(params, retry)
                    if (!retry) nextDelayMs?.let { delay ->
                        runCatching { SyncJobs.enqueuePending(this, delay) }
                    }
                }
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

    private fun refreshDormantPolicy(context: Context, identity: Identity, keyId: String,
                                     store: EncryptedFileAgentStore, key: javax.crypto.SecretKey) {
        val state = store.read()
        // A user stop or authentication rejection must never be undone by a background poll.
        if (state.uploadAuthBlocked || state.snapshot == null ||
            (!state.autonomousEnabled && state.snapshot?.active != false)) return
        val clock = AndroidAgentClock(context) { AgentRuntime.currentBootId(context) }
        val diagnostics = EncryptedDiagnosticJournal(
            DiagnosticFiles.scoped(context.noBackupFilesDir.toPath(), identity), key)
        try {
            val signer = AndroidKeys.existingEnrollmentSigner(AgentRuntime.SIGNING_ALIAS)
            val session = RefreshingSessionProvider(identity.deviceId, keyId, signer,
                HttpsEnrollmentTransport(SYNTHETIC_STAGING_BASE_URL))
            val http = PopHttpClient(SYNTHETIC_STAGING_BASE_URL, session,
                AndroidKeys.existingSigningKey(AgentRuntime.SIGNING_ALIAS, keyId), clock)
            val policy = PolicyEngine(identity, clock, store) {
                android.icu.util.TimeZone.getTZDataVersion()
            }
            val before = clock.read()
            val incoming = PopConfigTransport(http).fetch(identity)
            if (stopped.get() || AgentRuntime.isRunning()) return
            val latest = store.read()
            if (latest.uploadAuthBlocked ||
                (!latest.autonomousEnabled && latest.snapshot?.active != false)) return
            val snapshot = policy.acceptFetched(incoming, before, clock.read())
            diagnostics.recordSafely(DiagnosticEvent(DiagnosticKind.POLICY_RECEIVED,
                System.currentTimeMillis(), assignmentVersion = snapshot.assignmentVersion,
                policyRevision = snapshot.policy?.revision))
            WindowWakeScheduler.reconcile(context)
        } catch (failure: Exception) {
            diagnostics.recordSafely(DiagnosticEvent(DiagnosticKind.POLICY_REFRESH_FAILED,
                System.currentTimeMillis(), DiagnosticReason.CONFIG_REQUEST_FAILED))
            if (failure.message == "config_http_401" || failure.message == "config_http_403")
                WindowWakeScheduler.blockForAuthorization(context)
        }
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
