package com.fishaudio.agent.example

import android.content.Intent
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import com.fishaudio.agent.AudioOutputRoute
import com.fishaudio.agent.CallNotification
import com.fishaudio.agent.ChatMessage
import com.fishaudio.agent.ClientToolHandler
import com.fishaudio.agent.Conversation
import com.fishaudio.agent.ConversationEvent
import com.fishaudio.agent.ConversationStartCancelledException
import com.fishaudio.agent.ConversationStatus
import com.fishaudio.agent.FishAgentError
import com.fishaudio.agent.FishAgentPermissions
import com.fishaudio.agent.MessageRole
import com.fishaudio.agent.MobileOptions
import com.fishaudio.agent.SessionAuth
import com.fishaudio.agent.SessionOptions
import com.fishaudio.agent.SessionToken
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * One screen: start a call, talk or type, hang up.
 *
 * The app never holds the Fish API key. It asks a backend of yours for a
 * session token (see the README) and hands the response to the SDK as it is.
 */
class MainActivity : ComponentActivity() {
    private lateinit var conversation: Conversation

    private lateinit var statusView: TextView
    private lateinit var errorView: TextView
    private lateinit var messagesView: TextView
    private lateinit var scrollView: ScrollView
    private lateinit var callButton: Button
    private lateinit var muteButton: Button
    private lateinit var routeButton: Button
    private lateinit var input: EditText

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // One Conversation for the screen. In an app with more screens, keep it
        // in a ViewModel or another holder that outlives the Activity.
        conversation = Conversation(
            context = this,
            defaults = SessionOptions(
                // Tools the agent can call in the app. Configure a client tool
                // with the same name on the agent for it to be used.
                clientTools = mapOf(
                    "get_device_info" to ClientToolHandler { _, _ ->
                        mapOf(
                            "manufacturer" to Build.MANUFACTURER,
                            "model" to Build.MODEL,
                            "androidVersion" to Build.VERSION.RELEASE,
                            "sdk" to Build.VERSION.SDK_INT,
                        )
                    },
                ),
            ),
            mobile = MobileOptions(callNotification = CallNotification(title = "Fish Agent call in progress")),
        )
        setContentView(buildLayout())
        observe()
        handleAutomation(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleAutomation(intent)
    }

    override fun onDestroy() {
        // Ends the call if one is running, and stops the call service.
        conversation.close()
        super.onDestroy()
    }

    // ---- the call ----

    private fun startCall(microphone: Boolean = true) {
        lifecycleScope.launch {
            showError(null)
            try {
                // The SDK does not ask for the microphone permission itself.
                if (microphone && !FishAgentPermissions.requestMicrophonePermission(this@MainActivity)) {
                    showError("The microphone permission is needed for a voice call.")
                    return@launch
                }
                val token = fetchSessionToken()
                conversation.startSession(SessionAuth.Token(token)) { it.copy(microphone = microphone) }
            } catch (_: ConversationStartCancelledException) {
                // Hung up while the call was starting. Nothing to show.
            } catch (error: FishAgentError) {
                showError("${error.code.wireValue}: ${error.message}")
            } catch (error: Exception) {
                showError(error.message ?: error.toString())
            }
        }
    }

    /**
     * A public agent needs no backend: the SDK creates the session itself from
     * the agent's ID. Anyone with the ID can do the same, so prefer a backend
     * for an app with signed-in users. [origin] is only for an agent that
     * restricts origins.
     */
    private fun startPublicCall(agentId: String, serverUrl: String? = null, origin: String? = null) {
        lifecycleScope.launch {
            showError(null)
            try {
                if (!FishAgentPermissions.requestMicrophonePermission(this@MainActivity)) {
                    showError("The microphone permission is needed for a voice call.")
                    return@launch
                }
                conversation.startSession(SessionAuth.AgentId(agentId)) { it.copy(serverUrl = serverUrl, origin = origin) }
            } catch (_: ConversationStartCancelledException) {
            } catch (error: FishAgentError) {
                showError("${error.code.wireValue}: ${error.message}")
            }
        }
    }

