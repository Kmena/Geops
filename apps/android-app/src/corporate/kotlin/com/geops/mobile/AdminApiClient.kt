package com.geops.mobile

import com.geops.agent.SYNTHETIC_STAGING_BASE_URL
import java.net.URL
import javax.net.ssl.HttpsURLConnection
import org.json.JSONObject

/** Separate from the device PoP identity and GPS runtime. No credential or session is written to disk. */
internal object AdminApiClient {
    private const val ORIGIN = "https://geops-staging.duckdns.org"
    private const val COOKIE = "__Host-geops_stage_admin"
    private const val MAX_RESPONSE = 128 * 1024

    data class Session(
        val adminId: String,
        val email: String,
        val cookie: String,
        val csrf: String,
        val expiresAt: String,
        val permissions: Set<String>
    ) {
        fun has(permission: String) = permission in permissions
    }

    data class Response(val body: JSONObject, val cookie: String?)
    class ApiFailure(val status: Int, val code: String) : Exception(code)

    @Volatile private var active: Session? = null
    fun session(): Session? = active

    @Synchronized fun clear() { active = null }

    private fun request(
        method: String, path: String, body: JSONObject? = null, session: Session? = null
    ): Response {
        require(path.startsWith("/v1/admin/") && !path.contains("..") && !path.contains('?'))
        val connection = (URL(SYNTHETIC_STAGING_BASE_URL.trimEnd('/') + path)
            .openConnection() as HttpsURLConnection).apply {
            requestMethod = method
            instanceFollowRedirects = false
            connectTimeout = 10_000
            readTimeout = 10_000
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Origin", ORIGIN)
            if (session != null) {
                setRequestProperty("Cookie", "$COOKIE=${session.cookie}")
                if (method != "GET") setRequestProperty("X-CSRF-Token", session.csrf)
            }
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
            }
        }
        try {
            if (body != null) connection.outputStream.use {
                it.write(body.toString().toByteArray(Charsets.UTF_8))
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val bytes = stream?.use { input ->
                val output = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(4096)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    if (output.size() + count > MAX_RESPONSE) throw ApiFailure(status, "response_too_large")
                    output.write(buffer, 0, count)
                }
                output.toByteArray()
            } ?: ByteArray(0)
            val json = if (bytes.isEmpty()) JSONObject()
                else JSONObject(String(bytes, Charsets.UTF_8))
            if (status !in 200..299) {
                if (status == 401 && session === active) clear()
                throw ApiFailure(status,
                    json.optJSONObject("error")?.optString("code")?.takeIf { it.isNotBlank() }
                        ?: "http_$status")
            }
            val setCookie = connection.getHeaderField("Set-Cookie")
                ?.substringBefore(';')?.takeIf { it.startsWith("$COOKIE=") }
                ?.substringAfter('=')
            return Response(json, setCookie)
        } finally {
            connection.disconnect()
        }
    }

    @Synchronized fun login(email: String, password: CharArray): Session {
        require(AppVariant.corporate)
        val credentials = JSONObject().put("email", email.trim())
            .put("password", String(password))
        try {
            val response = request("POST", "/v1/admin/auth/sessions", credentials)
            val cookie = response.cookie ?: throw ApiFailure(0, "cookie_missing")
            val provisional = Session(
                response.body.getString("admin_id"), email.trim(), cookie,
                response.body.getString("csrf_token"),
                response.body.getString("expires_at"), emptySet()
            )
            val me = request("GET", "/v1/admin/auth/me", session = provisional).body
            val list = request("GET", "/v1/admin/auth/permissions", session = provisional)
                .body.optJSONArray("permissions")
            val permissions = (0 until (list?.length() ?: 0)).mapNotNull {
                list?.optString(it)?.takeIf(String::isNotBlank)
            }.toSet()
            val verified = provisional.copy(email = me.getString("email"), permissions = permissions)
            val previous = active
            if (previous != null && previous.adminId != verified.adminId) {
                runCatching { request("DELETE", "/v1/admin/auth/sessions/current", session = verified) }
                throw ApiFailure(403, "different_admin")
            }
            active = verified
            if (previous != null) runCatching {
                request("DELETE", "/v1/admin/auth/sessions/current", session = previous)
            }
            return verified
        } finally {
            credentials.put("password", "")
            password.fill('\u0000')
        }
    }

    fun verify(): Session {
        val current = active ?: throw ApiFailure(401, "session_missing")
        val list = request("GET", "/v1/admin/auth/permissions", session = current)
            .body.optJSONArray("permissions")
        val updated = current.copy(
            permissions = (0 until (list?.length() ?: 0)).mapNotNull {
                list?.optString(it)?.takeIf(String::isNotBlank)
            }.toSet()
        )
        if (active === current) active = updated
        return updated
    }

    fun get(path: String): JSONObject = request("GET", path, session = verify()).body

    fun post(path: String, body: JSONObject): JSONObject =
        request("POST", path, body, verify()).body

    fun logout() {
        val previous = active
        clear()
        if (previous != null) runCatching {
            request("DELETE", "/v1/admin/auth/sessions/current", session = previous)
        }
    }
}
