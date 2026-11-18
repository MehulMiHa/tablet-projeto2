import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
}

val mobileSigningFile = rootProject.file("mobile-signing.properties")
val mobileSigning = Properties().apply {
    if (mobileSigningFile.exists()) mobileSigningFile.inputStream().use { load(it) }
}

android {
    namespace = "com.eddy.mobile"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.eddy.mobile"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"
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
}

dependencies {
    implementation(libs.androidx.activity)
    implementation(libs.androidx.core)
}
