package dev.agentremote.agent_remote

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import org.json.JSONObject
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit

/** Keeps CloudCLI's notification socket alive independently of the Flutter WebView. */
class CloudCliNotificationService : Service() {
    companion object {
        // Bumped ids so Android re-applies the importance below on in-place
        // upgrades; notification channels are immutable once created.
        // v3: the persistent connection/progress and normal run messages are
        // silent (low importance, no heads-up); only completion/approval events
        // pop up.
        private const val CONNECTION_CHANNEL = "cloudcli_connection_v3"
        private const val EVENTS_CHANNEL = "cloudcli_events_v3"
        private const val ATTENTION_CHANNEL = "cloudcli_attention_v3"
        private val LEGACY_CHANNELS = listOf(
            "cloudcli_connection", "cloudcli_events", "cloudcli_attention",
            "cloudcli_connection_v2", "cloudcli_events_v2", "cloudcli_attention_v2"
        )

        /** Sent by MainActivity when the user opens a session inside the app. */
        const val ACTION_DISMISS_SESSION = "dev.agentremote.action.DISMISS_SESSION"

        /** Session whose posted notifications should be cancelled. */
        const val EXTRA_SESSION_ID = "session_id"
    }

    private data class NotificationChannelSpec(
        val id: String,
        val name: String,
        val importance: Int,
        val description: String
    )

    private data class TaskProgress(val provider: String, val title: String, val detail: String, val steps: Int) {
        val providerName: String
            get() = when (provider.lowercase()) {
                "claude" -> "Claude"
                "cursor" -> "Cursor"
                "codex" -> "Codex"
                "opencode" -> "OpenCode"
                else -> provider.ifBlank { "Agent" }
            }
    }

    private val handler = Handler(Looper.getMainLooper())
    private val client = OkHttpClient.Builder()
        .pingInterval(25, TimeUnit.SECONDS)
        .connectTimeout(10, TimeUnit.SECONDS)
        .build()
    private val manager by lazy { getSystemService(NOTIFICATION_SERVICE) as NotificationManager }
    private val store by lazy { SecureStore(this) }
    private var socket: WebSocket? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var attempts = 0
    private var connectionStatus = "正在连接 CloudCLI"
    private val runningTasks = linkedMapOf<String, TaskProgress>()
    /**
     * Notification ids already posted per session, so opening that session in
     * the app can clear whatever is still sitting in the shade.
     */
    private val sessionNotificationIds = linkedMapOf<String, MutableSet<Int>>()
    private var nextEventId = 100
    /** True once the service has entered the foreground state. */
    private var foreground = false
    @Volatile private var generation = 0
    private val refreshConnection = Runnable { connect() }
    private val channelSpecs = listOf(
        // The persistent task notification only sits in the shade: low
        // importance means no heads-up banner, no sound and no vibration.
        NotificationChannelSpec(
            CONNECTION_CHANNEL, "CloudCLI 后台连接",
            NotificationManager.IMPORTANCE_LOW,
            "在通知栏静默显示后台连接与 Agent 运行进度"
        ),
        NotificationChannelSpec(
            EVENTS_CHANNEL, "Agent 消息",
            NotificationManager.IMPORTANCE_LOW,
            "Agent 运行过程中的消息，静默挂在通知栏"
        ),
        // Completion / approval / question events actively pop up.
        NotificationChannelSpec(
            ATTENTION_CHANNEL, "任务完成与审批",
            NotificationManager.IMPORTANCE_HIGH,
            "任务完成、审批和提问提醒，会主动弹出通知"
        )
    )

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        if (Build.VERSION.SDK_INT >= 26) {
            LEGACY_CHANNELS.forEach { manager.deleteNotificationChannel(it) }
            channelSpecs.forEach { spec ->
                if (manager.getNotificationChannel(spec.id) == null) {
                    manager.createNotificationChannel(
                        NotificationChannel(spec.id, spec.name, spec.importance).apply {
                            description = spec.description
                            // Low-importance channels stay silent in the shade;
                            // only the attention channel alerts.
                            val alerts = spec.importance >= NotificationManager.IMPORTANCE_HIGH
                            enableVibration(alerts)
                            setShowBadge(alerts)
                            if (alerts) enableLights(true)
                        }
                    )
                }
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (store.read("enabled") != "true") {
            stopSelf()
            return START_NOT_STICKY
        }
        if (intent?.action == ACTION_DISMISS_SESSION) {
            // The user opened a session manually; the notifications that used to
            // point at it are no longer actionable. (A notification tap cancels
            // its own entry via setAutoCancel, this path covers the rest.)
            cancelSessionNotifications(intent.getStringExtra(EXTRA_SESSION_ID))
            if (!foreground) stopSelf()
            return START_STICKY
        }
        val notification = connectionNotification("正在连接 CloudCLI")
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(1, notification)
        }
        foreground = true
        if (wakeLock?.isHeld != true) {
            val power = getSystemService(POWER_SERVICE) as PowerManager
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:cloudcli")
                .apply { setReferenceCounted(false); acquire() }
        }
        connect()
        return START_STICKY
    }

