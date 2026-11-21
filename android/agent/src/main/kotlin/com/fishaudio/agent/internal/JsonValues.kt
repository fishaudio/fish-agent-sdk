package com.fishaudio.agent.internal

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

/**
 * JSON without reflection. Wire field names are string literals in this
 * module, so a minifier (R8) has nothing to rename, and plain Kotlin values
 * are the only JSON types the public API shows.
 */
internal object JsonValues {
    /** The text as a JSON object, or null when it is not one. */
    fun parseObject(text: String): JsonObject? =
        try {
            Json.parseToJsonElement(text) as? JsonObject
        } catch (_: Exception) {
            null
        }

    /**
     * A plain Kotlin value as JSON.
     *
     * @throws IllegalArgumentException for a value JSON cannot hold: an
     * unsupported type, a map key that is not a string, NaN or an infinity.
     */
    fun toElement(value: Any?): JsonElement = when (value) {
        null -> JsonNull
        is JsonElement -> value
        is String -> JsonPrimitive(value)
        is Boolean -> JsonPrimitive(value)
        is Double -> JsonPrimitive(finite(value))
        is Float -> JsonPrimitive(finite(value.toDouble()))
        is Number -> JsonPrimitive(value)
        is Char -> JsonPrimitive(value.toString())
        is Map<*, *> -> JsonObject(
            value.entries.associate { (key, item) ->
                val name = key as? String
                    ?: throw IllegalArgumentException("JSON object keys must be strings, got ${describe(key)}")
                name to toElement(item)
            },
        )
        is Iterable<*> -> JsonArray(value.map(::toElement))
        is Array<*> -> JsonArray(value.map(::toElement))
        else -> throw IllegalArgumentException("${describe(value)} cannot be sent as JSON")
    }

    /** JSON as plain Kotlin values: maps, lists, strings, booleans, `Long` or `Double`, and null. */
    fun fromElement(element: JsonElement): Any? = when (element) {
        is JsonNull -> null
        is JsonPrimitive ->
            if (element.isString) {
                element.content
            } else {
                element.booleanOrNull ?: element.longOrNull ?: element.doubleOrNull ?: element.content
            }
        is JsonObject -> fromObject(element)
        is JsonArray -> element.map(::fromElement)
    }

    fun fromObject(element: JsonObject): Map<String, Any?> = element.mapValues { fromElement(it.value) }

    fun encode(element: JsonElement): String = element.toString()

    private fun finite(value: Double): Double {
        require(value.isFinite()) { "$value cannot be sent as JSON" }
        return value
    }

    private fun describe(value: Any?): String = value?.let { it::class.java.name } ?: "null"
}

/** The string under [key], or null when it is missing or not a string. */
internal fun JsonObject.string(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

/** The boolean under [key], or null when it is missing or not a JSON boolean (`"true"` does not count). */
internal fun JsonObject.boolean(key: String): Boolean? =
    (this[key] as? JsonPrimitive)?.takeUnless { it.isString || it is JsonNull }?.booleanOrNull

/** The number under [key], or null when it is missing or not a JSON number (`"30"` does not count). */
internal fun JsonObject.number(key: String): Double? =
    (this[key] as? JsonPrimitive)?.takeUnless { it.isString || it is JsonNull }?.doubleOrNull
