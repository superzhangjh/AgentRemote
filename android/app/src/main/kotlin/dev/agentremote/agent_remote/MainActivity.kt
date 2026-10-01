package dev.agentremote.agent_remote

import android.Manifest
import android.app.DownloadManager
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.PowerManager
import android.provider.Settings
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.view.WindowManager
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import kotlin.math.sqrt

class MainActivity : FlutterActivity() {
    private var permissionResult: MethodChannel.Result? = null
    private var microphonePermissionResult: MethodChannel.Result? = null
    private var shakeChannel: MethodChannel? = null
    private var shakeListener: SensorEventListener? = null
    private var speechChannel: MethodChannel? = null
    private var speechRecognizer: SpeechRecognizer? = null
    private var speechLastPartial = ""
    private var notificationChannel: MethodChannel? = null
    private var notificationNavigationReady = false
    private var pendingNotificationTarget: Map<String, String>? = null
    private var lastShakeAt = 0L
    private var aboveThreshold = false
    private var peakCount = 0
    private var peakWindowStart = 0L
    private var lastPeakAt = 0L
    private val store by lazy { SecureStore(this) }

    companion object {
        const val EXTRA_NOTIFICATION_SESSION_ID = "notification_session_id"
        const val EXTRA_NOTIFICATION_PROVIDER = "notification_provider"

        private const val SHAKE_THRESHOLD_GRAVITY = 2.0f
        private const val SHAKE_PEAK_COUNT = 3
        private const val SHAKE_PEAK_MIN_GAP_MS = 80L
        private const val SHAKE_WINDOW_MS = 1500L
        private const val SHAKE_COOLDOWN_MS = 2000L
    }

    override fun onResume() {
        super.onResume()
        store.write("app_foreground", "true")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        revealOverLockScreenForNotification(intent)
    }

