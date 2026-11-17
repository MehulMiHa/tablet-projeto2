package com.example.tabletprojeto2

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.SystemClock
import android.util.Log
import androidx.core.content.ContextCompat
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/** Keeps the local process available independently of the home devices' connectivity. */
internal class LocalServerWatchdog(private val context: Context) : AutoCloseable {
    private val executor = Executors.newSingleThreadScheduledExecutor { task ->
        Thread(task, "EddyServerWatchdog").apply { isDaemon = true }
    }
    private var scheduledCheck: ScheduledFuture<*>? = null
    private var nextStartAt = 0L
    private var startBackoff = INITIAL_BACKOFF_MS
    private var previouslyUnavailable = false

    @Volatile private var closed = false
    @Volatile private var connection: HttpURLConnection? = null

    @Synchronized
    fun start() {
        if (closed || scheduledCheck != null) return
        scheduledCheck = executor.scheduleWithFixedDelay(::checkHealth, 0, 15, TimeUnit.SECONDS)
    }

    private fun checkHealth() {
        if (closed) return
        val healthy = try {
            val startedAt = SystemClock.elapsedRealtime()
            val request = URL(HEALTH_URL).openConnection() as HttpURLConnection
            connection = request
            request.apply {
                requestMethod = "GET"
                instanceFollowRedirects = false
                useCaches = false
                connectTimeout = HEALTH_DEADLINE_MS
                readTimeout = HEALTH_DEADLINE_MS
            }
            request.connect()
            val remaining = HEALTH_DEADLINE_MS - (SystemClock.elapsedRealtime() - startedAt)
            if (remaining <= 0) false else {
                request.readTimeout = remaining.toInt()
                request.responseCode in 200..299
            }
        } catch (_: Exception) {
            false
        } finally {
            connection?.disconnect()
            connection = null
        }
        if (closed) return
        if (healthy) {
            if (previouslyUnavailable) Log.i(TAG, "Local server is available again")
            previouslyUnavailable = false
            nextStartAt = 0
            startBackoff = INITIAL_BACKOFF_MS
            return
        }
        previouslyUnavailable = true
        val now = SystemClock.elapsedRealtime()
        if (now < nextStartAt) return
        nextStartAt = now + startBackoff
        startBackoff = minOf(MAX_BACKOFF_MS, startBackoff * 2)
        startServer()
    }

    private fun startServer() {
        if (closed) return
        if (ContextCompat.checkSelfPermission(context, TERMUX_PERMISSION) != PackageManager.PERMISSION_GRANTED) {
            Log.w(TAG, "Local server unavailable; Termux RUN_COMMAND permission is required")
            return
        }
        val intent = Intent("com.termux.RUN_COMMAND").apply {
            setClassName("com.termux", "com.termux.app.RunCommandService")
            putExtra("com.termux.RUN_COMMAND_PATH", "/data/data/com.termux/files/usr/bin/sh")
            putExtra("com.termux.RUN_COMMAND_ARGUMENTS", arrayOf(START_SCRIPT))
            putExtra("com.termux.RUN_COMMAND_WORKDIR", "/data/data/com.termux/files/home")
            putExtra("com.termux.RUN_COMMAND_BACKGROUND", true)
        }
        try {
            val service = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
            if (service == null) Log.w(TAG, "Termux command service is unavailable")
            else Log.i(TAG, "Requested local server startup through Termux")
        } catch (error: SecurityException) {
            Log.w(TAG, "Termux rejected local server startup", error)
        } catch (error: IllegalStateException) {
            Log.w(TAG, "Android deferred local server startup", error)
        }
    }

    @Synchronized
    override fun close() {
        closed = true
        scheduledCheck?.cancel(true)
        scheduledCheck = null
        connection?.disconnect()
        executor.shutdownNow()
    }

    companion object {
        private const val TAG = "EddyServerWatchdog"
        private const val HEALTH_URL = "http://127.0.0.1:3000/api/health"
        private const val HEALTH_DEADLINE_MS = 2_000
        private const val INITIAL_BACKOFF_MS = 30_000L
        private const val MAX_BACKOFF_MS = 300_000L
        private const val TERMUX_PERMISSION = "com.termux.permission.RUN_COMMAND"
        private const val START_SCRIPT = "/data/data/com.termux/files/home/.termux/boot/start-eddy.sh"
    }
}
