# ============================================================
# ComputerCaller v30 (1.0.8) - Bundle C - R8/ProGuard rules
# ============================================================
#
# Pairs with isMinifyEnabled=true + isShrinkResources=true in
# app/build.gradle.kts. Without these keep rules, R8 strips:
#   - Gson @SerializedName fields (-> serialised JSON loses all data)
#   - Java-WebSocket reflection entry points (-> WS handshake crashes)
#   - manifest-referenced Activities / Services / Receivers
#     (-> ClassNotFoundException on broadcast / service start)
#
# After every R8 build, eyeball app-release.apk for ClassNotFoundException
# or NoSuchFieldException at runtime -> add a more targeted -keep here.

# -----------------------------------------------------------------
# Source-line preservation for crash reports
# -----------------------------------------------------------------
# Keep file/line for crash stacks so we can read logcat traces after
# obfuscation. The source filename is renamed to "SourceFile" so the
# original .kt names aren't reverse-engineerable.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# -----------------------------------------------------------------
# Gson - keep @SerializedName fields + enum value()/valueOf()
# -----------------------------------------------------------------
# We use com.google.code.gson:gson:2.10.1 (build.gradle.kts:240).
-keepclassmembers,allowobfuscation class * {
    @com.google.gson.annotations.SerializedName <fields>;
}
-keepclassmembers enum * {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}
# Gson uses default constructors at deserialise time.
-keepclassmembers class * {
    <init>();
}
# Gson types referenced via TypeToken / reflective field lookup.
-keep class com.google.gson.reflect.TypeToken { *; }
-keep class * extends com.google.gson.reflect.TypeToken
-dontwarn sun.misc.**

# -----------------------------------------------------------------
# Java-WebSocket 1.5.4 (org.java-websocket)
# -----------------------------------------------------------------
# Reflective handshake-handler discovery + draft loading.
-keep class org.java_websocket.** { *; }
-dontwarn org.java_websocket.**
-dontwarn org.slf4j.**

# -----------------------------------------------------------------
# AndroidX security-crypto (TokenStore)
# -----------------------------------------------------------------
# EncryptedSharedPreferences instantiates Tink classes by reflection.
-keep class androidx.security.crypto.** { *; }
-keep class com.google.crypto.tink.** { *; }
-dontwarn com.google.crypto.tink.**
-dontwarn com.google.errorprone.annotations.**

# -----------------------------------------------------------------
# Kotlin metadata + coroutines
# -----------------------------------------------------------------
-keep class kotlin.Metadata { *; }
-keepclassmembers class kotlin.Metadata {
    public <methods>;
}
-dontwarn kotlinx.coroutines.**

# -----------------------------------------------------------------
# ZXing - QR scanning library (com.journeyapps:zxing-android-embedded)
# -----------------------------------------------------------------
-keep class com.journeyapps.barcodescanner.** { *; }
-keep class com.google.zxing.** { *; }
-dontwarn com.google.zxing.**

# -----------------------------------------------------------------
# Guava ListenableFuture stub (PermissionChecker auto-revoke flow)
# -----------------------------------------------------------------
-dontwarn com.google.common.util.concurrent.**

# -----------------------------------------------------------------
# AndroidX core + appcompat - reflection-instantiated views
# -----------------------------------------------------------------
-keep class androidx.core.app.** { *; }
-keep class androidx.appcompat.** { *; }
-keep class com.google.android.material.** { *; }
-dontwarn androidx.**

# -----------------------------------------------------------------
# App entry points referenced by AndroidManifest (must not be renamed)
# -----------------------------------------------------------------
-keep class com.dnkdialer.companion.MainActivity { *; }
-keep class com.dnkdialer.companion.SignInActivity { *; }
-keep class com.dnkdialer.companion.PhoneService { *; }
-keep class com.dnkdialer.companion.SmsReceiver { *; }
-keep class com.dnkdialer.companion.SmsStatusReceiver { *; }
-keep class com.dnkdialer.companion.ConnectionRequestReceiver { *; }
-keep class com.dnkdialer.companion.LobbyActionReceiver { *; }
-keep class com.dnkdialer.companion.DnkNotificationListenerService { *; }

# -----------------------------------------------------------------
# App data model + relay payload classes (Gson serialise/deserialise)
# -----------------------------------------------------------------
# The app builds payload maps inline (Gson().toJson(mapOf(...))) and
# parses inbound JSON to Map<String, Any>, so there are no dedicated
# DTO classes for R8 to mangle. Keep the whole companion package's
# enums + sealed classes (response wrappers etc.) defensively.
-keep enum com.dnkdialer.companion.** { *; }
-keep class com.dnkdialer.companion.**$* { *; }

# BuildConfig is referenced by PhoneService + SignInActivity for the
# BuildConfig.DEBUG-gated PII log statements. Keep the field.
-keep class com.dnkdialer.companion.BuildConfig { *; }
