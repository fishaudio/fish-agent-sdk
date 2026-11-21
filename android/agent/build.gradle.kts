import groovy.json.JsonSlurper

plugins {
    alias(libs.plugins.android.library)
}

// The version lives in android/package.json so it is bumped together with the
// JavaScript packages (see .changeset/config.json).
val sdkVersion: String =
    (JsonSlurper().parse(rootProject.file("package.json")) as Map<*, *>)["version"] as String

group = "com.fishaudio.agent"
version = sdkVersion

android {
    namespace = "com.fishaudio.agent"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
        buildConfigField("String", "SDK_VERSION", "\"$sdkVersion\"")
        consumerProguardFiles("consumer-rules.pro")
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        unitTests.all {
            // Tests read android/package.json to check the version.
            it.systemProperty("fishAgent.markerPackage", rootProject.file("package.json").path)
        }
    }
}

dependencies {
    testImplementation(libs.junit)
}
