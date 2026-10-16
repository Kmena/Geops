import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.kapt")
}
android {
    namespace = "com.geops.weekendpoc"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.geops.weekendpoc"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        val approved = providers.gradleProperty("pocRealCapture").orNull == "true"
        buildConfigField("boolean", "REAL_CAPTURE_ENABLED", approved.toString())
        val origin = providers.gradleProperty("pocApiOrigin").orNull ?: "https://gps-poc.example.invalid"
        require(Regex("^https://[A-Za-z0-9.-]+(?::443)?$").matches(origin))
        buildConfigField("String", "POC_API_ORIGIN", "\"${origin}\"")
    }
    buildFeatures { buildConfig = true }
    buildTypes { release { isMinifyEnabled = false } }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
}
kotlin { compilerOptions { jvmTarget = JvmTarget.fromTarget("17") } }
dependencies {
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.activity:activity-ktx:1.12.0")
    implementation("androidx.room:room-runtime:2.8.5")
    implementation("androidx.room:room-ktx:2.8.5")
    kapt("androidx.room:room-compiler:2.8.5")
    implementation("androidx.work:work-runtime-ktx:2.12.0")
    implementation("com.google.android.gms:play-services-location:21.4.0")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    testImplementation("junit:junit:4.13.2")
}