    private fun endCall() {
        lifecycleScope.launch {
            try {
                conversation.endSession()
            } catch (error: Exception) {
                showError(error.message ?: error.toString())
            }
        }
    }

    private fun setMuted(muted: Boolean) {
        lifecycleScope.launch {
            try {
                if (!muted && !FishAgentPermissions.requestMicrophonePermission(this@MainActivity)) {
                    showError("The microphone permission is needed to unmute.")
                    return@launch
                }
                conversation.setMicMuted(muted)
            } catch (error: FishAgentError) {
                showError("${error.code.wireValue}: ${error.message}")
            }
        }
    }

    /** Your backend creates the session with your API key and returns the response unchanged. */
    private suspend fun fetchSessionToken(): SessionToken = withContext(Dispatchers.IO) {
        val connection = URL(BuildConfig.TOKEN_URL).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "POST"
            connection.connectTimeout = 10_000
            connection.readTimeout = 20_000
            connection.setRequestProperty("Content-Type", "application/json")
            connection.doOutput = true
            connection.outputStream.use { it.write("{}".toByteArray()) }
            val status = connection.responseCode
            val body = (if (status in 200..299) connection.inputStream else connection.errorStream)
                ?.bufferedReader()?.use { it.readText() }.orEmpty()
            check(status in 200..299) { "The token backend answered HTTP $status: $body" }
            SessionToken.fromJson(body)
        } finally {
            connection.disconnect()
        }
    }

    // ---- state to screen ----

    private fun observe() {
        lifecycleScope.launch {
            combine(
                conversation.status,
                conversation.mode,
                conversation.micMuted,
                conversation.audioOutput,
                conversation.endReason,
            ) { status, mode, muted, route, endReason ->
                val live = status == ConversationStatus.CONNECTED || status == ConversationStatus.RECONNECTING
                val calling = live || status == ConversationStatus.CONNECTING
                callButton.text = if (calling) "Hang up" else "Start call"
                muteButton.isEnabled = live
                muteButton.text = if (muted) "Unmute" else "Mute"
                routeButton.text = "Audio: ${route.name.lowercase()}"
                statusView.text = buildString {
                    append(status.name.lowercase())
                    if (live) append(" · agent ${mode.name.lowercase()}")
                    endReason?.let { append(" · ${it.wireValue}") }
                }
                log("state", "status" to status.name, "mode" to mode.name, "muted" to muted, "route" to route.name, "endReason" to endReason?.wireValue)
            }.collect {}
        }
        lifecycleScope.launch {
            conversation.messages.collect { messages ->
                messagesView.text = messages.joinToString("\n\n") { it.render() }
                scrollView.post { scrollView.fullScroll(View.FOCUS_DOWN) }
            }
        }
        lifecycleScope.launch {
            conversation.events.collect { event ->
                when (event) {
                    // A failure that does not end the call. The end of a call arrives as Disconnect.
                    is ConversationEvent.Error ->
                        if (event.error.recovered != true) showError("${event.error.code.wireValue}: ${event.error.message}")
                    is ConversationEvent.Message -> log("message", "role" to event.role.name, "text" to event.text)
                    is ConversationEvent.ToolCallStarted -> log("tool.started", "tool" to event.toolName, "source" to event.source.value)
                    is ConversationEvent.ToolCallCompleted -> log("tool.completed", "tool" to event.toolName, "output" to event.output)
                    is ConversationEvent.ToolCallFailed -> log("tool.failed", "tool" to event.toolName, "error" to event.error)
                    is ConversationEvent.Connect -> log("connect", "sessionId" to event.sessionId)
                    is ConversationEvent.Disconnect -> log("disconnect", "reason" to event.reason.wireValue)
                    else -> Unit
                }
                if (event is ConversationEvent.Error) log("error", "code" to event.error.code.wireValue, "recovered" to event.error.recovered)
            }
        }
    }

    private fun ChatMessage.render(): String {
        val who = if (role == MessageRole.USER) "You" else "Agent"
        return "$who: $text${if (isFinal) "" else " …"}"
    }

    private fun showError(message: String?) {
        errorView.text = message.orEmpty()
        errorView.visibility = if (message == null) View.GONE else View.VISIBLE
        if (message != null) log("shown-error", "message" to message)
    }

    // ---- layout ----

    private fun buildLayout(): View {
        val padding = (16 * resources.displayMetrics.density).toInt()
        statusView = TextView(this).apply {
            textSize = 16f
            setTypeface(typeface, Typeface.BOLD)
        }
        errorView = TextView(this).apply {
            setTextColor(0xFFB3261E.toInt())
            visibility = View.GONE
        }
        messagesView = TextView(this).apply { textSize = 15f }
        scrollView = ScrollView(this).apply { addView(messagesView) }
        callButton = Button(this).apply {
            setOnClickListener {
                when (conversation.status.value) {
                    ConversationStatus.CONNECTING, ConversationStatus.CONNECTED, ConversationStatus.RECONNECTING -> endCall()
                    else -> startCall()
                }
            }
        }
        muteButton = Button(this).apply { setOnClickListener { setMuted(!conversation.micMuted.value) } }
        routeButton = Button(this).apply {
            setOnClickListener {
                val routes = AudioOutputRoute.entries
                conversation.setAudioOutput(routes[(conversation.audioOutput.value.ordinal + 1) % routes.size])
            }
        }
        input = EditText(this).apply { hint = "Type a message" }
        val send = Button(this).apply {
            text = "Send"
            setOnClickListener {
                conversation.sendUserMessage(input.text.toString())
                input.text.clear()
            }
        }
        val buttons = LinearLayout(this).apply {
            addView(callButton)
            addView(muteButton)
            addView(routeButton)
        }
        val composer = LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            addView(input, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
            addView(send)
        }
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(padding, padding * 3, padding, padding)
            addView(statusView)
            addView(errorView)
            addView(buttons)
            addView(scrollView, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
            addView(composer)
        }
    }

    // ---- scripted checks ----

    /** One JSON-like line per state change and event, for reading with `adb logcat -s FishExample`. */
    private fun log(what: String, vararg fields: Pair<String, Any?>) {
        Log.i("FishExample", "$what " + fields.joinToString(" ") { (key, value) -> "$key=$value" })
    }

    /**
     * Lets `adb` drive the app, so a call can be checked without touching the
     * screen (see the README):
     *
     *     adb shell am start -n com.fishaudio.agent.example/.MainActivity --es cmd start
     *
     * Only in builds made with automation on (debug builds by default).
     */
    private fun handleAutomation(intent: Intent?) {
        if (!BuildConfig.AUTOMATION) return
        val command = intent?.getStringExtra("cmd") ?: return
        log("cmd", "cmd" to command, "text" to intent.getStringExtra("text"))
        when (command) {
            "start" -> startCall()
            "start-text" -> startCall(microphone = false)
            // text is "agentId|serverUrl|origin"; the last two are optional.
            "start-public" -> intent.getStringExtra("text").orEmpty().split("|").let { parts ->
                startPublicCall(parts[0], parts.getOrNull(1)?.ifEmpty { null }, parts.getOrNull(2)?.ifEmpty { null })
            }
            "hangup" -> endCall()
            "mute" -> setMuted(true)
            "unmute" -> setMuted(false)
            "msg" -> conversation.sendUserMessage(intent.getStringExtra("text").orEmpty())
            "interrupt" -> conversation.interrupt()
            "route" -> conversation.setAudioOutput(AudioOutputRoute.valueOf(intent.getStringExtra("text").orEmpty().uppercase()))
        }
    }
}
