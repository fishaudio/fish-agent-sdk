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
        // android.util.Log is a stub on the JVM; let it return defaults instead of throwing.
        unitTests.isReturnDefaultValues = true
        unitTests.all {
            // Tests read android/package.json to check the version.
            it.systemProperty("fishAgent.markerPackage", rootProject.file("package.json").path)
            // The conformance fixtures shared with the other SDKs.
            it.systemProperty(
                "fishAgent.fixtures",
                rootProject.file("../packages/protocol/fixtures").path,
            )
            it.inputs.dir(rootProject.file("../packages/protocol/fixtures"))
        }
    }
}

kotlin {
    // Every public declaration must say so: nothing becomes API by accident.
    explicitApi()
}

dependencies {
    // Flows and ComponentActivity (the permission helper) are part of the public API.
    api(libs.coroutines.core)
    api(libs.androidx.activity)
    implementation(libs.coroutines.android)
    // Never in the public API: apps must not need these libraries to call the SDK,
    // and can move LiveKit to a newer 2.x themselves.
    implementation(libs.serialization.json)
    implementation(libs.livekit)

    testImplementation(libs.junit)
    testImplementation(libs.coroutines.test)
}
