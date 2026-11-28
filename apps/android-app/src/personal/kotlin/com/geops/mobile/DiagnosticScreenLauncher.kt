package com.geops.mobile

import android.app.Activity

/** The Personal APK has no administrative diagnostics Activity or MDM login code. */
internal object DiagnosticScreenLauncher {
    fun open(@Suppress("UNUSED_PARAMETER") activity: Activity) = Unit
}
