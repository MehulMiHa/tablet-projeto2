package com.eddy.mobile

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Bitmap
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.os.PersistableBundle
import android.provider.DocumentsContract
import android.util.Base64
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.HttpAuthHandler
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ImageView
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import android.widget.ProgressBar
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.FilterInputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL
import java.util.concurrent.Executors

class MobileActivity : ComponentActivity() {
    private data class Connection(val address: String, val user: String, val password: String, val tunnel: EmbeddedTunnel.Snapshot) {
        val origin get() = tunnel.origin
        val authorization get() = "Basic ${Base64.encodeToString("$user:$password".toByteArray(), Base64.NO_WRAP)}"
    }
    private data class Download(val connection: Connection, val path: String)

    private val pageBackground = Color.rgb(14, 21, 19)
    private val panel = Color.rgb(26, 38, 33)
    private val primary = Color.rgb(198, 232, 217)
    private val textColor = Color.rgb(238, 246, 240)
    private val muted = Color.rgb(172, 193, 182)
    private val worker = Executors.newFixedThreadPool(2)
    private lateinit var root: FrameLayout
    private val lifecycleHandler = Handler(Looper.getMainLooper())
    private var foreground = false
    @Volatile private var tunnelId = 0L
    private var waitingForTunnel = false
    private var connectWhenReady = false
    private var tunnelDeadline = 0L
    private var loginInProgress = false
    private var uploadInProgress = false
    private var nativeDownloads = 0
    private var authorizationDialog: AlertDialog? = null
    private var authorizationURL = ""
    private val stopTunnel = Runnable { releaseTunnel() }
    private val waitForTunnel = object : Runnable {
        override fun run() {
            if (!waitingForTunnel || !foreground || isFinishing || isDestroyed) return
            val snapshot = EmbeddedTunnel.snapshot(tunnelId)
            if (snapshot.id != tunnelId) return
            reconcileAuthorization(snapshot)
            authorizeButton.visibility = if (snapshot.state == "needs-login" && loginURL(snapshot.authURL) != null) View.VISIBLE else View.GONE
            if (snapshot.state == "running") {
                waitingForTunnel = false
                setConnectionState("A abrir os ficheiros da família…", loading = true)
                if (connectWhenReady && web == null) { connectWhenReady = false; connect() }
            } else if (snapshot.state == "needs-login") {
                val ready = loginURL(snapshot.authURL) != null
                setConnectionState(if (ready) "Autoriza este telemóvel a partir de outro dispositivo." else "A preparar o pedido de acesso…", loading = !ready, authorize = ready)
                if (ready && promptedAuthorizationURL != snapshot.authURL) {
                    promptedAuthorizationURL = snapshot.authURL
                    authorizeAccess()
                }
                tunnelDeadline = SystemClock.elapsedRealtime() + 45_000
                lifecycleHandler.postDelayed(this, 500)
            } else if (snapshot.state == "error" || snapshot.state == "stopped") {
                waitingForTunnel = false
                connectWhenReady = false
                setConnectionState("Não foi possível preparar a ligação privada. Confirma a Internet e tenta novamente.", retry = true)
            } else if (SystemClock.elapsedRealtime() >= tunnelDeadline) {
                waitingForTunnel = false
                connectWhenReady = false
                setConnectionState("A ligação privada demorou demasiado. Confirma a Internet e tenta novamente.", retry = true)
            } else lifecycleHandler.postDelayed(this, 400)
        }
    }
    private lateinit var status: TextView
    private lateinit var retryButton: Button
    private lateinit var authorizeButton: Button
    private lateinit var loadingIndicator: ProgressBar
    private var promptedAuthorizationURL = ""
    private var web: WebView? = null
    private var connection: Connection? = null
    @Volatile private var generation = 0
    private var pickFiles: ValueCallback<Array<Uri>>? = null
    private var download: Download? = null
    private var networkCallbackRegistered = false
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = EmbeddedTunnel.networkChanged(tunnelId)
        override fun onLost(network: Network) = EmbeddedTunnel.networkChanged(tunnelId)
        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) = EmbeddedTunnel.networkChanged(tunnelId)
        override fun onLinkPropertiesChanged(network: Network, properties: LinkProperties) = EmbeddedTunnel.networkChanged(tunnelId)
    }
    private val checkTunnel = object : Runnable {
        override fun run() {
            if (isFinishing || isDestroyed) return
            checkSessionTunnel()
            if (foreground || transferOrPickerActive()) lifecycleHandler.postDelayed(this, 1_000)
        }
    }

    private val picker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val selection = result.data?.clipData
        val files = if (result.resultCode == Activity.RESULT_OK && selection != null) {
            Array(selection.itemCount) { index -> selection.getItemAt(index).uri }
        } else WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
        pickFiles?.onReceiveValue(files?.filter { it.scheme == "content" }?.toTypedArray())
        pickFiles = null
        scheduleTunnelStop()
    }
    private val saveFile = registerForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
        val pending = download
        download = null
        if (uri != null && pending != null) writeDownload(pending, uri)
        scheduleTunnelStop()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(networkCallback)
        networkCallbackRegistered = true
        WindowCompat.setDecorFitsSystemWindows(window, false)
        root = FrameLayout(this).apply { setBackgroundColor(pageBackground) }
        setContentView(root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, keyboard.bottom))
            insets
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val view = web
                if (view == null) leaveEddy()
                else view.evaluateJavascript("window.EddyCloseOverlay && window.EddyCloseOverlay()") { closed ->
                    if (closed != "true") leaveEddy()
                }
            }
        })
        showConnection()
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density + .5f).toInt()

    private fun rounded(color: Int, radius: Int = 16) = GradientDrawable().apply {
        setColor(color)
        cornerRadius = dp(radius).toFloat()
    }

    private fun LinearLayout.label(copy: String, size: Float, color: Int, gap: Int, bold: Boolean = false): TextView {
        val label = TextView(this@MobileActivity).apply {
            text = copy
            textSize = size
            setTextColor(color)
            if (bold) typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        }
        addView(label, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(gap) })
        return label
    }

    private fun LinearLayout.action(copy: String, prominent: Boolean, action: () -> Unit): Button {
        val button = Button(this@MobileActivity).apply {
            text = copy
            isAllCaps = false
            textSize = 16f
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            stateListAnimator = null
            setTextColor(if (prominent) pageBackground else primary)
            background = rounded(if (prominent) primary else panel)
            setOnClickListener { action() }
        }
        addView(button, LinearLayout.LayoutParams(-1, dp(52)).apply { topMargin = dp(12) })
        return button
    }

    private fun configuredAddress(): String? = parseAddress(BuildConfig.MOBILE_TABLET_ADDRESS.trim())

    private fun configured(): Boolean = configuredAddress() != null &&
        BuildConfig.MOBILE_USER in setOf("eddy", "familia") && BuildConfig.MOBILE_PASSWORD.isNotEmpty()

    private fun setConnectionState(message: String, loading: Boolean = false, retry: Boolean = false, authorize: Boolean = false) {
        status.text = message
        loadingIndicator.visibility = if (loading) View.VISIBLE else View.GONE
        retryButton.visibility = if (retry && configured()) View.VISIBLE else View.GONE
        authorizeButton.visibility = if (authorize) View.VISIBLE else View.GONE
    }

    private fun showConnection(message: String = "") {
        generation++
        closeAuthorization()
        loginInProgress = false
        closeWeb()
        val scroll = ScrollView(this).apply { isFillViewport = true }
        val stack = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(34), dp(36), dp(34), dp(36))
        }
        scroll.addView(stack, FrameLayout.LayoutParams(-1, -2))
        root.removeAllViews()
        root.addView(scroll, FrameLayout.LayoutParams(-1, -1))
        val icon = ImageView(this).apply {
            setImageDrawable(applicationInfo.loadIcon(packageManager))
            contentDescription = null
        }
        stack.addView(icon, LinearLayout.LayoutParams(dp(92), dp(92)).apply { gravity = Gravity.CENTER_HORIZONTAL })
        stack.label("Eddy", 38f, textColor, 22, true).gravity = Gravity.CENTER
        stack.label("As fotos e os ficheiros da tua família,\nsempre por perto.", 17f, muted, 10).apply { gravity = Gravity.CENTER; setLineSpacing(dp(4).toFloat(), 1f) }
        loadingIndicator = ProgressBar(this).apply { indeterminateTintList = ColorStateList.valueOf(primary) }
        stack.addView(loadingIndicator, LinearLayout.LayoutParams(dp(30), dp(30)).apply { gravity = Gravity.CENTER_HORIZONTAL; topMargin = dp(32) })
        status = stack.label("", 16f, muted, 24).apply {
            gravity = Gravity.CENTER
            setLineSpacing(dp(4).toFloat(), 1f)
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        authorizeButton = stack.action("Autorizar acesso privado", true, ::authorizeAccess).apply { visibility = View.GONE }
        retryButton = stack.action("Tentar novamente", false, ::connect).apply { visibility = View.GONE }
        if (configured()) setConnectionState(message.ifEmpty { "A preparar a ligação privada…" }, loading = message.isEmpty(), retry = message.isNotEmpty())
        else setConnectionState("Esta instalação precisa de ser configurada.")
        stack.isFocusableInTouchMode = true
        stack.requestFocus()
        scheduleTunnelStop()
    }

    private fun transferOrPickerActive(): Boolean =
        pickFiles != null || download != null || uploadInProgress || nativeDownloads > 0

    private fun leaveEddy() {
        // Keep the activity and its transfers alive when leaving with Back.
        if (transferOrPickerActive()) moveTaskToBack(true) else finish()
    }

    private fun beginTunnel(connectAfter: Boolean) {
        if (!foreground || isFinishing || isDestroyed) return
        lifecycleHandler.removeCallbacks(stopTunnel)
        connectWhenReady = connectWhenReady || connectAfter
        if (web != null && connection?.let(::connectionTunnelAvailable) == true) return
        val address = configuredAddress()
        if (!configured() || address == null) {
            setConnectionState("Esta instalação precisa de ser configurada.")
            return
        }
        if (!waitingForTunnel) {
            closeAuthorization()
            promptedAuthorizationURL = ""
            tunnelId = EmbeddedTunnel.start(applicationContext, address)
            waitingForTunnel = true
            tunnelDeadline = SystemClock.elapsedRealtime() + 45_000
            setConnectionState("A estabelecer a ligação privada…", loading = true)
        }
        lifecycleHandler.removeCallbacks(waitForTunnel)
        lifecycleHandler.post(waitForTunnel)
    }

    private fun scheduleTunnelStop() {
        lifecycleHandler.removeCallbacks(stopTunnel)
        if (!foreground && !transferOrPickerActive()) lifecycleHandler.postDelayed(stopTunnel, 3_000)
    }

    private fun releaseTunnel() {
        if (foreground || transferOrPickerActive()) return
        waitingForTunnel = false
        connectWhenReady = false
        lifecycleHandler.removeCallbacks(waitForTunnel)
        closeAuthorization()
        if (web != null) showConnection("A ligação privada volta a ligar quando abrires a Eddy.")
        else {
            generation++
            loginInProgress = false
            if (::status.isInitialized) setConnectionState("A ligação privada volta a ligar quando abrires a Eddy.")
        }
        lifecycleHandler.removeCallbacks(stopTunnel)
        // The only HTTP destination in this process is the private loopback proxy.
        EmbeddedTunnel.stop(tunnelId)
        lifecycleHandler.removeCallbacks(checkTunnel)
    }

    private fun loginURL(raw: String): Uri? = try {
        Uri.parse(raw).takeIf { it.scheme == "https" && it.host == "login.tailscale.com" &&
            it.port in listOf(-1, 443) && it.userInfo == null && it.fragment == null }
    } catch (_: Exception) { null }

    private fun authorizeAccess() {
        val snapshot = EmbeddedTunnel.snapshot(tunnelId)
        val uri = loginURL(snapshot.authURL) ?: return
        if (snapshot.id != tunnelId || snapshot.state != "needs-login") return
        if (authorizationDialog?.isShowing == true && authorizationURL == uri.toString()) return
        closeAuthorization()
        val link = uri.toString()
        val qr = try {
            val matrix = QRCodeWriter().encode(link, BarcodeFormat.QR_CODE, 512, 512,
                mapOf(EncodeHintType.MARGIN to 4, EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M))
            val pixels = IntArray(512 * 512) { index -> if (matrix[index % 512, index / 512]) Color.BLACK else Color.WHITE }
            Bitmap.createBitmap(pixels, 512, 512, Bitmap.Config.ARGB_8888)
        } catch (_: Exception) {
            status.text = "Não foi possível preparar o pedido de acesso. Tenta novamente."
            return
        }
        val contents = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(8), dp(24), dp(8))
        }
        contents.label("Lê este código com outro telemóvel ou abre a ligação num computador. Autoriza o acesso com a conta da família nesse dispositivo.", 15f, muted, 0)
        val image = ImageView(this).apply {
            setImageBitmap(qr)
            adjustViewBounds = true
            scaleType = ImageView.ScaleType.FIT_CENTER
            setBackgroundColor(Color.WHITE)
            contentDescription = "Código QR para autorizar este telemóvel noutro dispositivo"
        }
        contents.addView(image, LinearLayout.LayoutParams(-1, dp(250)).apply { topMargin = dp(18) })
        contents.label("Mantém a Eddy aberta enquanto autorizas o acesso no outro dispositivo. O pedido fecha automaticamente quando estiver concluído.", 14f, muted, 16)
        contents.label("Pedido de acesso", 13f, primary, 16, true)
        val linkLabel = contents.label(link, 13f, textColor, 6).apply {
            setTextIsSelectable(true)
        }
        val scroll = ScrollView(this).apply { addView(contents) }
        val dialog = AlertDialog.Builder(this)
            .setTitle("Autorizar noutro dispositivo")
            .setView(scroll)
            .setPositiveButton("Fechar", null)
            .setNeutralButton("Copiar ligação") { _, _ -> }
            .create()
        dialog.setOnDismissListener {
            image.setImageDrawable(null)
            linkLabel.text = ""
            if (authorizationDialog === dialog) { authorizationDialog = null; authorizationURL = "" }
        }
        authorizationURL = link
        authorizationDialog = dialog
        dialog.setCanceledOnTouchOutside(false)
        dialog.show()
        dialog.window?.setBackgroundDrawable(rounded(panel, 24))
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setTextColor(primary)
        dialog.getButton(AlertDialog.BUTTON_NEUTRAL).apply {
            setTextColor(primary)
            setOnClickListener {
                val active = EmbeddedTunnel.snapshot(tunnelId)
                if (active.id != tunnelId || active.state != "needs-login" || active.authURL != link) { closeAuthorization(); return@setOnClickListener }
                val clip = ClipData.newPlainText("Pedido de acesso Eddy", link).apply {
                    description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
                }
                getSystemService(ClipboardManager::class.java).setPrimaryClip(clip)
                Toast.makeText(this@MobileActivity, "Ligação copiada.", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun reconcileAuthorization(snapshot: EmbeddedTunnel.Snapshot) {
        if (authorizationDialog != null && (snapshot.id != tunnelId || snapshot.state != "needs-login" || snapshot.authURL != authorizationURL)) closeAuthorization()
    }

    private fun closeAuthorization() {
        authorizationDialog?.dismiss()
        authorizationDialog = null
        authorizationURL = ""
    }

    private fun parseAddress(input: String): String? {
        val uri = Uri.parse(if (input.startsWith("http://")) input else "http://$input")
        val host = uri.host ?: return null
        val parts = host.split('.')
        if (parts.size != 4 || parts.any { !it.matches(Regex("[0-9]{1,3}")) || it.toInt() !in 0..255 }) return null
        if (parts[0] != "100" || parts[1].toInt() !in 64..127 || uri.userInfo != null ||
            uri.port !in listOf(-1, 8787) || uri.query != null || uri.fragment != null || !uri.path.isNullOrEmpty() && uri.path != "/") return null
        return parts.joinToString(".") { it.toInt().toString() }
    }

    private fun connectionTunnelAvailable(target: Connection): Boolean = EmbeddedTunnel.available(target.tunnel)

    private fun checkSessionTunnel() {
        reconcileAuthorization(EmbeddedTunnel.snapshot(tunnelId))
        val current = connection ?: return
        if (!isFinishing && !isDestroyed && web != null && !connectionTunnelAvailable(current)) {
            showConnection("A ligação privada foi interrompida.")
            if (foreground) beginTunnel(connectAfter = true)
        }
    }

    override fun onResume() {
        super.onResume()
        web?.onResume()
        EmbeddedTunnel.networkChanged(tunnelId)
        checkSessionTunnel()
    }

    override fun onStart() {
        super.onStart()
        foreground = true
        lifecycleHandler.removeCallbacks(stopTunnel)
        beginTunnel(connectAfter = true)
        lifecycleHandler.removeCallbacks(checkTunnel)
        lifecycleHandler.post(checkTunnel)
    }

    override fun onStop() {
        foreground = false
        // Playback stops on leaving; uploads continue until their completion callback releases the tunnel.
        web?.evaluateJavascript("document.querySelectorAll('audio,video').forEach(function(media){media.pause();})", null)
        web?.onPause()
        scheduleTunnelStop()
        super.onStop()
    }

    private fun connect() {
        if (loginInProgress || !foreground) return
        val address = configuredAddress()
        if (!configured() || address == null) { setConnectionState("Esta instalação precisa de ser configurada."); return }
        val snapshot = EmbeddedTunnel.snapshot(tunnelId)
        if (snapshot.target == address && snapshot.state == "needs-login") {
            connectWhenReady = true
            authorizeAccess()
            return
        }
        if (snapshot.target != address || snapshot.state != "running" || !EmbeddedTunnel.available(snapshot)) {
            if (snapshot.target != address) waitingForTunnel = false
            beginTunnel(connectAfter = true)
            return
        }
        val candidate = Connection(address, BuildConfig.MOBILE_USER, BuildConfig.MOBILE_PASSWORD, snapshot)
        val session = ++generation
        loginInProgress = true
        setConnectionState("A abrir os ficheiros da família…", loading = true)
        worker.execute {
            val error = try {
                val request = request(candidate, "/api/session")
                try {
                    when (request.responseCode) {
                        200 -> {
                            val role = request.inputStream.bufferedReader().use { JSONObject(it.readLine()).optString("role") }
                            if (role in listOf("owner", "family")) null else "A Eddy do tablet precisa de ser atualizada."
                        }
                        401, 403 -> "Esta instalação precisa de atualizar o acesso à família."
                        404 -> "A Eddy do tablet precisa de ser atualizada."
                        429 -> "Demasiadas tentativas. Aguarda 30 segundos e volta a tentar."
                        else -> "A Eddy do tablet ainda está a iniciar."
                    }
                } finally { request.disconnect() }
            } catch (_: Exception) { "O tablet não respondeu. Confirma se está ligado à Internet e tenta novamente." }
            runOnUiThread {
                if (session != generation || isFinishing || isDestroyed) return@runOnUiThread
                loginInProgress = false
                if (error != null || !connectionTunnelAvailable(candidate)) {
                    setConnectionState(error ?: "A ligação privada mudou. Tenta novamente para retomar.", retry = true)
                } else {
                    connection = candidate
                    showWeb(candidate)
                }
            }
        }
    }

    private fun request(target: Connection, path: String): HttpURLConnection {
        if (!connectionTunnelAvailable(target) || !path.startsWith("/") || path.startsWith("//")) throw IOException("A ligação privada mudou.")
        return (URL(target.origin + path).openConnection(Proxy.NO_PROXY) as HttpURLConnection).apply {
            instanceFollowRedirects = false
            connectTimeout = 7000
            readTimeout = 15000
            setRequestProperty("Authorization", target.authorization)
            setRequestProperty("X-Eddy-Tunnel-Key", target.tunnel.token)
        }
    }

    private fun allowed(uri: Uri, target: Connection): Boolean =
        uri.scheme == "http" && uri.host == "127.0.0.1" && uri.port == Uri.parse(target.origin).port && uri.userInfo == null

    @SuppressLint("SetJavaScriptEnabled")
    private fun showWeb(target: Connection) {
        val session = ++generation
        val view = WebView(this)
        web = view
        view.setBackgroundColor(pageBackground)
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)
        view.addJavascriptInterface(object {
            @JavascriptInterface fun authorization(): String = if (session == generation && view === web) target.authorization else ""
            @JavascriptInterface fun tunnelHeader(): String = if (session == generation && view === web && connectionTunnelAvailable(target)) target.tunnel.token else ""

            @JavascriptInterface fun changeConnection() = runOnUiThread {
                if (session == generation && view === web) {
                    showConnection()
                    beginTunnel(connectAfter = true)
                }
            }

            @JavascriptInterface fun download(path: String, name: String) = runOnUiThread {
                if (session == generation && view === web) prepareDownload(target, path, name)
            }

            @JavascriptInterface fun uploadState(active: Boolean) = runOnUiThread {
                if (session == generation && view === web) {
                    uploadInProgress = active
                    scheduleTunnelStop()
                }
            }
        }, "EddyMobile")
        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                !allowed(request.url, target) || request.url.path != "/"

            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                if (!allowed(request.url, target) || !connectionTunnelAvailable(target) || session != generation) {
                    runOnUiThread { if (session == generation) checkSessionTunnel() }
                    return WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))
                }
                if (request.method != "GET" && request.method != "HEAD") return null
                // Supply this connection's account for every image and API read, including after changing accounts.
                return try {
                    val query = request.url.encodedQuery?.let { "?$it" }.orEmpty()
                    val response = request(target, request.url.encodedPath.orEmpty() + query)
                    response.requestMethod = request.method
                    request.requestHeaders.entries.firstOrNull { it.key.equals("Range", ignoreCase = true) }?.value?.let {
                        response.setRequestProperty("Range", it)
                    }
                    val code = response.responseCode
                    val contentType = response.contentType?.substringBefore(';') ?: "application/octet-stream"
                    val headers = response.headerFields.filterKeys { it != null }.mapValues { it.value.joinToString(", ") }
                    val bytes = if (request.method == "HEAD") ByteArrayInputStream(ByteArray(0))
                        else if (code < 400) response.inputStream else response.errorStream ?: ByteArrayInputStream(ByteArray(0))
                    val stream = object : FilterInputStream(bytes) {
                        override fun close() { try { super.close() } finally { response.disconnect() } }
                    }
                    val encoding = if (contentType.startsWith("text/") || contentType.contains("json") || contentType.contains("javascript")) "UTF-8" else null
                    WebResourceResponse(contentType, encoding, code, response.responseMessage ?: "Response", headers, stream)
                } catch (_: Exception) {
                    WebResourceResponse("text/plain", "UTF-8", 503, "Unavailable", emptyMap(), ByteArrayInputStream(ByteArray(0)))
                }
            }

            override fun onReceivedHttpAuthRequest(view: WebView, handler: HttpAuthHandler, host: String, realm: String) {
                val knownHost = host == "127.0.0.1" || host == "127.0.0.1:${Uri.parse(target.origin).port}"
                if (session == generation && knownHost && realm == "Eddy" && connectionTunnelAvailable(target) && handler.useHttpAuthUsernamePassword()) {
                    handler.proceed(target.user, target.password)
                } else handler.cancel()
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame && session == generation) showConnection("Perdeu-se a ligação ao tablet.")
            }

            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                if (request.isForMainFrame && session == generation) showConnection("Volta a ligar ao Eddy para abrir os ficheiros.")
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                if (session == generation) showConnection("A página fechou. Volta a ligar ao tablet.")
                return true
            }
        }
        view.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                pickFiles?.onReceiveValue(null)
                pickFiles = callback
                val intent = params.createIntent().apply { addCategory(Intent.CATEGORY_OPENABLE) }
                try { picker.launch(intent) }
                catch (_: Exception) { callback.onReceiveValue(null); pickFiles = null }
                return true
            }
        }
        root.removeAllViews()
        root.addView(view, FrameLayout.LayoutParams(-1, -1))
        view.loadUrl(target.origin + "/", mapOf("Authorization" to target.authorization, "X-Eddy-Tunnel-Key" to target.tunnel.token))
    }

    private fun prepareDownload(target: Connection, path: String, name: String) {
        if (download != null || !Regex("/api/family/files/[0-9a-f]{32}").matches(path) || !connectionTunnelAvailable(target)) return
        val fileName = name.replace(Regex("[\\\\/\\p{Cntrl}]"), "_").take(120).ifBlank { "Ficheiro Eddy" }
        download = Download(target, path)
        try { saveFile.launch(fileName) }
        catch (_: Exception) {
            download = null
            scheduleTunnelStop()
            Toast.makeText(this, "Não foi possível escolher onde guardar o ficheiro.", Toast.LENGTH_SHORT).show()
        }
    }

    private fun writeDownload(pending: Download, uri: Uri) {
        nativeDownloads++
        worker.execute {
            val success = try {
                if (!connectionTunnelAvailable(pending.connection)) throw IOException()
                val request = request(pending.connection, pending.path)
                try {
                    if (request.responseCode != 200) throw IOException()
                    val expected = request.contentLengthLong
                    val limit = 8L * 1024 * 1024 * 1024
                    if (expected !in 0..limit) throw IOException()
                    request.inputStream.use { input ->
                        val output = contentResolver.openOutputStream(uri, "wt") ?: throw IOException()
                        output.use {
                            val buffer = ByteArray(64 * 1024)
                            var received = 0L
                            while (true) {
                                val count = input.read(buffer)
                                if (count == -1) break
                                received += count
                                if (received > expected) throw IOException()
                                it.write(buffer, 0, count)
                            }
                            if (received != expected) throw IOException()
                        }
                    }
                } finally { request.disconnect() }
                true
            } catch (_: Exception) {
                try { DocumentsContract.deleteDocument(contentResolver, uri) } catch (_: Exception) { /* The provider can reject removal. */ }
                false
            }
            runOnUiThread {
                nativeDownloads = (nativeDownloads - 1).coerceAtLeast(0)
                if (!isDestroyed) {
                    Toast.makeText(this, if (success) "Ficheiro guardado." else "A transferência falhou. Volta a tentar.", Toast.LENGTH_SHORT).show()
                    scheduleTunnelStop()
                }
            }
        }
    }

    private fun closeWeb() {
        pickFiles?.onReceiveValue(null)
        pickFiles = null
        uploadInProgress = false
        val view = web ?: return
        web = null
        (view.parent as? ViewGroup)?.removeView(view)
        view.removeJavascriptInterface("EddyMobile")
        view.destroy()
    }

    override fun onDestroy() {
        generation++
        closeAuthorization()
        lifecycleHandler.removeCallbacksAndMessages(null)
        if (networkCallbackRegistered) {
            getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(networkCallback)
            networkCallbackRegistered = false
        }
        closeWeb()
        worker.shutdownNow()
        if (!isChangingConfigurations) {
            EmbeddedTunnel.stop(tunnelId)
        }
        super.onDestroy()
    }
}
