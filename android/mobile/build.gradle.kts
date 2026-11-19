import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
}

val mobileSigningFile = rootProject.file("mobile-signing.properties")
val mobileSigning = Properties().apply {
    if (mobileSigningFile.exists()) mobileSigningFile.inputStream().use { load(it) }
}

val mobileAccessFile = rootProject.file("mobile-access.properties")
val mobileAccess = Properties().apply {
    if (mobileAccessFile.exists()) mobileAccessFile.reader(Charsets.UTF_8).use { load(it) }
}

fun javaStringLiteral(value: String): String = buildString {
    append('"')
    for (character in value) when (character) {
        '\\' -> append("\\\\")
        '"' -> append("\\\"")
        '\n' -> append("\\n")
        '\r' -> append("\\r")
        '\t' -> append("\\t")
        '\b' -> append("\\b")
        '\u000c' -> append("\\f")
        else -> if (character.code < 32 || character.code == 127) append("\\%03o".format(character.code))
            else append(character)
    }
    append('"')
}

android {
    namespace = "com.eddy.mobile"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.eddy.mobile"
        minSdk = 24
        targetSdk = 36
        versionCode = 6
        versionName = "1.3.2"
        buildConfigField("String", "MOBILE_TABLET_ADDRESS", javaStringLiteral(mobileAccess.getProperty("tabletAddress", "")))
        buildConfigField("String", "MOBILE_USER", javaStringLiteral(mobileAccess.getProperty("user", "")))
        buildConfigField("String", "MOBILE_PASSWORD", javaStringLiteral(mobileAccess.getProperty("password", "")))
    }

    signingConfigs {
        if (mobileSigningFile.exists()) create("privateRelease") {
            storeFile = file(mobileSigning.getProperty("storeFile"))
            storePassword = mobileSigning.getProperty("storePassword")
            keyAlias = mobileSigning.getProperty("keyAlias")
            keyPassword = mobileSigning.getProperty("keyPassword")
        }
    }
    buildTypes {
        release {
            isDebuggable = false
            if (mobileSigningFile.exists()) signingConfig = signingConfigs.getByName("privateRelease")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    buildFeatures { buildConfig = true }
}

dependencies {
    implementation(files("libs/eddy-tunnel.aar"))
    implementation("com.google.zxing:core:3.5.3")
    implementation(libs.androidx.activity)
    implementation(libs.androidx.core)
}
