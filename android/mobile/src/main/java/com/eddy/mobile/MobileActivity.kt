package com.eddy.mobile

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Bundle
import android.os.Build
import android.provider.DocumentsContract
import android.text.InputType
import android.util.Base64
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
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
import android.widget.CheckBox
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.FilterInputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL
import java.util.concurrent.Executors

class MobileActivity : ComponentActivity() {
    private data class Connection(val address: String, val user: String, val password: String) {
        val origin get() = "http://$address:8787"
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
    private lateinit var saved: SavedConnection
    private lateinit var addressInput: EditText
    private lateinit var userInput: EditText
    private lateinit var passwordInput: EditText
    private lateinit var remember: CheckBox
    private lateinit var status: TextView
    private lateinit var connectButton: Button
    private var web: WebView? = null
    private var connection: Connection? = null
    @Volatile private var generation = 0
    private var pickFiles: ValueCallback<Array<Uri>>? = null
    private var download: Download? = null

    private val picker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val selection = result.data?.clipData
        val files = if (result.resultCode == Activity.RESULT_OK && selection != null) {
            Array(selection.itemCount) { index -> selection.getItemAt(index).uri }
        } else WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
        pickFiles?.onReceiveValue(files?.filter { it.scheme == "content" }?.toTypedArray())
        pickFiles = null
    }
    private val saveFile = registerForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
        val pending = download
        download = null
        if (uri != null && pending != null) writeDownload(pending, uri)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        saved = SavedConnection(this)
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
                if (view == null) finish()
                else view.evaluateJavascript("window.EddyCloseOverlay && window.EddyCloseOverlay()") { closed ->
                    if (closed != "true") finish()
                }
            }
        })
        val password = saved.password()
        showConnection(password = password)
        if (password != null && vpnConnected()) connect()
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

    private fun LinearLayout.field(label: String, initial: String, hintText: String, secret: Boolean = false): EditText {
        label(label, 13f, muted, 16, true)
        val field = EditText(this@MobileActivity).apply {
            hint = hintText
            setSingleLine()
            inputType = InputType.TYPE_CLASS_TEXT or if (secret) InputType.TYPE_TEXT_VARIATION_PASSWORD else InputType.TYPE_TEXT_VARIATION_URI
            setText(initial)
            setTextColor(this@MobileActivity.textColor)
            setHintTextColor(muted)
            setPadding(dp(16), 0, dp(16), 0)
            textSize = 16f
            background = rounded(panel)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
            contentDescription = label
        }
        addView(field, LinearLayout.LayoutParams(-1, dp(52)).apply { topMargin = dp(6) })
        return field
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

    private fun showConnection(message: String = "", password: String? = connection?.password) {
        generation++
        closeWeb()
        val previous = connection
        val scroll = ScrollView(this).apply { isFillViewport = true }
        val stack = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(28), dp(22), dp(28), dp(22))
        }
        scroll.addView(stack, FrameLayout.LayoutParams(-1, -2))
        root.removeAllViews()
        root.addView(scroll, FrameLayout.LayoutParams(-1, -1))
        stack.label("Eddy", 17f, primary, 0, true)
        stack.label("Liga ao teu tablet", 34f, textColor, 22, true)
        stack.label("As tuas fotos e os ficheiros da família.", 16f, muted, 8)
        addressInput = stack.field("Endereço Tailscale do tablet", previous?.address ?: saved.address, "100.x.x.x")
        userInput = stack.field("Utilizador", previous?.user ?: saved.user, "eddy ou familia")
        passwordInput = stack.field("Palavra-passe da Eddy", password.orEmpty(), "Palavra-passe", secret = true)
        remember = CheckBox(this).apply {
            text = "Guardar neste telemóvel"
            setTextColor(muted)
            buttonTintList = ColorStateList.valueOf(primary)
            isChecked = password != null && saved.password() != null
        }
        stack.addView(remember, LinearLayout.LayoutParams(-1, dp(48)).apply { topMargin = dp(8) })
        status = stack.label(message, 14f, muted, 1).apply { accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE }
        connectButton = stack.action("Ligar", true, ::connect)
        stack.action("Abrir Tailscale", false) {
            val launch = packageManager.getLaunchIntentForPackage("com.tailscale.ipn")
            startActivity(launch ?: Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=com.tailscale.ipn")))
        }
        stack.isFocusableInTouchMode = true
        stack.requestFocus()
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

    private fun vpnConnected(): Boolean {
        val manager = getSystemService(ConnectivityManager::class.java)
        return manager.getNetworkCapabilities(manager.activeNetwork)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true
    }

    private fun connect() {
        val address = parseAddress(addressInput.text.toString().trim())
        if (address == null) { status.text = "Confirma o endereço Tailscale do tablet."; return }
        val user = userInput.text.toString().trim().lowercase()
        val password = passwordInput.text.toString()
        if (user !in listOf("eddy", "familia") || password.isEmpty()) {
            status.text = "Indica o teu utilizador e a palavra-passe da Eddy."
            return
        }
        if (!vpnConnected()) { status.text = "Liga o Tailscale e volta a tentar."; return }
        val candidate = Connection(address, user, password)
        val persist = remember.isChecked
        val session = ++generation
        connectButton.isEnabled = false
        status.text = "A ligar ao tablet…"
        getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(connectButton.windowToken, 0)
        worker.execute {
            val error = try {
                val request = request(candidate, "/api/session")
                try {
                    when (request.responseCode) {
                        200 -> {
                            val role = request.inputStream.bufferedReader().use { JSONObject(it.readLine()).optString("role") }
                            if (role in listOf("owner", "family")) null else "O tablet precisa da Eddy 2.5."
                        }
                        401, 403 -> "Confirma o utilizador e a palavra-passe."
                        404 -> "O tablet precisa da Eddy 2.5."
                        else -> "A Eddy do tablet ainda está a iniciar."
                    }
                } finally { request.disconnect() }
            } catch (_: Exception) { "O tablet não respondeu. Confirma se está ligado ao Tailscale." }
            runOnUiThread {
                if (session != generation || isFinishing || isDestroyed) return@runOnUiThread
                if (error != null) {
                    status.text = error
                    connectButton.isEnabled = true
                } else {
                    try { saved.save(candidate.address, candidate.user, password.takeIf { persist }) }
                    catch (_: Exception) { Toast.makeText(this, "Não foi possível guardar a palavra-passe.", Toast.LENGTH_SHORT).show() }
                    connection = candidate
                    showWeb(candidate)
                }
            }
        }
    }

    private fun request(target: Connection, path: String): HttpURLConnection =
        (URL(target.origin + path).openConnection(Proxy.NO_PROXY) as HttpURLConnection).apply {
            instanceFollowRedirects = false
            connectTimeout = 7000
            readTimeout = 15000
            setRequestProperty("Authorization", target.authorization)
        }

    private fun allowed(uri: Uri, target: Connection): Boolean =
        uri.scheme == "http" && uri.host == target.address && uri.port == 8787 && uri.userInfo == null

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

            @JavascriptInterface fun changeConnection() = runOnUiThread {
                if (session == generation && view === web) showConnection()
            }

            @JavascriptInterface fun download(path: String, name: String) = runOnUiThread {
                if (session == generation && view === web) prepareDownload(target, path, name)
            }
        }, "EddyMobile")
        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                !allowed(request.url, target) || request.url.path != "/"

            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                if (!allowed(request.url, target) || !vpnConnected() || session != generation) {
                    return WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))
                }
                if (request.method != "GET") return null
                // Supply this connection's account for every image and API read, including after changing accounts.
                return try {
                    val response = request(target, request.url.encodedPath.orEmpty())
                    val code = response.responseCode
                    val contentType = response.contentType?.substringBefore(';') ?: "application/octet-stream"
                    val headers = response.headerFields.filterKeys { it != null }.mapValues { it.value.joinToString(", ") }
                    val bytes = if (code < 400) response.inputStream else response.errorStream ?: ByteArrayInputStream(ByteArray(0))
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
                val knownHost = host == target.address || host == "${target.address}:8787"
                if (session == generation && knownHost && realm == "Eddy" && vpnConnected() && handler.useHttpAuthUsernamePassword()) {
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
        view.loadUrl(target.origin + "/", mapOf("Authorization" to target.authorization))
    }

    private fun prepareDownload(target: Connection, path: String, name: String) {
        if (download != null || !Regex("/api/family/files/[0-9a-f]{32}").matches(path) || !vpnConnected()) return
        val fileName = name.replace(Regex("[\\\\/\\p{Cntrl}]"), "_").take(120).ifBlank { "Ficheiro Eddy" }
        download = Download(target, path)
        saveFile.launch(fileName)
    }

    private fun writeDownload(pending: Download, uri: Uri) {
        worker.execute {
            val success = try {
                if (!vpnConnected()) throw IOException()
                val request = request(pending.connection, pending.path)
                try {
                    if (request.responseCode != 200) throw IOException()
                    val expected = request.contentLengthLong
                    val limit = 100L * 1024 * 1024
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
                Toast.makeText(this, if (success) "Ficheiro guardado." else "A transferência falhou. Volta a tentar.", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun closeWeb() {
        pickFiles?.onReceiveValue(null)
        pickFiles = null
        val view = web ?: return
        web = null
        (view.parent as? ViewGroup)?.removeView(view)
        view.removeJavascriptInterface("EddyMobile")
        view.destroy()
    }

    override fun onDestroy() {
        generation++
        closeWeb()
        worker.shutdownNow()
        super.onDestroy()
    }
}
