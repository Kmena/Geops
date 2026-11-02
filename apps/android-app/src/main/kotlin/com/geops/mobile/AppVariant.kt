package com.geops.mobile

import android.content.Context
import android.content.RestrictionsManager
import android.os.UserManager
import com.geops.agent.AuthenticatedConfigTransport
import com.geops.agent.Identity
import com.geops.agent.Snapshot
import com.geops.agent.VariantPolicyGate

/** Compile-time APK identity; the server independently authorizes the device and policy. */
internal object AppVariant {
    val corporate: Boolean = BuildConfig.GEOPS_VARIANT == "CORPORATE_MANAGED"

    fun requireEnrollment(context: Context) {
        val saved = context.getSharedPreferences("geops_agent_identity", Context.MODE_PRIVATE)
        if (!corporate) {
            require(!saved.getBoolean("managed_enrolled", false)) { "personal_managed_identity" }
            return
        }
        require(saved.getBoolean("managed_enrolled", false)) { "mdm_enrollment_required" }
        val restrictions = (context.getSystemService(Context.RESTRICTIONS_SERVICE) as? RestrictionsManager)
            ?.applicationRestrictions ?: error("mdm_configuration_missing")
        require(!restrictions.getBoolean(UserManager.KEY_RESTRICTIONS_PENDING, false) &&
            restrictions.getString("geops_device_id") == saved.getString("device_id", null) &&
            restrictions.getString("mdm_device_id") == saved.getString("managed_mdm_device_id", null)) {
            "mdm_configuration_mismatch"
        }
    }

    fun requireSnapshot(snapshot: Snapshot) =
        VariantPolicyGate.requireAllowed(snapshot, BuildConfig.GEOPS_VARIANT)

    fun checked(transport: AuthenticatedConfigTransport): AuthenticatedConfigTransport =
        object : AuthenticatedConfigTransport {
            override fun fetch(identity: Identity): Snapshot = transport.fetch(identity).also(::requireSnapshot)
        }
}
