package rip.kyc.xmradar

import org.mozilla.geckoview.WebNotification
import rip.kyc.xmradar.NavigationPolicy.Compartment
import java.net.URI
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger

/**
 * Pure Kotlin policy, sanitization, and process-wide registry for GeckoView `WebNotification`s
 * (both XMRadar extension notifications and X / Chat PWA notifications).
 *
 * Security boundaries:
 * - Strictly denies `privateBrowsing == true` (private Swap tabs never emit OS notifications).
 * - Allowlists ONLY own `moz-extension://`, first-party X (`x.com` / `twitter.com`), and `chat.xmr.club`.
 * - Every `PendingIntent` carries a per-process random UUID token validated against `NotificationRegistry`
 *   so external apps cannot forge notification click/dismiss actions into `MainActivity`.
 */
object NotificationBridge {

    const val CHANNEL_XMRADAR = "xmradar_activity"
    const val CHANNEL_WEB = "xmradar_web"

    const val ACTION_DISMISS = "rip.kyc.xmradar.ACTION_NOTIFICATION_DISMISS"
    const val EXTRA_NOTIF_ID = "xmradar_notif_id"
    const val EXTRA_NOTIF_TOKEN = "xmradar_notif_token"

    const val MAX_TITLE_CHARS = 200
    const val MAX_BODY_CHARS = 1_000
    const val MAX_ACTIVE_NOTIFICATIONS = 64

    private val ALLOWED_X_HOSTS = setOf(
        "x.com", "www.x.com", "mobile.x.com",
        "twitter.com", "www.twitter.com", "mobile.twitter.com",
    )
    private const val CHAT_HOST = "chat.xmr.club"

    data class NotificationTarget(
        val channelId: String,
        val compartment: Compartment,
        val defaultTitle: String,
        val originKey: String,
    )

    data class ActiveNotification(
        val id: Int,
        val token: String,
        val target: NotificationTarget,
        val tag: String?,
        val notification: WebNotification,
    )

    /**
     * Classifies a GeckoView `WebNotification` into its channel + compartment, or returns `null`
     * if the notification is disallowed (private browsing or non-allowlisted origin).
     */
    fun classifyNotification(
        origin: String?,
        source: String?,
        ownExtensionBaseUrl: String?,
        privateBrowsing: Boolean,
    ): NotificationTarget? {
        if (privateBrowsing) return null

        val ownOrigin = normalizeExtensionOrigin(ownExtensionBaseUrl)
        val candidates = listOfNotNull(
            origin?.trim()?.takeIf { it.isNotEmpty() },
            source?.trim()?.takeIf { it.isNotEmpty() },
        )

        // Built-in WebExtension `browser.notifications.create` provides our own moz-extension origin/source.
        if (ownOrigin != null && candidates.any { normalizeExtensionOrigin(it) == ownOrigin }) {
            return NotificationTarget(
                channelId = CHANNEL_XMRADAR,
                compartment = Compartment.EXTENSION,
                defaultTitle = "XMRadar",
                originKey = ownOrigin,
            )
        }

        // Check HTTPS web PWA origins (X and Chat only).
        for (raw in candidates) {
            val host = parseHttpsHost(raw) ?: continue
            if (host in ALLOWED_X_HOSTS) {
                return NotificationTarget(
                    channelId = CHANNEL_WEB,
                    compartment = Compartment.X,
                    defaultTitle = "X",
                    originKey = "https://x.com",
                )
            }
            if (host == CHAT_HOST) {
                return NotificationTarget(
                    channelId = CHANNEL_WEB,
                    compartment = Compartment.CHAT,
                    defaultTitle = "XMRadar Chat",
                    originKey = "https://chat.xmr.club",
                )
            }
        }
        return null
    }

    /**
     * Validates whether a `PERMISSION_DESKTOP_NOTIFICATION` content permission request may be
     * offered to the user. Rejects private browsing, third-party iframes, and non-allowlisted hosts.
     */
    fun allowedPermissionOriginKey(
        rawUri: String?,
        ownExtensionBaseUrl: String?,
        privateMode: Boolean,
        thirdPartyOrigin: String?,
    ): String? {
        if (privateMode) return null
        if (!thirdPartyOrigin.isNullOrBlank()) return null
        val uri = rawUri?.trim()?.takeIf { it.isNotEmpty() } ?: return null

        val ownOrigin = normalizeExtensionOrigin(ownExtensionBaseUrl)
        if (ownOrigin != null && normalizeExtensionOrigin(uri) == ownOrigin) {
            return ownOrigin
        }
        val host = parseHttpsHost(uri) ?: return null
        return when {
            host in ALLOWED_X_HOSTS -> "https://x.com"
            host == CHAT_HOST -> "https://chat.xmr.club"
            else -> null
        }
    }

