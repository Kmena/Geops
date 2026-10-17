package com.geops.weekendpoc

import org.json.JSONObject
import java.net.URL
import javax.net.ssl.HttpsURLConnection

internal data class DeviceStatusResponse(val status: Int, val body: String)
internal data class DeviceStatus(val captureEnabled: Boolean)

internal fun localIdentityMessage(deviceId: String, originMatches: Boolean, tokenAvailable: Boolean): String = when {
    deviceId.isBlank() -> "Inscripción pendiente."
    !originMatches -> "Identidad local guardada; el origen no coincide con esta APK."
    !tokenAvailable -> "Identidad local guardada; credencial no disponible."
    else -> "Identidad local guardada; estado del servidor sin verificar."
}

internal fun emptySyncMessage(pending: Int): String =
    if (pending == 0) "Sin pendientes para esta identidad; no se envió solicitud."
    else "Sincronización programada para $pending pendiente(s)."

internal fun parseDeviceStatus(response: DeviceStatusResponse, expectedDeviceId: String): DeviceStatus {
    if (response.status != 200) throw DeviceStatusFailure(response.status)
    try {
        val body = JSONObject(response.body)
        if (body.optString("environment_id") != POC_ENVIRONMENT_ID ||
            body.optString("device_id") != expectedDeviceId ||
            body.opt("capture_enabled") !is Boolean) throw IllegalArgumentException()
        return DeviceStatus(body.getBoolean("capture_enabled"))
    } catch (_: Exception) {
        throw DeviceStatusFailure(response.status, invalidResponse = true)
    }
}

internal class DeviceStatusFailure(val status: Int, val invalidResponse: Boolean = false) : Exception()

internal interface DeviceStatusTransport {
    fun get(base: String, token: String): DeviceStatusResponse
}

internal class DeviceStatusVerifier(private val transport: DeviceStatusTransport) {
    fun verify(base: String, deviceId: String, token: String): Pair<Int, DeviceStatus> {
        require(token.isNotBlank())
        val response = transport.get(base, token)
        return response.status to parseDeviceStatus(response, deviceId)
    }
}

internal class HttpsDeviceStatusTransport : DeviceStatusTransport {
    override fun get(base: String, token: String): DeviceStatusResponse {
        val connection = (URL(base + "/api/device/status").openConnection() as HttpsURLConnection)
        try {
            connection.instanceFollowRedirects = false
            connection.requestMethod = "GET"
            connection.connectTimeout = 15000
            connection.readTimeout = 15000
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("Authorization", "Bearer $token")
            val status = connection.responseCode
            val body = if (status == 200) connection.inputStream.bufferedReader().use { it.readTextLimited() } else ""
            return DeviceStatusResponse(status, body)
        } finally {
            connection.disconnect()
        }
    }
}

private fun java.io.BufferedReader.readTextLimited(): String {
    val chars = CharArray(1024)
    val result = StringBuilder()
    while (result.length <= 8192) {
        val count = read(chars)
        if (count < 0) break
        result.append(chars, 0, count)
    }
    return if (result.length > 8192) "" else result.toString()
}
