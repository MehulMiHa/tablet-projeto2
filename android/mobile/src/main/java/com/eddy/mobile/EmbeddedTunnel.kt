package com.eddy.mobile

import android.content.Context
import android.net.Uri
import android.util.Log
import eddytunnel.Client
import eddytunnel.Eddytunnel
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** One userspace tunnel per app process; no Android VPN or device-wide network binding. */
internal object EmbeddedTunnel {
    data class Snapshot(
        val id: Long = 0,
        val target: String = "",
        val state: String = "stopped",
        val authURL: String = "",
        val origin: String = "",
        val token: String = ""
    )

    private val worker = Executors.newSingleThreadExecutor()
    private val refreshQueued = AtomicBoolean(false)
    private val networkChangeQueued = AtomicBoolean(false)
    @Volatile private var current = Snapshot()
    private var client: Client? = null
    private var nativeTarget = ""

    @Synchronized fun start(context: Context, target: String): Long {
        val old = current
        val id = old.id + 1
        setCurrent(if (old.target == target && old.state in setOf("running", "starting", "needs-login")) old.copy(id = id)
            else Snapshot(id = id, target = target, state = "starting"))
        val stateDirectory = File(context.applicationContext.noBackupFilesDir, "private-network").absolutePath
        worker.execute {
            if (current.id != id) return@execute
            try {
                val active = client ?: Eddytunnel.newClient().also { client = it }
                if (nativeTarget != target || active.status() in setOf("stopped", "error")) {
                    active.stop()
                    active.start(stateDirectory, target)
                    nativeTarget = target
                }
                publish(id, target, active)
            } catch (_: Exception) { fail(id, target) }
            catch (_: LinkageError) { fail(id, target) }
        }
        return id
    }

    fun snapshot(id: Long): Snapshot {
        val cached = current
        if (cached.id == id && cached.target.isNotEmpty() && refreshQueued.compareAndSet(false, true)) {
            worker.execute {
                try {
                    if (current.id == id) client?.let { publish(id, cached.target, it) }
                } catch (_: Exception) { fail(id, cached.target) }
                finally { refreshQueued.set(false) }
            }
        }
        return cached
    }

    fun available(snapshot: Snapshot): Boolean {
        val now = current
        return now.id == snapshot.id && now.state == "running" && now.origin == snapshot.origin && now.token == snapshot.token && now.token.isNotEmpty()
    }

    fun networkChanged(id: Long) {
        if (current.id != id || current.target.isEmpty() || !networkChangeQueued.compareAndSet(false, true)) return
        worker.execute {
            try { if (current.id == id) client?.networkChanged() }
            catch (_: Exception) { /* A subsequent state poll reports whether the connection recovered. */ }
            finally { networkChangeQueued.set(false) }
        }
    }

    @Synchronized fun stop(id: Long) {
        if (current.id != id) return
        val stopped = id + 1
        setCurrent(Snapshot(id = stopped))
        worker.execute {
            if (current.id == stopped && current.target.isEmpty()) {
                try { client?.stop(); Log.i("EddyTunnel", "Private transport stopped") }
                catch (_: Exception) { Log.w("EddyTunnel", "Private transport stop failed") }
                finally { nativeTarget = "" }
            }
        }
    }

    private fun publish(id: Long, target: String, active: Client) {
        val state = active.status().takeIf { it in setOf("starting", "needs-login", "running", "stopped", "error") } ?: "error"
        val origin = active.proxyURL().trimEnd('/')
        val token = active.proxyToken()
        val uri = Uri.parse(origin)
        val local = uri.scheme == "http" && uri.host == "127.0.0.1" && uri.port in 1..65535 &&
            uri.userInfo == null && uri.query == null && uri.fragment == null && uri.path.isNullOrEmpty()
        if (state == "running" && (!local || !Regex("[A-Za-z0-9_-]{32,128}").matches(token))) {
            fail(id, target)
            return
        }
        synchronized(this) {
            if (current.id == id) setCurrent(Snapshot(id, target, state, active.authURL(), if (local) origin else "", token))
        }
    }

    private fun fail(id: Long, target: String) {
        synchronized(this) { if (current.id == id) setCurrent(Snapshot(id = id, target = target, state = "error")) }
    }

    private fun setCurrent(next: Snapshot) {
        val changed = current.state != next.state
        current = next
        if (changed) Log.i("EddyTunnel", "Private transport state: ${next.state}")
    }
}
