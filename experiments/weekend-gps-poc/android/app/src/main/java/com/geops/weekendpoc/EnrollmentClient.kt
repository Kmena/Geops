package com.geops.weekendpoc

import java.io.IOException
import java.net.URL
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLException

internal interface EnrollmentTransport {
    fun post(invitation: Invitation): EnrollmentHttpResponse
}

internal class HttpsEnrollmentTransport : EnrollmentTransport {
    override fun post(invitation: Invitation): EnrollmentHttpResponse {
        val connection = (URL(invitation.apiBase + "/api/device/enroll").openConnection() as HttpsURLConnection)
        try {
            connection.instanceFollowRedirects = false
            connection.requestMethod = "POST"
            connection.connectTimeout = 15000
            connection.readTimeout = 15000
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            connection.setRequestProperty("Accept", "application/json")
            connection.outputStream.use { it.write(invitation.requestBody().toByteArray(Charsets.UTF_8)) }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val body = stream?.bufferedReader(Charsets.UTF_8)?.use { reader ->
                val text = StringBuilder()
                val chars = CharArray(1024)
                while (text.length <= 8192) {
                    val count = reader.read(chars)
                    if (count < 0) break
                    text.append(chars, 0, count)
                }
                if (text.length > 8192) "" else text.toString()
            } ?: ""
            return EnrollmentHttpResponse(status, body)
        } finally {
            connection.disconnect()
        }
    }
}

internal class EnrollmentCoordinator(
    private val transport: EnrollmentTransport,
    private val save: (String, EnrolledDevice) -> Unit,
    private val event: (EnrollmentEvent, Int?) -> Unit
) {
    fun enroll(raw: String, expectedOrigin: String): EnrolledDevice {
        event(EnrollmentEvent.QR_RECOGNIZED, null)
        val invitation = try {
            parseInvitation(raw, expectedOrigin)
        } catch (failure: EnrollmentFailure) {
            event(
                if (failure.kind == EnrollmentFailureKind.ORIGIN_MISMATCH)
                    EnrollmentEvent.QR_ORIGIN_MISMATCH else EnrollmentEvent.QR_JSON_INVALID,
                null
            )
            throw failure
        }
        event(EnrollmentEvent.QR_JSON_VALID, null)
        event(EnrollmentEvent.HTTP_STARTED, null)
        val response = try {
            transport.post(invitation)
        } catch (_: SSLException) {
            event(EnrollmentEvent.TLS_ERROR, null)
            throw EnrollmentFailure(EnrollmentFailureKind.TLS)
        } catch (_: IOException) {
            event(EnrollmentEvent.CONNECTION_ERROR, null)
            throw EnrollmentFailure(EnrollmentFailureKind.CONNECTION)
        }
        event(EnrollmentEvent.HTTP_RESPONSE, response.status)
        val device = parseEnrollmentResponse(response)
        try {
            save(invitation.apiBase, device)
        } catch (_: Exception) {
            throw EnrollmentFailure(EnrollmentFailureKind.LOCAL_STORAGE, response.status)
        }
        event(EnrollmentEvent.ENROLLMENT_CONFIRMED, response.status)
        return device
    }
}
