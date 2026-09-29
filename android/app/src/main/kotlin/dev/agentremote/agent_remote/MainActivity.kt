package dev.agentremote.agent_remote

import android.Manifest
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private var permissionResult: MethodChannel.Result? = null
    private var microphonePermissionResult: MethodChannel.Result? = null
    private val store by lazy { SecureStore(this) }

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
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "agent_remote/notifications")
            .setMethodCallHandler { call, result ->
                try {
                    when (call.method) {
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
