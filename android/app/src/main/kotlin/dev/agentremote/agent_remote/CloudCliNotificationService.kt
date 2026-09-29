package dev.agentremote.agent_remote

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
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
    private var nextEventId = 100
    @Volatile private var generation = 0
    private val refreshConnection = Runnable { connect() }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(
                NotificationChannel("cloudcli_connection", "CloudCLI 后台连接", NotificationManager.IMPORTANCE_LOW)
            )
            manager.createNotificationChannel(
                NotificationChannel("cloudcli_events", "Agent 消息", NotificationManager.IMPORTANCE_DEFAULT)
            )
            manager.createNotificationChannel(
                NotificationChannel("cloudcli_attention", "任务完成与审批", NotificationManager.IMPORTANCE_HIGH)
            )
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (store.read("enabled") != "true") {
            stopSelf()
            return START_NOT_STICKY
        }
        val notification = connectionNotification("正在连接 CloudCLI")
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(1, notification)
        }
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
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, "cloudcli_connection")
            else Notification.Builder(this)
        val latest = runningTasks.values.lastOrNull()
        val agents = runningTasks.values.map { it.providerName }.distinct()
        val title = when (runningTasks.size) {
            0 -> "CloudCLI 远程"
            1 -> "${latest!!.providerName} 正在处理"
            else -> "${agents.joinToString("、")} 正在处理 ${runningTasks.size} 项任务"
        }
        val content = if (latest == null) message else if (runningTasks.size == 1) latest.detail
            else "${latest.title} · ${latest.detail}"
        builder
            .setSmallIcon(android.R.drawable.stat_notify_more)
            .setContentTitle(title)
            .setContentText(content)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
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
        val code = data?.optString("code")
        val urgent = code == "permission.required" || code == "agent.notification" || code == "run.stopped" ||
            code == "run.background_completed"
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(
            this, if (urgent) "cloudcli_attention" else "cloudcli_events"
        )
            else Notification.Builder(this)
        val notification = builder
            .setSmallIcon(android.R.drawable.stat_notify_more)
            .setContentTitle(payload.optString("title", "CloudCLI"))
            .setContentText(payload.optString("body", "有新的 Agent 消息"))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setPriority(if (urgent) Notification.PRIORITY_HIGH else Notification.PRIORITY_DEFAULT)
            .build()
        manager.notify(nextEventId++, notification)
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
