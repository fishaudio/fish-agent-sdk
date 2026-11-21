package com.fishaudio.agent

/** How a call gets its session. */
public sealed interface SessionAuth {
    /**
     * A session token your backend created with your API key. The recommended
     * way for apps: your backend decides who may call, and no key ships in the app.
     */
    public class Token(public val sessionToken: SessionToken) : SessionAuth

    /**
     * A public agent, by its ID. The SDK creates the session itself, without a
     * key. Anyone with the ID can start sessions, billed to the agent's owner.
     */
    public class AgentId(public val agentId: String) : SessionAuth
}

/** Per-session switches for what the platform tells the agent on its own. */
public data class SessionContext(
    /**
     * Whether the agent knows the current date and time. `false` withholds
     * them, `true` gives them even when the agent has them off, `null` follows the agent.
     */
    val currentTime: Boolean? = null,
)

/**
 * Per-session replacements for the agent's configuration. Each field must be
 * allowed on the agent. A public agent accepts only [language] and [voiceId].
 */
public data class SessionOverrides(
    /** The opening line, word for word. Use this or [firstMessagePrompt], not both. */
    val firstMessage: String? = null,
    /** Instructions the agent writes its opening line from. */
    val firstMessagePrompt: String? = null,
    val systemPrompt: String? = null,
    /** The voice. Voices lean toward their own language, so pair it with [language]. */
    val voiceId: String? = null,
    /** ISO 639-1 code, for example `"ja"`. */
    val language: String? = null,
    /** Speech recognition model, for example `"deepgram:nova-3"`. API-key sessions only. */
    val asrModel: String? = null,
)

/** What a client tool is told about the call it is answering. */
public class ClientToolContext(public val callId: String, public val toolName: String)

/**
 * A tool the agent can call in the app.
 *
 * [params] are the arguments as plain Kotlin values: `Map<String, Any?>`,
 * `List<Any?>`, `String`, `Boolean`, `Long` or `Double`, and `null`.
 *
 * Return the result as the same kinds of values, or `null` for no result.
 * Throw to report a failure to the agent. A result that is too large to send
 * (about 60 KB as JSON) is replaced by an error.
 *
 * Handlers run on the main thread. Move slow work to another dispatcher. The
 * agent stops waiting after its own timeout; the handler is then cancelled.
 */
public fun interface ClientToolHandler {
    public suspend fun invoke(params: Map<String, Any?>, context: ClientToolContext): Any?
}

/**
 * Options for a call. With [SessionAuth.Token] only [clientTools],
 * [clientToolTimeoutMs] and [microphone] apply: your backend chose the rest
 * when it created the session.
 */
public data class SessionOptions(
    /**
     * Experimental. The origin to present for a public agent that restricts
     * origins, for example `"https://www.example.com"`. An app sends no origin
     * by itself, so such an agent refuses it without this. Use an origin you
     * own from the agent's list. May change or be removed in a minor release.
     */
    val origin: String? = null,
    /** The Fish API base URL. Leave unset outside of testing. */
    val serverUrl: String? = null,
    /** Short for [SessionOverrides.language]. An explicit override wins. */
    val language: String? = null,
    /** IANA timezone for the agent's sense of local time. Unset: the device's timezone is sent as a hint. */
    val timezone: String? = null,
    val context: SessionContext? = null,
    val overrides: SessionOverrides? = null,
    /** `{{name}}` values for the agent's prompt and first message: strings, numbers and booleans. */
    val dynamicVariables: Map<String, Any>? = null,
    /** Your identifier for the person calling, kept on the session record. */
    val endUserId: String? = null,
    /** Your own tags, stored and returned as they are. The platform never reads them. */
    val metadata: Map<String, Any?>? = null,
    /** Whether tool call events are sent to this app. `null` follows the default (on). */
    val toolEvents: Boolean? = null,
    val clientTools: Map<String, ClientToolHandler> = emptyMap(),
    /** How long a client tool gets when the agent does not say. The agent's own timeout wins. */
    val clientToolTimeoutMs: Long = 15_000,
    /**
     * Capture the microphone when the call starts. `false` joins without it
     * (for text-first screens); unmuting later starts the capture.
     */
    val microphone: Boolean = true,
)
