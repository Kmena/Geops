package com.geops.agent

import java.net.URL
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.Signature
import java.time.Instant
import java.time.ZoneId
import java.util.Base64
import java.util.UUID
import javax.net.ssl.HttpsURLConnection
import org.json.JSONObject

interface SessionTokenProvider { fun currentToken(): String }
interface DeviceSigner { val keyId: String; fun sign(message: ByteArray): ByteArray }
class EcdsaDeviceSigner(override val keyId: String, private val key: PrivateKey) : DeviceSigner {
    override fun sign(message: ByteArray): ByteArray = Signature.getInstance("SHA256withECDSA").run {
        initSign(key); update(message); sign()
    }
}
data class HttpResult(val status: Int, val body: String, val retryAfterSeconds: Int?)

object PopProof {
    fun bytes(method: String, path: String, body: ByteArray, token: String,
              timestamp: String, nonce: String, keyId: String): ByteArray {
        require(method == method.uppercase() && path.startsWith('/') && !path.contains('?') &&
            uuid(keyId) && keyId == keyId.lowercase())
        val encoder = Base64.getUrlEncoder().withoutPadding()
        fun digest(input: ByteArray) = encoder.encodeToString(MessageDigest.getInstance("SHA-256").digest(input))
        return listOf("GEOPS-REQ-V1", method, path, digest(body), digest(token.toByteArray(Charsets.UTF_8)),
            timestamp, nonce, keyId).joinToString("\n").toByteArray(Charsets.UTF_8)
    }
}

/** HTTPS client with SPEC-00 PoP. Caller supplies an AndroidKeyStore-backed signer. */
class PopHttpClient(
    baseUrl: String, private val tokenProvider: SessionTokenProvider,
    private val signer: DeviceSigner, private val clock: AgentClock
) {
    private val target = DeviceRequestTarget(baseUrl)
    init { require(uuid(signer.keyId) && signer.keyId == signer.keyId.lowercase()) }

    fun request(method: String, path: String, body: String = ""): HttpResult {
        require(method == "GET" || method == "POST")
        val url = target.publicUrl(path)
        val token = tokenProvider.currentToken()
        require(token.isNotBlank() && token.length <= 4096)
        val nonce = ByteArray(16).also(java.security.SecureRandom()::nextBytes)
        val encoder = Base64.getUrlEncoder().withoutPadding()
        val timestamp = (clock.read().wallMs / 1000).toString()
        val proof = PopProof.bytes(method, path, body.toByteArray(Charsets.UTF_8), token,
            timestamp, encoder.encodeToString(nonce), signer.keyId)
        val connection = url.openConnection() as HttpsURLConnection
        connection.instanceFollowRedirects = false
        connection.requestMethod = method
        connection.connectTimeout = 10_000
        connection.readTimeout = 20_000
        connection.setRequestProperty("Authorization", "Bearer $token")
        connection.setRequestProperty("X-GEOPS-Key-Id", signer.keyId)
        connection.setRequestProperty("X-GEOPS-Timestamp", timestamp)
        connection.setRequestProperty("X-GEOPS-Nonce", encoder.encodeToString(nonce))
        connection.setRequestProperty("X-GEOPS-Signature", encoder.encodeToString(signer.sign(proof)))
        connection.setRequestProperty("Accept", "application/json")
        connection.setRequestProperty("Cache-Control", "no-store")
        if (method == "POST") {
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
        }
        try {
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val bytes = stream?.use { it.readBytes() } ?: byteArrayOf()
            require(bytes.size <= 262_144) { "response_too_large" }
            return HttpResult(status, String(bytes, Charsets.UTF_8),
                connection.getHeaderField("Retry-After")?.toIntOrNull())
        } finally { connection.disconnect() }
    }
}

/** Public synthetic Staging endpoint; activation must supply this URL explicitly. */
const val SYNTHETIC_STAGING_BASE_URL = "https://geops-staging.duckdns.org/"

/** The dedicated hostname forwards canonical paths unchanged to Fastify. */
internal class DeviceRequestTarget(baseUrl: String) {
    private val base = URL(baseUrl)
    private val canonicalRoute = Regex("^/v[123]/device/[A-Za-z0-9_/-]+$")

    init {
        require(base.protocol == "https" && base.query == null && base.ref == null &&
            base.userInfo == null && base.host.isNotBlank() &&
            (base.path == "" || base.path == "/"))
    }

    fun publicUrl(canonicalPath: String): URL {
        require(canonicalRoute.matches(canonicalPath) && !canonicalPath.contains("//"))
        val url = URL(base, canonicalPath)
        require(url.protocol == "https" && url.host == base.host && url.port == base.port &&
            url.path == canonicalPath && url.query == null && url.ref == null)
        return url
    }
}

