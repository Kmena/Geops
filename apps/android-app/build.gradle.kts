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
        versionCode = 1
        versionName = "0.1.0-test"
    }
    sourceSets.getByName("main") {
        java.srcDirs("../android-agent/src/main/kotlin", "../android-agent/src/android/kotlin")
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    val keystore = providers.environmentVariable("GEOPS_ANDROID_KEYSTORE").orNull
    val storePassword = providers.environmentVariable("GEOPS_ANDROID_STORE_PASSWORD").orNull
    val keyPassword = providers.environmentVariable("GEOPS_ANDROID_KEY_PASSWORD").orNull
    if (keystore != null && storePassword != null && keyPassword != null) {
        signingConfigs.create("test") {
            storeFile = file(keystore)
            this.storePassword = storePassword
            keyAlias = "geops-test"
            this.keyPassword = keyPassword
        }
    }
    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("test")
        }
    }
}

kotlin { compilerOptions { jvmTarget.set(JvmTarget.JVM_17) } }
