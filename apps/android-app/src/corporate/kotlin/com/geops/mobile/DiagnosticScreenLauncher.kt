package com.geops.mobile

import android.app.Activity
import android.content.Intent

internal object DiagnosticScreenLauncher {
    fun open(activity: Activity) {
        activity.startActivity(Intent(activity, DiagnosticActivity::class.java))
    }
}
