import java.util.Properties
import java.io.FileInputStream

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Load signing config from keystore.properties (gitignored). The file lives
// at the project root next to settings.gradle.kts, not in the app/ dir, so
// the deploy box can drop one file in without touching source.
val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = Properties()
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(FileInputStream(keystorePropertiesFile))
}

android {
    namespace = "com.dnkdialer.companion"
    compileSdk = 34

    defaultConfig {
        // NOTE: applicationId is the Play Store package name and is
        // PERMANENT once published. Decide before first Play Console upload
        // whether to rename to com.computercaller.companion for brand
        // alignment. (Ken dispatch #14, 2026-05-24.)
        applicationId = "com.dnkdialer.companion"
        minSdk = 26
        targetSdk = 34
        // versionCode: monotonically increasing integer — bump every new APK
        // shipped (debug or release). Play Store requires strictly higher
        // than the highest one already on the track.
        // versionName: human-readable; Play Console shows this on listing.
        versionCode = 13
        versionName = "1.0.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        create("release") {
            if (keystorePropertiesFile.exists()) {
                storeFile = file(keystoreProperties["storeFile"] as String)
                storePassword = keystoreProperties["storePassword"] as String
                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["keyPassword"] as String
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Wire the release signing config so `assembleRelease` produces
            // a signed APK ready for Play Console + sideload.
            if (keystorePropertiesFile.exists()) {
                signingConfig = signingConfigs.getByName("release")
            }
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.google.android.material:material:1.11.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")

    // WebSocket library
    implementation("org.java-websocket:Java-WebSocket:1.5.4")

    // JSON parsing
    implementation("com.google.code.gson:gson:2.10.1")

    // QR Code generation (ZXing)
    implementation("com.google.zxing:core:3.5.2")

    // QR Code scanning
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")

    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.5")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.1")
}