    fun sanitizeText(raw: String?, maxLen: Int, fallback: String = ""): String {
        if (raw.isNullOrBlank()) return fallback
        val cleaned = buildString(raw.length.coerceAtMost(maxLen)) {
            var lastWasSpace = false
            for (ch in raw) {
                if (ch.code < 0x20 || ch.code == 0x7f) {
                    if ((ch == '\n' || ch == '\r' || ch == '\t') && !lastWasSpace && isNotEmpty()) {
                        append(' ')
                        lastWasSpace = true
                    }
                    continue
                }
                // Strip invisible Unicode bidi/format overrides (e.g. U+202E RLO).
                if (Character.getType(ch) == Character.FORMAT.toInt()) {
                    continue
                }
                if (length + 1 == maxLen && Character.isHighSurrogate(ch)) {
                    break
                }
                append(ch)
                lastWasSpace = ch == ' '
                if (length >= maxLen) break
            }
        }.trim()
        return cleaned.ifEmpty { fallback }
    }

    private val untaggedSeq = AtomicInteger(1_000_000)

    /**
     * Positive Android notification ID: deterministic per `(originKey, tag)` so tagged updates
     * replace cleanly, and monotonically allocated for untagged notifications so distinct alerts
     * (e.g. multiple Xaps/xos) stack instead of overwriting each other.
     */
    fun notificationIdFor(originKey: String, tag: String?): Int {
        if (tag.isNullOrBlank()) {
            val next = untaggedSeq.getAndIncrement() and 0x7fffffff
            return if (next == 0) 1 else next
        }
        val key = "$originKey\u0000$tag"
        val hash = key.hashCode() and 0x7fffffff
        return if (hash == 0) 1 else hash
    }

    private fun normalizeExtensionOrigin(baseUrl: String?): String? {
        if (baseUrl.isNullOrBlank()) return null
        return try {
            val u = URI(baseUrl.trim())
            if (!u.scheme.equals("moz-extension", ignoreCase = true) || u.host.isNullOrBlank()) return null
            "moz-extension://${u.host.lowercase()}"
        } catch (_: Exception) {
            null
        }
    }

    private fun parseHttpsHost(raw: String): String? {
        return try {
            val u = URI(raw)
            if (!u.scheme.equals("https", ignoreCase = true)) return null
            if (!u.userInfo.isNullOrEmpty()) return null
            if (u.port != -1 && u.port != 443) return null
            u.host?.lowercase()?.trimEnd('.')?.takeIf { it.isNotEmpty() }
        } catch (_: Exception) {
            null
        }
    }
}

/**
 * Process-wide bounded store of live `WebNotification` handles, gated by per-notification random tokens.
 */
object NotificationRegistry {
    data class RegisterResult(
        val token: String,
        val evicted: List<NotificationBridge.ActiveNotification>,
    )

    private val active = LinkedHashMap<Int, NotificationBridge.ActiveNotification>()
    private val superseded = ArrayDeque<WebNotification>()
    private const val MAX_SUPERSEDED = 128

    private fun markSuperseded(old: WebNotification) {
        if (superseded.any { it === old }) return
        while (superseded.size >= MAX_SUPERSEDED) {
            superseded.removeFirst()
        }
        superseded.addLast(old)
    }

    private fun consumeSuperseded(notification: WebNotification): Boolean {
        val it = superseded.iterator()
        while (it.hasNext()) {
            if (it.next() === notification) {
                it.remove()
                return true
            }
        }
        return false
    }

    @Synchronized
    fun register(
        id: Int,
        target: NotificationBridge.NotificationTarget,
        tag: String?,
        notification: WebNotification,
    ): RegisterResult {
        val token = UUID.randomUUID().toString()
        val replaced = active.remove(id)
        if (replaced != null && replaced.notification !== notification) {
            markSuperseded(replaced.notification)
        }
        val evicted = mutableListOf<NotificationBridge.ActiveNotification>()
        while (active.size >= NotificationBridge.MAX_ACTIVE_NOTIFICATIONS) {
            val oldestKey = active.entries.firstOrNull()?.key ?: break
            active.remove(oldestKey)?.let { evicted.add(it) }
        }
        active[id] = NotificationBridge.ActiveNotification(id, token, target, tag?.takeIf { it.isNotBlank() }, notification)
        return RegisterResult(token, evicted)
    }

    @Synchronized
    fun takeIfTokenMatches(id: Int, token: String?): NotificationBridge.ActiveNotification? {
        if (token.isNullOrEmpty()) return null
        val cur = active[id] ?: return null
        if (cur.token != token) return null
        active.remove(id)
        return cur
    }

    @Synchronized
    fun remove(id: Int) {
        active.remove(id)
    }

    @Synchronized
    fun removeByNotificationOrTag(
        notification: WebNotification,
        originKey: String?,
        tag: String?,
    ): Int? {
        if (consumeSuperseded(notification)) return null
        val byRef = active.entries.firstOrNull { it.value.notification === notification }
        if (byRef != null) {
            active.remove(byRef.key)
            return byRef.key
        }
        val cleanTag = tag?.takeIf { it.isNotBlank() } ?: return null
        if (originKey.isNullOrBlank()) return null
        val byTag = active.entries.firstOrNull {
            it.value.target.originKey == originKey && it.value.tag == cleanTag
        } ?: return null
        active.remove(byTag.key)
        return byTag.key
    }

    @Synchronized
    fun clear() {
        active.clear()
        superseded.clear()
    }
}
