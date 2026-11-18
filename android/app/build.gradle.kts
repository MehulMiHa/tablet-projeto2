plugins {
    alias(libs.plugins.android.application)
}

android {
    namespace = "com.example.tabletprojeto2"
    compileSdk {
        version = release(36) {
            minorApiLevel = 1
        }
    }

    defaultConfig {
        applicationId = "com.example.tabletprojeto2"
        minSdk = 24
        targetSdk = 36
        versionCode = 7
        versionName = "2.5.0"

    }

    buildTypes {
        release {
            optimization {
                enable = false
            }
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    buildFeatures {
        buildConfig = true
    }
}

abstract class BundlePanelAssets @javax.inject.Inject constructor(
    private val fileOperations: FileSystemOperations
) : DefaultTask() {
    @get:InputFile
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val panelHtml: RegularFileProperty

    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val webAssets: DirectoryProperty

    @get:OutputDirectory
    abstract val outputDirectory: DirectoryProperty

    @TaskAction
    fun bundle() {
        fileOperations.sync {
            from(panelHtml) { into("web") }
            from(webAssets) { into("web/assets") }
            into(outputDirectory)
        }
    }
}

androidComponents.onVariants { variant ->
    val panelRoot = rootProject.layout.projectDirectory.dir("..")
    val bundlePanelAssets = tasks.register<BundlePanelAssets>(
        "bundle${variant.name.replaceFirstChar { it.uppercaseChar() }}PanelAssets"
    ) {
        panelHtml.set(panelRoot.file("index.html"))
        webAssets.set(panelRoot.dir("assets"))
    }
    variant.sources.assets?.addGeneratedSourceDirectory(bundlePanelAssets, BundlePanelAssets::outputDirectory)
}

dependencies {
    implementation(libs.androidx.activity)
    implementation(libs.androidx.core)
}