    /**
     * A question or approval answered from the lock screen launches this
     * activity through the notification's full-screen intent. Showing over the
     * keyguard and turning the screen on is what makes that launch wake the
     * phone instead of leaving it with a dark screen.
     */
    @Suppress("DEPRECATION")
    private fun revealOverLockScreenForNotification(intent: Intent?) {
        if (readNotificationTarget(intent) == null) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON,
            )
        }
    }

    override fun onPause() {
        store.write("app_foreground", "false")
        store.write("visible_session_id", "")
        super.onPause()
    }

    override fun onDestroy() {
        stopShakeDetection()
        stopSpeechRecognition()
        super.onDestroy()
    }

    private fun readNotificationTarget(intent: Intent?): Map<String, String>? {
        if (intent == null) return null
        val data = intent.data?.takeIf { it.authority == "notification" }
        val sessionId = intent.getStringExtra(EXTRA_NOTIFICATION_SESSION_ID)
            ?.takeIf { it.isNotBlank() }
            ?: data?.pathSegments?.firstOrNull()?.takeIf { it.isNotBlank() }
            ?: return null
        val provider = intent.getStringExtra(EXTRA_NOTIFICATION_PROVIDER).orEmpty()
            .ifBlank { data?.getQueryParameter("provider").orEmpty() }
        return mapOf("sessionId" to sessionId, "provider" to provider)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        readNotificationTarget(intent)?.let { target ->
            pendingNotificationTarget = target
            if (notificationNavigationReady) {
                notificationChannel?.invokeMethod("notificationTapped", target)
            }
            revealOverLockScreenForNotification(intent)
        }
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "agent_remote/storage")
            .setMethodCallHandler { call, result ->
                try {
                    when (call.method) {
                        "load" -> result.success(store.read("addresses"))
                        "save" -> {
                            store.write("addresses", call.argument<String>("value") ?: "{}")
                            result.success(null)
                        }
                        else -> result.notImplemented()
                    }
                } catch (error: Exception) {
                    result.error("storage", error.message, null)
                }
            }
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "agent_remote/microphone")
            .setMethodCallHandler { call, result ->
                if (call.method == "requestPermission") {
                    requestMicrophonePermission(result)
                } else {
                    result.notImplemented()
                }
            }
        notificationChannel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "agent_remote/notifications")
        notificationChannel?.setMethodCallHandler { call, result ->
                try {
                    when (call.method) {
                        "takePendingNotification" -> {
                            notificationNavigationReady = true
                            result.success(pendingNotificationTarget)
                            pendingNotificationTarget = null
                        }
                        "acknowledgeNotification" -> {
                            val sessionId = call.argument<String>("sessionId")
                            val provider = call.argument<String>("provider")
                            if (pendingNotificationTarget?.get("sessionId") == sessionId &&
                                pendingNotificationTarget?.get("provider") == provider
                            ) {
                                pendingNotificationTarget = null
                            }
                            result.success(null)
                        }
                        "setVisibleSession" -> {
                            val sessionId = call.argument<String>("sessionId").orEmpty()
                            store.write("visible_session_id", sessionId)
                            // Entering a session by hand should clear whatever
                            // notification brought the user back to it.
                            if (sessionId.isNotBlank() && store.read("enabled") == "true") {
                                startService(
                                    Intent(this, CloudCliNotificationService::class.java)
                                        .setAction(CloudCliNotificationService.ACTION_DISMISS_SESSION)
                                        .putExtra(CloudCliNotificationService.EXTRA_SESSION_ID, sessionId),
                                )
                            }
                            result.success(null)
                        }
                        "enqueueDownload" -> {
                            val downloadUri = Uri.parse(call.argument<String>("url") ?: "")
                            val baseUri = Uri.parse(call.argument<String>("baseUrl") ?: "")
                            val sameServer = !downloadUri.host.isNullOrBlank() &&
                                !baseUri.host.isNullOrBlank() &&
                                downloadUri.scheme in listOf("http", "https") &&
                                downloadUri.scheme == baseUri.scheme &&
                                downloadUri.host.equals(baseUri.host, ignoreCase = true) &&
                                downloadUri.port == baseUri.port
                            val token = call.argument<String>("token").orEmpty()
                            if (!sameServer || token.isBlank()) {
                                result.error("invalid_download", "下载地址或登录凭据无效", null)
                                return@setMethodCallHandler
                            }

                            val rawFileName = call.argument<String>("fileName").orEmpty()
                            val fileName = rawFileName.substringAfterLast('/').substringAfterLast('\\')
                                .filter { it >= ' ' && it != '\u007f' }
                                .trim()
                                .takeUnless { it.isBlank() || it == "." || it == ".." }
                                ?: "download"
                            val mimeType = call.argument<String>("mimeType")?.takeIf { it.isNotBlank() }
                            val request = DownloadManager.Request(downloadUri)
                                .setTitle(fileName)
                                .setDescription("Agent 遥控台后台下载")
                                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName)
                                .addRequestHeader("Authorization", "Bearer $token")
                            if (mimeType != null) request.setMimeType(mimeType)
                            val manager = getSystemService(DOWNLOAD_SERVICE) as DownloadManager
                            result.success(manager.enqueue(request))
                        }
                        "requestPermission" -> requestNotificationPermission(result)
                        "start" -> {
                            val url = call.argument<String>("url") ?: ""
                            val token = call.argument<String>("token") ?: ""
                            val parsed = Uri.parse(url)
                            if (parsed.scheme !in listOf("http", "https") || parsed.host.isNullOrBlank() ||
                                token.split('.').size != 3) {
                                result.error("invalid_connection", "CloudCLI 地址或登录凭据无效", null)
                                return@setMethodCallHandler
                            }
                            store.write("url", url)
                            store.write("token", token)
                            store.write("enabled", "true")
                            val intent = Intent(this, CloudCliNotificationService::class.java)
                            if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent) else startService(intent)
                            result.success(null)
                        }
                        "stop" -> {
                            store.write("enabled", "false")
                            stopService(Intent(this, CloudCliNotificationService::class.java))
                            result.success(null)
                        }
                        "batteryUnrestricted" -> {
                            val manager = getSystemService(POWER_SERVICE) as PowerManager
                            result.success(Build.VERSION.SDK_INT < 23 || manager.isIgnoringBatteryOptimizations(packageName))
                        }
                        "openBatterySettings" -> {
                            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                            result.success(null)
                        }
                        "openNotificationSettings" -> {
                            val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                                .putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                            startActivity(intent)
                            result.success(null)
                        }
                        else -> result.notImplemented()
                    }
                } catch (error: Exception) {
                    result.error("notifications", error.message, null)
                }
            }
        pendingNotificationTarget = readNotificationTarget(intent)
        val shake = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "agent_remote/shake")
        shakeChannel = shake
        shake.setMethodCallHandler { call, result ->
            when (call.method) {
                "start" -> {
                    startShakeDetection()
                    result.success(null)
                }
                "stop" -> {
                    stopShakeDetection()
                    result.success(null)
                }
                else -> result.notImplemented()
            }
        }
        val speech = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "agent_remote/speech")
        speechChannel = speech
        speech.setMethodCallHandler { call, result ->
            try {
                when (call.method) {
                    "isAvailable" -> result.success(SpeechRecognizer.isRecognitionAvailable(this))
                    "start" -> {
                        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                            result.error("permission", "缺少录音权限", null)
                        } else {
                            startSpeechRecognition(call.argument("language"))
                            result.success(null)
                        }
                    }
                    "stop" -> {
                        speechRecognizer?.stopListening()
                        result.success(null)
                    }
                    "cancel" -> {
                        stopSpeechRecognition()
                        result.success(null)
                    }
                    else -> result.notImplemented()
                }
            } catch (error: Exception) {
                result.error("speech", error.message, null)
            }
        }
    }

    /**
     * Starts on-device speech recognition when the device supports it, otherwise
     * the system recognizer with an offline preference. Recognition runs entirely
     * inside the app process; no audio is uploaded by this shell.
     */
    private fun startSpeechRecognition(language: String?) {
        stopSpeechRecognition()
        val recognizer = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            SpeechRecognizer.isOnDeviceRecognitionAvailable(this)
        ) {
            SpeechRecognizer.createOnDeviceSpeechRecognizer(this)
        } else {
            SpeechRecognizer.createSpeechRecognizer(this)
        }
        speechRecognizer = recognizer
        speechLastPartial = ""
        recognizer.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {
                emitSpeechEvent(mapOf("type" to "ready"))
            }

            override fun onBeginningOfSpeech() = Unit

            override fun onRmsChanged(rmsdB: Float) = Unit

            override fun onBufferReceived(buffer: ByteArray?) = Unit

            override fun onEndOfSpeech() {
                emitSpeechEvent(mapOf("type" to "processing"))
            }

            override fun onError(error: Int) {
                if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
                    if (speechLastPartial.isNotBlank()) {
                        emitSpeechEvent(mapOf("type" to "final", "text" to speechLastPartial))
                    } else {
                        emitSpeechEvent(mapOf("type" to "empty"))
                    }
                } else {
                    emitSpeechEvent(
                        mapOf("type" to "error", "code" to error, "message" to speechErrorMessage(error)),
                    )
                }
                stopSpeechRecognition()
            }

            override fun onResults(results: Bundle?) {
                val result = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                    ?.firstOrNull()?.trim().orEmpty()
                val text = result.ifBlank { speechLastPartial }
                if (text.isBlank()) {
                    emitSpeechEvent(mapOf("type" to "empty"))
                } else {
                    emitSpeechEvent(mapOf("type" to "final", "text" to text))
                }
                stopSpeechRecognition()
            }

            override fun onPartialResults(partialResults: Bundle?) {
                val text = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                    ?.firstOrNull()?.trim().orEmpty()
                if (text.isNotBlank()) {
                    speechLastPartial = text
                    emitSpeechEvent(mapOf("type" to "partial", "text" to text))
                }
            }

            override fun onEvent(eventType: Int, params: Bundle?) = Unit
        })
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, packageName)
            if (!language.isNullOrBlank()) {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, language)
            }
        }
        try {
            recognizer.startListening(intent)
        } catch (error: Exception) {
            emitSpeechEvent(mapOf("type" to "error", "message" to (error.message ?: "语音识别启动失败")))
            stopSpeechRecognition()
        }
    }

    private fun stopSpeechRecognition() {
        speechRecognizer?.let {
            try {
                it.destroy()
            } catch (_: Exception) {
            }
        }
        speechRecognizer = null
        speechLastPartial = ""
    }

    private fun emitSpeechEvent(event: Map<String, Any?>) {
        speechChannel?.invokeMethod("event", event)
    }

    private fun speechErrorMessage(error: Int): String = when (error) {
        SpeechRecognizer.ERROR_AUDIO -> "音频错误"
        SpeechRecognizer.ERROR_CLIENT -> "客户端错误"
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "缺少录音权限"
        SpeechRecognizer.ERROR_NETWORK -> "网络错误"
        SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "网络超时"
        SpeechRecognizer.ERROR_NO_MATCH -> "无法识别语音"
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "识别器忙"
        SpeechRecognizer.ERROR_SERVER -> "服务错误"
        SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "未检测到语音"
        else -> "语音识别失败"
    }

    private fun startShakeDetection() {
        if (shakeListener != null) return
        val manager = getSystemService(Context.SENSOR_SERVICE) as SensorManager
        val sensor = manager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) ?: return
        val listener = object : SensorEventListener {
            override fun onSensorChanged(event: SensorEvent) {
                val x = event.values[0] / SensorManager.GRAVITY_EARTH
                val y = event.values[1] / SensorManager.GRAVITY_EARTH
                val z = event.values[2] / SensorManager.GRAVITY_EARTH
                val gForce = sqrt((x * x + y * y + z * z).toDouble())
                if (gForce <= SHAKE_THRESHOLD_GRAVITY) {
                    aboveThreshold = false
                    return
                }
                if (aboveThreshold) return
                aboveThreshold = true
                val now = System.currentTimeMillis()
                if (now - peakWindowStart > SHAKE_WINDOW_MS) {
                    peakWindowStart = now
                    peakCount = 0
                }
                if (now - lastPeakAt < SHAKE_PEAK_MIN_GAP_MS) return
                lastPeakAt = now
                peakCount++
                if (peakCount < SHAKE_PEAK_COUNT) return
                if (now - lastShakeAt < SHAKE_COOLDOWN_MS) return
                lastShakeAt = now
                peakCount = 0
                shakeChannel?.invokeMethod("onShake", null)
            }

            override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
        }
        manager.registerListener(listener, sensor, SensorManager.SENSOR_DELAY_GAME)
        shakeListener = listener
    }

    private fun stopShakeDetection() {
        val listener = shakeListener ?: return
        (getSystemService(Context.SENSOR_SERVICE) as? SensorManager)?.unregisterListener(listener)
        shakeListener = null
        aboveThreshold = false
        peakCount = 0
        peakWindowStart = 0L
        lastPeakAt = 0L
    }

    private fun requestNotificationPermission(result: MethodChannel.Result) {
        if (Build.VERSION.SDK_INT < 33 ||
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            result.success(true)
            return
        }
        permissionResult = result
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 42)
    }

    private fun requestMicrophonePermission(result: MethodChannel.Result) {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            result.success(true)
            return
        }
        microphonePermissionResult = result
        requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 43)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 42) {
            permissionResult?.success(grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED)
            permissionResult = null
        } else if (requestCode == 43) {
            microphonePermissionResult?.success(grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED)
            microphonePermissionResult = null
        }
    }
}
