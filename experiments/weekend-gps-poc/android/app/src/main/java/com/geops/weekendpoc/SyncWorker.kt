package com.geops.weekendpoc

import android.content.Context
import android.content.Intent
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkerParameters
import androidx.work.WorkManager
import org.json.JSONArray
import org.json.JSONObject
import java.net.URL
import java.util.UUID
import java.util.concurrent.TimeUnit

class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val dao = LocationDatabase.get(applicationContext).locations()
        val credentials = PocCredentials(applicationContext)
        val token = try { credentials.token } catch (_: Exception) {
            applicationContext.stopService(Intent(applicationContext, TrackingService::class.java))
            return Result.failure()
        }
        if (token.isBlank() || credentials.apiBase != BuildConfig.POC_API_ORIGIN) {
            applicationContext.stopService(Intent(applicationContext, TrackingService::class.java))
            return Result.failure()
        }
        val pending = dao.pending(credentials.deviceId)
        if (pending.isEmpty()) return Result.success()
        val crypto = CryptoBox()
        val events = JSONArray()
        try {
            for (item in pending) events.put(JSONObject(crypto.decrypt(item.encryptedPayload)))
            val payload = JSONObject().put("schema_version", 1).put("batch_id", UUID.randomUUID().toString()).put("events", events)
            val connection = (URL(credentials.apiBase + "/api/device/locations/batches").openConnection() as java.net.HttpURLConnection)
            connection.instanceFollowRedirects = false
            connection.requestMethod = "POST"
            connection.connectTimeout = 15000
            connection.readTimeout = 15000
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setRequestProperty("Authorization", "Bearer " + token)
            connection.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }
            val status = connection.responseCode
            if (status == 200) {
                val response = JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
                fun ids(field: String): Set<String> {
                    val array = response.getJSONArray(field)
                    return (0 until array.length()).map { array.getString(it) }.toSet()
                }
                val sent = pending.map { it.eventId }.toSet()
                val accepted = ids("accepted_event_ids")
                val duplicate = ids("duplicate_event_ids")
                val ack = validatedAck(sent, accepted, duplicate,
                    payload.getString("batch_id"), response.getString("batch_id")) ?: return Result.retry()
                if (ack.isNotEmpty()) {
                    dao.acknowledge(ack.toList(), System.currentTimeMillis())
                    dao.removeAcknowledged()
                    val prefs = applicationContext.getSharedPreferences("poc-state", Context.MODE_PRIVATE)
                    prefs.edit().putLong("lastSyncAt", System.currentTimeMillis())
                        .putInt("ackCount", prefs.getInt("ackCount", 0) + ack.size)
                        .putInt("duplicateCount", prefs.getInt("duplicateCount", 0) + duplicate.size).apply()
                }
                applicationContext.getSharedPreferences("poc-state", Context.MODE_PRIVATE).edit()
                    .remove("syncError").apply()
                if (ack.size != sent.size) return Result.retry()
                if (dao.pendingCountForDevice(credentials.deviceId) > 0) return Result.retry()
                return Result.success()
            }
            if (status == 401 || status == 403 || status == 400 || status == 422) {
                applicationContext.getSharedPreferences("poc-state", Context.MODE_PRIVATE).edit()
                    .putString("syncError", "HTTP " + status + "; requiere intervención").apply()
                applicationContext.stopService(Intent(applicationContext, TrackingService::class.java))
                return Result.failure()
            }
            return Result.retry()
        } catch (_: Exception) { return Result.retry() }
    }
    companion object {
        fun enqueue(context: Context) {
            val request = OneTimeWorkRequestBuilder<SyncWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork("poc-sync", ExistingWorkPolicy.KEEP, request)
        }
    }
}
