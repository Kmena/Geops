import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application") version "8.13.2"
    id("org.jetbrains.kotlin.android") version "2.3.0"
}

android {
    namespace = "com.geops.mobile"
    compileSdk = 36
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "com.geops.mobile"
        minSdk = 26
        targetSdk = 35
        versionCode = 9
        versionName = "0.1.8-enterprise-candidate"
    }
    sourceSets.getByName("main") {
        java.srcDirs("../android-agent/src/main/kotlin", "../android-agent/src/android/kotlin")
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    val releaseKeystore = providers.environmentVariable("GEOPS_ANDROID_RELEASE_KEYSTORE").orNull
    val releaseStorePassword = providers.environmentVariable("GEOPS_ANDROID_RELEASE_STORE_PASSWORD").orNull
    val releaseKeyAlias = providers.environmentVariable("GEOPS_ANDROID_RELEASE_KEY_ALIAS").orNull
    val releaseKeyPassword = providers.environmentVariable("GEOPS_ANDROID_RELEASE_KEY_PASSWORD").orNull
    val signingValues = listOf(releaseKeystore, releaseStorePassword, releaseKeyAlias, releaseKeyPassword)
    require(signingValues.all { it.isNullOrBlank() } || signingValues.all { !it.isNullOrBlank() }) {
        "Release signing requires all four GEOPS_ANDROID_RELEASE_* environment variables"
    }
    if (signingValues.all { !it.isNullOrBlank() }) {
        val keyFile = file(releaseKeystore!!)
        require(keyFile.isFile) { "Release keystore does not exist" }
        signingConfigs.create("externalRelease") {
            storeFile = keyFile
            storePassword = releaseStorePassword!!
            keyAlias = releaseKeyAlias!!
            keyPassword = releaseKeyPassword!!
        }
    }
    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("externalRelease")
        }
    }
}

kotlin { compilerOptions { jvmTarget.set(JvmTarget.JVM_17) } }

dependencies {
    implementation("androidx.activity:activity:1.13.0")
    implementation("androidx.fragment:fragment:1.9.1")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    implementation("com.google.android.gms:play-services-location:21.4.0")
}
