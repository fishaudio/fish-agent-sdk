plugins {
    id("com.android.application")
}

// Where the app asks for a session token. 10.0.2.2 is the development machine
// as seen from the Android emulator; see the README for the token backend.
val tokenUrl = providers.gradleProperty("fishAgent.tokenUrl").orNull ?: "http://10.0.2.2:3001/agent-session"

// Lets `adb` drive the app for scripted checks (see the README). On in debug
// builds; pass -PfishAgent.automation=true to keep it in a release build.
val automationInRelease = providers.gradleProperty("fishAgent.automation").orNull == "true"

android {
    namespace = "com.fishaudio.agent.example"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.fishaudio.agent.example"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
        buildConfigField("String", "TOKEN_URL", "\"$tokenUrl\"")
        buildConfigField("boolean", "AUTOMATION", "true")
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            // Minified on purpose: the example doubles as the check that the
            // SDK survives R8 without extra rules.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
            // An example, not a store build: signed with the debug key so it installs.
            signingConfig = signingConfigs.getByName("debug")
            buildConfigField("boolean", "AUTOMATION", automationInRelease.toString())
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("com.fishaudio.agent:agent-android:1.1.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
}