class PopConfigTransport(private val http: PopHttpClient) : AuthenticatedConfigTransport {
    override fun fetch(identity: Identity): Snapshot {
        val modern = http.request("GET", "/v2/device/config")
        val result = if (modern.status == 404 || modern.status == 405)
            http.request("GET", "/v1/device/config") else modern
        require(result.status == 200) { "config_http_${result.status}" }
        return ConfigParser.parse(result.body, identity)
    }
}

/** Strict v1/v2 config parser. V2 recurrence is authenticated over bearer+PoP+TLS. */
object ConfigParser {
    fun parse(raw: String, expected: Identity): Snapshot {
        require(raw.length <= 131_072) { "config_too_large" }
        val o = JSONObject(raw)
        val schema = o.getInt("schema_version")
        require(schema in 1..2) { "unknown_config_schema" }
        keys(o, setOf("schema_version", "capture_anchor_id", "device_id", "installation_id",
            "assignment_version", "active", "policy_id", "policy_revision", "policy",
            "server_time", "verified_at", "offline_not_after", "tzdb_version", "window_instances",
            "assignment_start", "authorization_until"))
        require(schema == 2 || (!o.has("assignment_start") && !o.has("authorization_until")))
        val identity = Identity(o.getString("device_id"), o.getString("installation_id"))
        require(identity == expected) { "foreign_config" }
        val active = o.getBoolean("active")
        val policy = if (active) {
            val p = o.getJSONObject("policy")
            keys(p, setOf("name", "days_iso", "start_local", "end_local", "time_zone", "capture_interval_s",
                "sync_interval_s", "heartbeat_missing_after_s", "valid_from", "valid_until", "exceptions",
                "health_interval_s"))
            require(p.getString("name").length in 1..120)
            ZoneId.of(p.getString("time_zone"))
            val days = p.getJSONArray("days_iso")
            val values = (0 until days.length()).map { days.getInt(it) }
            require(values.isNotEmpty() && values.size == values.toSet().size && values.all { it in 1..7 })
            val localTime = Regex("([01][0-9]|2[0-3]):[0-5][0-9]")
            val begins = p.getString("start_local")
            val ends = p.getString("end_local")
            require(begins.matches(localTime) && ends.matches(localTime) && begins != ends)
            require(p.getInt("heartbeat_missing_after_s") in 300..7200)
            p.optJSONArray("exceptions")?.let { require(it.length() <= 366) }
            require(o.getString("tzdb_version").isNotBlank())
            Policy(o.getString("policy_id"), o.getInt("policy_revision"), p.getInt("capture_interval_s"),
                p.getInt("sync_interval_s"), at(p.getString("valid_from")), at(p.getString("valid_until")),
                p.optInt("health_interval_s", 300))
        } else {
            require(!o.has("policy") && !o.has("policy_id") && !o.has("policy_revision"))
            null
        }
        val arr = o.getJSONArray("window_instances")
        require(arr.length() <= 64)
        val windows = (0 until arr.length()).map { i ->
            val w = arr.getJSONObject(i)
            keys(w, setOf("scheduled_session_id", "start_at", "end_at"))
            Window(w.getString("scheduled_session_id"), at(w.getString("start_at")), at(w.getString("end_at")))
        }
        val display = if (active) o.getJSONObject("policy").let { p ->
            val exceptions = p.optJSONArray("exceptions")
            PolicyDisplay(p.getString("name"),
                (0 until p.getJSONArray("days_iso").length()).map { p.getJSONArray("days_iso").getInt(it) },
                p.getString("start_local"), p.getString("end_local"), p.getString("time_zone"),
                if (exceptions == null) emptyList() else (0 until exceptions.length()).map { i ->
                    val ex = exceptions.getJSONObject(i)
                    keys(ex, setOf("local_date", "mode", "start_local", "end_local", "reason"))
                    PolicyException(ex.getString("local_date"), ex.getString("mode"),
                        ex.optString("start_local").takeUnless { it.isEmpty() },
                        ex.optString("end_local").takeUnless { it.isEmpty() })
                })
        } else null
        return Snapshot(identity, o.getLong("assignment_version"), active, o.getString("capture_anchor_id"),
            at(o.getString("server_time")), at(o.getString("verified_at")),
            at(o.getString("offline_not_after")), windows, policy, display, schema,
            if (schema == 2 && active) at(o.getString("assignment_start")) else null,
            if (schema == 2 && active) at(o.getString("authorization_until")) else null,
            if (schema == 2 && active) o.getString("tzdb_version") else null)
    }
    private fun at(value: String) = Instant.parse(value).toEpochMilli()
    private fun keys(o: JSONObject, allowed: Set<String>) {
        require(o.keys().asSequence().all { it in allowed }) { "unexpected_field" }
    }
}
