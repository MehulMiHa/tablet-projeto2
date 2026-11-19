package com.example.tabletprojeto2

import android.app.Activity
import android.app.ActivityManager
import android.app.admin.DeviceAdminReceiver
import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.UserManager
import android.util.Log

/** Device-owner policies are applied only on the dedicated wall tablet. */
class EddyDeviceAdmin : DeviceAdminReceiver() {
    override fun onEnabled(context: Context, intent: Intent) { EddyKiosk.configure(context) }
}

internal object EddyKiosk {
    private const val SETTINGS = "eddy-kiosk"
    private val restrictions = arrayOf(
        UserManager.DISALLOW_SAFE_BOOT,
        UserManager.DISALLOW_FACTORY_RESET,
        UserManager.DISALLOW_ADD_USER,
        UserManager.DISALLOW_CREATE_WINDOWS
    )

    private fun policy(context: Context) = context.getSystemService(DevicePolicyManager::class.java)
    private fun admin(context: Context) = ComponentName(context, EddyDeviceAdmin::class.java)
    fun enabled(context: Context): Boolean = policy(context).isDeviceOwnerApp(context.packageName) &&
        context.getSharedPreferences(SETTINGS, Context.MODE_PRIVATE).getBoolean("enabled", true)

    fun configure(context: Context) {
        val manager = policy(context)
        if (!manager.isDeviceOwnerApp(context.packageName)) return
        val component = admin(context)
        val active = enabled(context)
        for (restriction in restrictions) {
            if (active) manager.addUserRestriction(component, restriction)
            else manager.clearUserRestriction(component, restriction)
        }
        manager.setUninstallBlocked(component, context.packageName, active)
        manager.setStatusBarDisabled(component, active)
        // Keep the physical power menu available; navigation and notifications stay blocked.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) manager.setLockTaskFeatures(component, DevicePolicyManager.LOCK_TASK_FEATURE_GLOBAL_ACTIONS)
        manager.setLockTaskPackages(component, if (active) arrayOf(context.packageName) else emptyArray())
        if (active) {
            val home = IntentFilter(Intent.ACTION_MAIN).apply {
                addCategory(Intent.CATEGORY_HOME); addCategory(Intent.CATEGORY_DEFAULT)
            }
            manager.addPersistentPreferredActivity(component, home, ComponentName(context, MainActivity::class.java))
        } else manager.clearPackagePersistentPreferredActivities(component, context.packageName)
    }

    fun enter(activity: Activity) {
        if (!enabled(activity)) return
        try {
            configure(activity)
            val state = activity.getSystemService(ActivityManager::class.java).lockTaskModeState
            if (state != ActivityManager.LOCK_TASK_MODE_LOCKED && policy(activity).isLockTaskPermitted(activity.packageName)) activity.startLockTask()
        } catch (error: RuntimeException) { Log.e("EddyKiosk", "Could not enter managed kiosk", error) }
    }

    fun setEnabled(context: Context, value: Boolean) {
        check(policy(context).isDeviceOwnerApp(context.packageName)) { "Eddy is not the device owner." }
        context.getSharedPreferences(SETTINGS, Context.MODE_PRIVATE).edit().putBoolean("enabled", value).commit()
        configure(context)
    }

    @Suppress("DEPRECATION")
    fun removeOwner(context: Context) {
        setEnabled(context, false)
        policy(context).clearDeviceOwnerApp(context.packageName)
    }
}

/** No in-app exit: only Android's privileged shell/system can send this receiver. */
class EddyMaintenanceReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        try {
            when (intent.getStringExtra("operation")) {
                "pause" -> EddyKiosk.setEnabled(context, false)
                "resume" -> {
                    EddyKiosk.setEnabled(context, true)
                    context.startActivity(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP))
                }
                "remove-owner" -> EddyKiosk.removeOwner(context)
                else -> { resultCode = Activity.RESULT_CANCELED; resultData = "Unknown maintenance operation"; return }
            }
            resultCode = Activity.RESULT_OK
            resultData = "Maintenance operation completed"
        } catch (error: RuntimeException) {
            Log.e("EddyKiosk", "Maintenance operation failed", error)
            resultCode = Activity.RESULT_CANCELED; resultData = "Maintenance operation failed"
        }
    }
}
