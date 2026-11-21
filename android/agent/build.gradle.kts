import groovy.json.JsonSlurper

plugins {
    alias(libs.plugins.android.library)
    `maven-publish`
    signing
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

    publishing {
        singleVariant("release") {
            withSourcesJar()
        }
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
    // -PlivekitVersion=… builds against another LiveKit release (the weekly CI job uses it).
    implementation(providers.gradleProperty("livekitVersion").map { "io.livekit:livekit-android:$it" }.orElse(libs.livekit.map { it.toString() }))

    testImplementation(libs.junit)
    testImplementation(libs.coroutines.test)
}

// Publishing to Maven Central. See RELEASING.md at the repository root.
//
// `./gradlew :agent:publishReleasePublicationToStagingRepository` writes the
// artifacts to build/staging-repo, in the layout Maven Central takes as a
// bundle. Nothing leaves the machine until that bundle is uploaded.
publishing {
    publications {
        register<MavenPublication>("release") {
            artifactId = "agent-android"
            afterEvaluate { from(components["release"]) }
            pom {
                name.set("Fish Agent Android SDK")
                description.set("Voice calls with a Fish Audio agent in a native Android app.")
                url.set("https://docs.fish.audio/agents/deploy/android")
                licenses {
                    license {
                        name.set("MIT License")
                        url.set("https://opensource.org/licenses/MIT")
                    }
                }
                developers {
                    developer {
                        name.set("Fish Audio")
                        url.set("https://fish.audio")
                    }
                }
                scm {
                    url.set("https://github.com/fishaudio/fish-agent-sdk")
                    connection.set("scm:git:https://github.com/fishaudio/fish-agent-sdk.git")
                }
            }
        }
    }
    repositories {
        maven {
            name = "staging"
            url = uri(layout.buildDirectory.dir("staging-repo"))
        }
    }
}

signing {
    // Maven Central requires signatures. A build without a key (CI, a local
    // check) still publishes to the staging directory, unsigned.
    val key = providers.gradleProperty("signingInMemoryKey").orNull
    isRequired = key != null
    if (key != null) {
        useInMemoryPgpKeys(key, providers.gradleProperty("signingInMemoryKeyPassword").orNull)
        sign(publishing.publications["release"])
    }
}
