package com.fishaudio.agent

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

class VersionTest {
    /** The Gradle build takes the version from android/package.json; this checks it reached the code. */
    @Test
    fun versionMatchesTheMarkerPackage() {
        val manifest = File(checkNotNull(System.getProperty("fishAgent.markerPackage"))).readText()
        val declared = Regex("\"version\"\\s*:\\s*\"([^\"]+)\"").find(manifest)?.groupValues?.get(1)
        assertNotNull(declared)
        assertEquals(declared, FishAgentSdk.VERSION)
    }
}
