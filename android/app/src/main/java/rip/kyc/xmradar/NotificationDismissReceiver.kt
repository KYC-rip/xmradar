package rip.kyc.xmradar

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Non-exported receiver for notification swipe-dismissals so GeckoView / XMRadar extension
 * receives `WebNotification.dismiss()` without launching MainActivity.
 */
class NotificationDismissReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action != NotificationBridge.ACTION_DISMISS) return
        val id = intent.getIntExtra(NotificationBridge.EXTRA_NOTIF_ID, 0)
        val token = intent.getStringExtra(NotificationBridge.EXTRA_NOTIF_TOKEN)
        if (id == 0 || token.isNullOrEmpty()) return
        val entry = NotificationRegistry.takeIfTokenMatches(id, token) ?: return
        try {
            entry.notification.dismiss()
        } catch (_: Exception) {
            // Runtime or notification may already be disposed.
        }
    }
}
