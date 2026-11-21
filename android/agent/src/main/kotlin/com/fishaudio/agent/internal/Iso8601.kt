package com.fishaudio.agent.internal

import java.util.GregorianCalendar
import java.util.TimeZone

/**
 * Reads the `expires_at` of a session token. `java.time` needs API 26 and this
 * library supports 24, so the one format the API uses is parsed by hand:
 * `2026-11-21T04:47:21Z`, with optional fractional seconds and a `Z` or
 * `+08:00` style offset.
 */
internal object Iso8601 {
    private val PATTERN = Regex(
        """^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([Zz])|([+-])(\d{2}):?(\d{2}))$""",
    )

    /** Epoch milliseconds, or null when the text is not in the format above. */
    fun parseEpochMs(text: String): Long? {
        val match = PATTERN.matchEntire(text.trim()) ?: return null
        val groups = match.groupValues
        val (year, month, day) = Triple(groups[1], groups[2], groups[3])
        val (hour, minute, second) = Triple(groups[4], groups[5], groups[6])
        val fraction = groups[7]
        // groups[8] is the literal Z; groups[9..11] are a numeric offset.
        val (sign, offsetHours, offsetMinutes) = Triple(groups[9], groups[10], groups[11])
        val calendar = GregorianCalendar(TimeZone.getTimeZone("UTC"))
        calendar.isLenient = false
        calendar.clear()
        return try {
            calendar.set(year.toInt(), month.toInt() - 1, day.toInt(), hour.toInt(), minute.toInt(), second.toInt())
            val millis = if (fraction.isEmpty()) 0 else fraction.padEnd(3, '0').substring(0, 3).toInt()
            val offsetMs = if (sign.isEmpty()) {
                0L
            } else {
                (offsetHours.toLong() * 60 + offsetMinutes.toLong()) * 60_000 * (if (sign == "-") -1 else 1)
            }
            calendar.timeInMillis + millis - offsetMs
        } catch (_: IllegalArgumentException) {
            // A date that does not exist, such as month 13.
            null
        }
    }
}
