package com.example.tabletprojeto2

import android.Manifest
import android.annotation.SuppressLint
import android.annotation.TargetApi
import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.util.Log
import android.view.Gravity
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebViewRenderProcess
import android.webkit.WebViewRenderProcessClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.FileNotFoundException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : ComponentActivity() {
    private val handler = Handler(Looper.getMainLooper())
    private val preferences by lazy { getSharedPreferences("eddy-display", MODE_PRIVATE) }
    private lateinit var container: FrameLayout
    private var webView: WebView? = null
    private var speech: TextToSpeech? = null
    private var speechReady = false
    private var resumed = false
    private var charging = true
    private var dimmed = false
    private var receiverRegistered = false
    private var rendererFailures = 0
    private var pendingCamera: PermissionRequest? = null
    private var flushScheduled = false
    private var persistedAlerts = "[]"
    private var recoveryClock: TextView? = null
    private lateinit var serverWatchdog: LocalServerWatchdog
    @Volatile private var generation = 0L
    @Volatile private var trustedPage = false
    @Volatile private var destroyed = false
    @Volatile private var snapshot = "{}"

    private val persistSnapshot = Runnable {
        flushScheduled = false
        preferences.edit().putString(SNAPSHOT_KEY, snapshot).apply()
        persistedAlerts = snapshotAlerts(snapshot).toString()
    }
    private val stableRenderer = Runnable { rendererFailures = 0 }
    private val retryPanel = Runnable { if (!destroyed && resumed) createWebView() }
    private val stalledRenderer = Runnable {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) terminateRenderer()
    }
    private val tickRecovery = object : Runnable {
        override fun run() {
            recoveryClock?.text = SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date())
            if (!destroyed && recoveryClock != null) {
                container.translationX = ((System.currentTimeMillis() / 60_000) % 5 - 2).toFloat()
                handler.postDelayed(this, 30_000)
            }
        }
    }
    private val cameraPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val request = pendingCamera
        pendingCamera = null
        if (request != null) {
            if (granted && trustedPage && !destroyed) request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
            else request.deny()
        }
    }
    private val batteryReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == Intent.ACTION_BATTERY_CHANGED) {
                charging = intent.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0
                publishBattery()
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        snapshot = preferences.getString(SNAPSHOT_KEY, "{}") ?: "{}"
        persistedAlerts = snapshotAlerts(snapshot).toString()
        container = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        setContentView(container)
        configureWindow()
        val policy = getSystemService(DevicePolicyManager::class.java)
        if (policy?.isLockTaskPermitted(packageName) == true) startLockTask()
        speech = TextToSpeech(applicationContext) { status ->
            if (!destroyed) {
                speechReady = status == TextToSpeech.SUCCESS
                if (speechReady) {
                    val result = speech?.setLanguage(Locale.forLanguageTag("pt-PT"))
                    if (result == TextToSpeech.LANG_MISSING_DATA || result == TextToSpeech.LANG_NOT_SUPPORTED) {
                        speech?.language = Locale.forLanguageTag("pt-BR")
                    }
                }
            }
        }
        ContextCompat.registerReceiver(this, batteryReceiver, IntentFilter(Intent.ACTION_BATTERY_CHANGED), ContextCompat.RECEIVER_NOT_EXPORTED)
        receiverRegistered = true
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = evaluate("window.dispatchEvent(new Event('eddy:back'))")
        })
        serverWatchdog = LocalServerWatchdog(applicationContext)
        serverWatchdog.start()
        createWebView()
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        configureWindow()
        if (webView == null) createWebView() else webView?.onResume()
        applyBrightness()
        publishBattery()
    }

    override fun onPause() {
        resumed = false
        pendingCamera?.deny()
        pendingCamera = null
        webView?.onPause()
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.attributes = window.attributes.apply { screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE }
        super.onPause()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) configureWindow()
    }

    override fun onDestroy() {
        destroyed = true
        trustedPage = false
        generation++
        handler.removeCallbacksAndMessages(null)
        serverWatchdog.close()
        pendingCamera?.deny()
        pendingCamera = null
        if (receiverRegistered) unregisterReceiver(batteryReceiver)
        persistSnapshot.run()
        webView?.let { disposeWebView(it) }
        speechReady = false
        speech?.stop()
        speech?.shutdown()
        speech = null
        super.onDestroy()
    }

    private fun configureWindow() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.systemBars())
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView() {
        if (destroyed) return
        handler.removeCallbacks(retryPanel)
        handler.removeCallbacks(tickRecovery)
        handler.removeCallbacks(stalledRenderer)
        webView?.let { disposeWebView(it) }
        recoveryClock = null
        container.removeAllViews()
        container.translationX = 0f
        generation++
        val currentGeneration = generation
        val view = WebView(this)
        webView = view
        view.setBackgroundColor(Color.BLACK)
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            mediaPlaybackRequiresUserGesture = false
        }
        view.isHorizontalScrollBarEnabled = false
        view.isVerticalScrollBarEnabled = false
        view.addJavascriptInterface(AndroidBridge(currentGeneration), "AndroidSync")
        view.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                if (!isTrustedOrigin(request.origin) || !trustedPage || !request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) {
                    request.deny()
                } else if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
                } else {
                    pendingCamera?.deny()
                    pendingCamera = request
                    cameraPermission.launch(Manifest.permission.CAMERA)
                }
            }

            override fun onPermissionRequestCanceled(request: PermissionRequest) {
                if (pendingCamera === request) pendingCamera = null
            }
        }
        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = !isPanelNavigation(request.url)

            @Deprecated("Used by older WebView providers")
            override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean = !isPanelNavigation(Uri.parse(url))

            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                if (!isTrustedOrigin(request.url)) return emptyResponse(403, "Forbidden")
                if (request.url.path?.startsWith("/api/") == true) return null
                return bundledAsset(request.url)
            }

            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                if (currentGeneration == generation) trustedPage = isPanelNavigation(Uri.parse(url))
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (currentGeneration != generation || !isPanelNavigation(Uri.parse(url))) return
                trustedPage = true
                publishBattery()
                handler.removeCallbacks(stableRenderer)
                handler.postDelayed(stableRenderer, 120_000)
                Log.i(TAG, "Panel loaded, generation $currentGeneration")
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame && currentGeneration == generation) {
                    Log.w(TAG, "Main frame failed with code ${error.errorCode}")
                    handler.post { if (view === webView) recoverView(view, false) }
                }
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                Log.w(TAG, "Renderer exited, crashed=${detail.didCrash()}, generation=$currentGeneration")
                preferences.edit().putLong("lastRendererExitAt", System.currentTimeMillis())
                    .putInt("rendererExitCount", preferences.getInt("rendererExitCount", 0) + 1).apply()
                recoverView(view, true)
                return true
            }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) configureRendererWatchdog(view)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        container.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        view.loadUrl(PANEL_URL)
        if (!resumed) view.onPause()
    }

    private fun recoverView(failedView: WebView, rendererGone: Boolean) {
        val current = failedView === webView
        disposeWebView(failedView, rendererGone)
        if (!current || destroyed) return
        handler.removeCallbacks(stableRenderer)
        handler.removeCallbacks(stalledRenderer)
        rendererFailures++
        showRecovery()
        val delay = minOf(30_000L, 1_000L shl minOf(rendererFailures - 1, 5))
        handler.removeCallbacks(retryPanel)
        handler.postDelayed(retryPanel, delay)
    }

    private fun disposeWebView(view: WebView, rendererGone: Boolean = false) {
        if (view === webView) {
            trustedPage = false
            webView = null
        }
        if (!rendererGone) view.removeJavascriptInterface("AndroidSync")
        (view.parent as? ViewGroup)?.removeView(view)
        view.destroy()
    }

    @TargetApi(Build.VERSION_CODES.Q)
    private fun configureRendererWatchdog(view: WebView) {
        view.webViewRenderProcessClient = object : WebViewRenderProcessClient() {
            override fun onRenderProcessUnresponsive(view: WebView, renderer: WebViewRenderProcess?) {
                if (view === webView && !handler.hasCallbacks(stalledRenderer)) {
                    handler.postDelayed(stalledRenderer, 20_000)
                }
            }

            override fun onRenderProcessResponsive(view: WebView, renderer: WebViewRenderProcess?) {
                if (view === webView) handler.removeCallbacks(stalledRenderer)
            }
        }
    }

    @TargetApi(Build.VERSION_CODES.Q)
    private fun terminateRenderer() {
        Log.w(TAG, "Recovering an unresponsive renderer")
        webView?.webViewRenderProcess?.terminate()
    }

    private fun showRecovery() {
        container.removeAllViews()
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(40, 40, 40, 40)
        }
        val clock = TextView(this).apply {
            textSize = 64f
            setTextColor(Color.rgb(170, 175, 180))
            gravity = Gravity.CENTER
        }
        val warning = TextView(this).apply {
            textSize = 22f
            setTextColor(Color.rgb(180, 132, 65))
            gravity = Gravity.CENTER
            text = cachedWarning()
            setPadding(0, 24, 0, 24)
        }
        val message = TextView(this).apply {
            text = "A recuperar o painel…"
            textSize = 16f
            setTextColor(Color.rgb(125, 132, 140))
            gravity = Gravity.CENTER
            setPadding(0, 24, 0, 24)
        }
        layout.addView(clock)
        layout.addView(warning)
        layout.addView(message)
        layout.setOnClickListener {
            rendererFailures = 0
            createWebView()
        }
        container.addView(layout, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        recoveryClock = clock
        tickRecovery.run()
    }

    private fun publishBattery() = evaluate("if(typeof window.receberEstadoBateria==='function'){window.receberEstadoBateria($charging)}")

    private fun evaluate(script: String) {
        if (trustedPage && !destroyed) webView?.evaluateJavascript(script, null)
    }

    private fun applyBrightness() {
        if (resumed) window.attributes = window.attributes.apply {
            screenBrightness = if (dimmed) 0.06f else WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
        }
    }

    private fun isTrustedOrigin(uri: Uri): Boolean = uri.scheme == "http" && uri.host == "127.0.0.1" && uri.port == 3000 && uri.userInfo == null
    private fun isPanelNavigation(uri: Uri): Boolean = isTrustedOrigin(uri) && (uri.path == "/" || uri.path == "/index.html")

    private fun bundledAsset(uri: Uri): WebResourceResponse {
        val path = uri.path ?: return emptyResponse(404, "Not Found")
        if (path.split('/').any { it == ".." || it == "." } || path.contains('\\')) return emptyResponse(403, "Forbidden")
        val asset = when {
            path == "/" || path == "/index.html" -> "web/index.html"
            path.startsWith("/assets/") -> "web$path"
            else -> return emptyResponse(404, "Not Found")
        }
        return try {
            val mimeType = when (path.substringAfterLast('.').lowercase(Locale.ROOT)) {
                "css" -> "text/css"
                "js" -> "application/javascript"
                "json" -> "application/json"
                "svg" -> "image/svg+xml"
                "png" -> "image/png"
                "jpg", "jpeg" -> "image/jpeg"
                "webp" -> "image/webp"
                "woff2" -> "font/woff2"
                "woff" -> "font/woff"
                "ttf" -> "font/ttf"
                "otf" -> "font/otf"
                else -> "text/html"
            }
            val encoding = if (mimeType.startsWith("text/") || mimeType.contains("javascript") || mimeType.contains("json") || mimeType.contains("svg")) "UTF-8" else null
            WebResourceResponse(mimeType, encoding, assets.open(asset)).apply {
                responseHeaders = mapOf(
                    "Cache-Control" to "no-store",
                    "X-Content-Type-Options" to "nosniff",
                    "Content-Security-Policy" to "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'"
                )
            }
        } catch (_: FileNotFoundException) {
            emptyResponse(404, "Not Found")
        }
    }

    private fun emptyResponse(code: Int, reason: String) = WebResourceResponse(
        "text/plain", "UTF-8", code, reason, mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(ByteArray(0))
    )

    private fun snapshotAlerts(json: String): JSONArray {
        return try {
            val parsed = JSONObject(json)
            val state = parsed.optJSONObject("state") ?: parsed
            state.optJSONArray("alerts") ?: state.optJSONObject("robot")?.optJSONArray("alerts") ?: JSONArray()
        } catch (_: JSONException) { JSONArray() }
    }

    private fun cachedWarning(): String {
        val alerts = snapshotAlerts(snapshot)
        val titles = mutableListOf<String>()
        for (index in 0 until alerts.length()) {
            val title = alerts.optJSONObject(index)?.optString("title", "") ?: ""
            if (title.isNotBlank()) titles.add(title.take(160))
        }
        return if (titles.isEmpty()) "" else titles.distinct().joinToString("\n") + "\nÚltimo estado confirmado"
    }

    private inner class AndroidBridge(private val pageGeneration: Long) {
        private fun active(): Boolean = !destroyed && trustedPage && pageGeneration == generation

        @JavascriptInterface
        fun falar(text: String) {
            if (active()) handler.post {
                if (active() && speechReady) speech?.speak(text.take(500), TextToSpeech.QUEUE_FLUSH, null, "eddy")
            }
        }

        @JavascriptInterface
        fun setDimmed(value: Boolean) {
            if (active()) handler.post {
                if (active()) {
                    dimmed = value
                    applyBrightness()
                }
            }
        }

        @JavascriptInterface
        fun rememberSnapshot(json: String) {
            if (!active() || json.length > 128 * 1024) return
            val normalized = try { JSONObject(json).toString() } catch (_: JSONException) { return }
            snapshot = normalized
            handler.post {
                if (!active()) return@post
                if (snapshotAlerts(normalized).toString() != persistedAlerts) {
                    handler.removeCallbacks(persistSnapshot)
                    persistSnapshot.run()
                } else if (!flushScheduled) {
                    flushScheduled = true
                    handler.postDelayed(persistSnapshot, 15_000)
                }
            }
        }

        @JavascriptInterface
        fun getSnapshot(): String = if (active()) snapshot else "{}"

        @JavascriptInterface
        fun restartConnection() {
            if (active()) handler.post { if (active()) createWebView() }
        }
    }

    companion object {
        private const val TAG = "EddyPanel"
        private const val PANEL_URL = "http://127.0.0.1:3000/"
        private const val SNAPSHOT_KEY = "confirmedDisplaySnapshot"
    }
}