    private fun connectionNotification(message: String): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CONNECTION_CHANNEL)
            else Notification.Builder(this)
        val latest = runningTasks.values.lastOrNull()
        val agents = runningTasks.values.map { it.providerName }.distinct()
        val title = when (runningTasks.size) {
            0 -> "CloudCLI 远程"
            1 -> "${latest!!.providerName} 正在处理"
            else -> "${agents.joinToString("、")} 正在处理 ${runningTasks.size} 项任务"
        }
        // Always name the conversation being processed, not just the phase, so
        // the shade entry answers "which task?" at a glance.
        val content = if (latest == null) message else "${latest.title} · ${latest.detail}"
        builder
            .setSmallIcon(android.R.drawable.stat_notify_more)
            .setContentTitle(title)
            .setContentText(content)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_STATUS)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
        if (Build.VERSION.SDK_INT < 26) builder.setPriority(Notification.PRIORITY_LOW)
        if (latest != null) {
            builder.setProgress(0, 0, true)
            if (latest.steps > 0) builder.setSubText("已执行 ${latest.steps} 步")
        }
        return builder.build()
    }

    private fun status(message: String) {
        handler.post {
            connectionStatus = message
            updateConnectionNotification()
        }
    }

    private fun updateConnectionNotification() {
        manager.notify(1, connectionNotification(connectionStatus))
    }

    private fun readProgress(payload: JSONObject): Pair<String, TaskProgress>? {
        val sessionId = payload.optString("sessionId")
        if (sessionId.isBlank()) return null
        return sessionId to TaskProgress(
            payload.optString("provider"),
            payload.optString("title").ifBlank { "Agent 任务" },
            payload.optString("detail").ifBlank { "正在处理任务" },
            payload.optInt("steps").coerceAtLeast(0)
        )
    }

    private fun updateProgress(payload: JSONObject) {
        val (sessionId, progress) = readProgress(payload) ?: return
        if (payload.optString("state") == "finished") runningTasks.remove(sessionId)
        else {
            runningTasks.remove(sessionId)
            runningTasks[sessionId] = progress
        }
        updateConnectionNotification()
    }

    private fun syncProgress(payload: org.json.JSONArray) {
        runningTasks.clear()
        for (index in 0 until payload.length()) {
            val entry = payload.optJSONObject(index) ?: continue
            val (sessionId, progress) = readProgress(entry) ?: continue
            if (entry.optString("state") == "running") runningTasks[sessionId] = progress
        }
        updateConnectionNotification()
    }

    private fun connect() {
        if (store.read("enabled") != "true") return
        handler.removeCallbacks(refreshConnection)
        val current = ++generation
        socket?.close(1000, "Reconnecting")
        socket = null
        val base = store.read("url")?.trimEnd('/') ?: return
        val token = store.read("token") ?: return
        val deviceId = store.read("device_id") ?: UUID.randomUUID().toString().also {
            store.write("device_id", it)
        }
        val registration = JSONObject()
            .put("channel", "desktop")
            .put("endpointId", deviceId)
            .put("label", "CloudCLI 安卓基座")
            .put("metadata", JSONObject().put("platform", "android"))
            .put("enabled", true)
        val request = Request.Builder()
            .url("$base/api/notifications/endpoints/current")
            .header("Authorization", "Bearer $token")
            .post(registration.toString().toRequestBody("application/json".toMediaType()))
            .build()
        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, error: IOException) {
                if (current == generation) reconnect("连接中断，正在重试")
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    if (current != generation) return
                    if (!it.isSuccessful) {
                        reconnect(if (it.code == 401) "登录已失效，请打开应用重新登录" else "服务暂不可用，正在重试")
                        return
                    }
                    val refreshed = it.header("X-Refreshed-Token")
                    val activeToken = if (refreshed?.split('.')?.size == 3) {
                        store.write("token", refreshed)
                        refreshed
                    } else token
                    val wsBase = base.replaceFirst("https://", "wss://").replaceFirst("http://", "ws://")
                    val wsRequest = Request.Builder()
                        .url("$wsBase/desktop-notifications")
                        .header("Authorization", "Bearer $activeToken")
                        .build()
                    socket = client.newWebSocket(wsRequest, object : WebSocketListener() {
                        override fun onOpen(webSocket: WebSocket, response: Response) {
                            if (current != generation) return
                            webSocket.send(JSONObject()
                                .put("type", "register")
                                .put("deviceId", deviceId)
                                .put("label", "CloudCLI 安卓基座")
                                .put("platform", "android")
                                .toString())
                            attempts = 0
                            status("已连接，锁屏后继续接收 Agent 通知")
                            handler.postDelayed(refreshConnection, 12 * 60 * 60 * 1000L)
                        }

                        override fun onMessage(webSocket: WebSocket, text: String) {
                            if (current != generation) return
                            try {
                                val message = JSONObject(text)
                                when (message.optString("type")) {
                                    "notification" -> message.optJSONObject("payload")?.let { payload ->
                                        handler.post { showEvent(payload) }
                                    }
                                    "task_progress" -> message.optJSONObject("payload")?.let { payload ->
                                        handler.post { updateProgress(payload) }
                                    }
                                    "task_progress_sync" -> message.optJSONArray("payload")?.let { payload ->
                                        handler.post { syncProgress(payload) }
                                    }
                                }
                            } catch (_: Exception) {}
                        }

                        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                            if (current == generation) reconnect("连接中断，正在重试")
                        }

                        override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) {
                            if (current == generation) reconnect("连接中断，正在重试")
                        }
                    })
                }
            }
        })
    }

    private fun reconnect(message: String) {
        status(message)
        handler.removeCallbacks(refreshConnection)
        val delay = (2000L shl attempts.coerceAtMost(5)).coerceAtMost(60000L)
        attempts++
        handler.postDelayed(refreshConnection, delay)
    }

    private fun showEvent(payload: JSONObject) {
        val data = payload.optJSONObject("data")
        val sessionId = data?.optString("sessionId").orEmpty()
        if (sessionId.isNotBlank() &&
            store.read("app_foreground") == "true" &&
            store.read("visible_session_id") == sessionId
        ) return

        val code = data?.optString("code")
        // Questions and approvals are answered from the lock screen; only they
        // get the full-screen intent that wakes the screen.
        val actionRequired = code == "permission.required" || code == "agent.notification"
        val urgent = actionRequired || code == "run.stopped" ||
            code == "run.background_completed" || code == "run.failed"
        val notificationId = nextEventId++
        val provider = data?.optString("provider")?.takeUnless { it.isBlank() || it == "null" }.orEmpty()
        val openIntent = Intent(this, MainActivity::class.java).apply {
            if (sessionId.isNotBlank()) {
                putExtra(MainActivity.EXTRA_NOTIFICATION_SESSION_ID, sessionId)
                putExtra(MainActivity.EXTRA_NOTIFICATION_PROVIDER, provider)
                setData(
                    Uri.Builder()
                        .scheme("agentremote")
                        .authority("notification")
                        .appendPath(sessionId)
                        .appendQueryParameter("provider", provider)
                        .build()
                )
            }
        }
        val open = PendingIntent.getActivity(
            this, notificationId, openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(
            this, if (urgent) ATTENTION_CHANNEL else EVENTS_CHANNEL
        )
            else Notification.Builder(this)
        val notification = builder
            .setSmallIcon(android.R.drawable.stat_notify_more)
            .setContentTitle(payload.optString("title", "CloudCLI"))
            .setContentText(payload.optString("body", "有新的 Agent 消息"))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setOnlyAlertOnce(!urgent)
            .setCategory(if (urgent) Notification.CATEGORY_MESSAGE else Notification.CATEGORY_STATUS)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setPriority(if (urgent) Notification.PRIORITY_HIGH else Notification.PRIORITY_LOW)
            .apply {
                // On Android 13+ the system shows a heads-up instead while the
                // device is in use; on a locked screen this wakes it and shows
                // the question/approval. Android 14+ may require the user to
                // allow full-screen notifications for the app.
                if (urgent && actionRequired) setFullScreenIntent(open, true)
            }
            .build()
        manager.notify(notificationId, notification)
        if (sessionId.isNotBlank()) {
            recordSessionNotification(sessionId, notificationId)
        }
    }

    /** Remembers which notification ids belong to one session. */
    private fun recordSessionNotification(sessionId: String, notificationId: Int) {
        sessionNotificationIds.getOrPut(sessionId) { mutableSetOf() }.add(notificationId)
        // Old sessions can accumulate during a long run; the map only exists to
        // clear the shade later, so dropping the oldest group is enough.
        while (sessionNotificationIds.size > 50) {
            val oldest = sessionNotificationIds.keys.firstOrNull() ?: break
            sessionNotificationIds.remove(oldest)
        }
    }

    /** Cancels every posted notification that points at one session. */
    private fun cancelSessionNotifications(sessionId: String?) {
        if (sessionId.isNullOrBlank()) return
        val ids = sessionNotificationIds.remove(sessionId) ?: return
        ids.forEach { manager.cancel(it) }
    }

    override fun onDestroy() {
        generation++
        handler.removeCallbacksAndMessages(null)
        socket?.close(1000, "Service stopped")
        socket = null
        if (wakeLock?.isHeld == true) wakeLock?.release()
        client.dispatcher.executorService.shutdown()
        super.onDestroy()
    }
}
