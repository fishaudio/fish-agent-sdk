pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // Needed by any app that uses the SDK: LiveKit, which the SDK is built
        // on, depends on a library that is only published on JitPack.
        maven("https://jitpack.io") {
            content { includeGroupByRegex("com\\.github\\..*") }
        }
    }
}

rootProject.name = "fish-agent-android-example"
include(":app")

// The example builds against the SDK in this repository. An app of your own
// leaves this block out and gets the SDK from Maven Central.
includeBuild("../../android") {
    dependencySubstitution {
        substitute(module("com.fishaudio.agent:agent-android")).using(project(":agent"))
    }
}
