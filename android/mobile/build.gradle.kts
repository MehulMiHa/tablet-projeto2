plugins {
    alias(libs.plugins.android.application)
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

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
}

dependencies {
    implementation(libs.androidx.activity)
    implementation(libs.androidx.core)
}
