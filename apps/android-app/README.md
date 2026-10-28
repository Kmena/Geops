# GEOPS Android Enterprise candidate

This module packages one APK (`com.geops.mobile`) for supervised QR enrollment or per-device ManageEngine Managed Configurations. The origin is currently the GEOPS Staging URL compiled into the client. No physical device has been tested in this branch. Android does not launch an APK merely because MDM installed it; validate ManageEngine **Launch app after installation** on a Fully Managed device. Offline GPS authorization remains limited to 12 hours.

For managed enrollment, the administrator issues a one-use invitation for one linked MDM device and assigns its five values through Managed Configurations. The visible activity reads them, signs the challenge with Android Keystore, and starts GPS automatically only if Android has granted all required permissions. The foreground service displays a notification. The QR supervised path remains available. See [Android Enterprise readiness](../../specs/spec-03-clients-geofences-routes/android-enterprise-mdm-readiness.md) for the exact ManageEngine procedure and physical validation gates.

## Local build and signing

Build with JDK 17+, Android SDK 36 and Gradle 8.14, or use `Dockerfile.build` from the repository root. Without signing variables, `assembleRelease` produces `build/outputs/apk/release/GeopsAndroid-release-unsigned.apk`; this file must not be uploaded to MDM. An authorized operator must provide the existing approved keystore outside the repository through all four environment variables: `GEOPS_ANDROID_RELEASE_KEYSTORE`, `GEOPS_ANDROID_RELEASE_STORE_PASSWORD`, `GEOPS_ANDROID_RELEASE_KEY_ALIAS` and `GEOPS_ANDROID_RELEASE_KEY_PASSWORD`. Gradle fails if the set is incomplete or the file is missing. There is no fallback to a test key.

```powershell
docker build -t geops-android-build:local -f apps/android-app/Dockerfile.build apps/android-app
docker run --rm -v "${PWD}:/workspace" -w /workspace/apps/android-app -e GRADLE_USER_HOME=/tmp/geops-gradle geops-android-build:local gradle assembleRelease --no-daemon
```

The example produces an unsigned APK. To sign, mount the approved keystore read-only if using Docker and inject the four variables from the operator's protected environment; never put passwords in arguments, repository env files or logs. Verify the signed APK with Android SDK `apksigner verify --verbose --print-certs`, record its SHA-256, compare the certificate with the installed APK, and check that `versionCode` increased. Do not uninstall as an update workaround: that can lose the Android Keystore identity and encrypted offline queue.

No APK was installed or published in this branch. Do not upload the unsigned APK or disclose invitation secrets.
