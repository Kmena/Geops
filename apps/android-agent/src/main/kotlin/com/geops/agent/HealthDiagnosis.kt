package com.geops.agent

/** Direct observations only. NO_COMMUNICATION is inferred by the server from silence. */
enum class ObservedHealthState { ONLINE, GPS_UNAVAILABLE, NETWORK_UNAVAILABLE, BATTERY_LOW,
    BATTERY_CRITICAL, POWER_SAVE_ENABLED, UNKNOWN }

object HealthDiagnosis {
    fun classify(observation: HealthObservation, trackingRunning: Boolean): Set<ObservedHealthState> {
        val states = mutableSetOf<ObservedHealthState>()
        if (observation.providerAvailable == false) states += ObservedHealthState.GPS_UNAVAILABLE
        if (observation.networkAvailable == false) states += ObservedHealthState.NETWORK_UNAVAILABLE
        if (observation.batteryPercent != null) {
            if (observation.batteryPercent <= 5) states += ObservedHealthState.BATTERY_CRITICAL
            else if (observation.batteryPercent <= 15) states += ObservedHealthState.BATTERY_LOW
        }
        if (observation.powerSave == true) states += ObservedHealthState.POWER_SAVE_ENABLED
        if (states.isEmpty()) {
            states += if (trackingRunning && observation.providerAvailable == true &&
                observation.networkAvailable == true && observation.batteryPercent != null &&
                observation.powerSave != null) ObservedHealthState.ONLINE else ObservedHealthState.UNKNOWN
        }
        return states
    }
}
