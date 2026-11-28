package rip.kyc.xmradar

import java.net.URI
import java.net.URLDecoder

/**
 * Validates external entry points before they may steer the trusted X compartment
 * (PLAN-ANDROID §2.4): ACTION_VIEW deep links and ACTION_SEND shares.
 *
 * Only `https` X page links are accepted — never arbitrary hosts, schemes or userinfo —
 * so another app can't use MainActivity to load something else inside the cookie jar.
 */
object ExternalLink {
    const val SCHEME = "xmradar"
    const val HOST = "open"

    private const val MAX_LENGTH = 2048
    private const val MAX_SHARED_TEXT = 4096
    private val HTTP_URL = Regex("""https?://[^\s<>"']+""", RegexOption.IGNORE_CASE)
    private val BARE_X_URL = Regex("""(?<![./\w-])(?:www\.|mobile\.|m\.)?(?:x|twitter)\.com/[^\s<>"']+""", RegexOption.IGNORE_CASE)
    private const val TRAILING_PUNCTUATION = ".,;:!?)]}>'\"…"

    /** `xmradar://open?url=<encoded>` or an https X link from ACTION_VIEW. */
    fun fromViewUri(raw: String?): String? {
        val value = raw?.trim()?.takeIf { it.isNotEmpty() && it.length <= MAX_LENGTH } ?: return null
        return when (schemeOf(value)) {
            SCHEME -> fromCustomScheme(value)
            "https" -> xWebUrl(value)
            else -> null
        }
    }

    /** ACTION_SEND text/plain: the first X link in the shared text. */
    fun fromSharedText(raw: CharSequence?): String? {
        val text = raw?.toString()?.takeIf { it.length <= MAX_SHARED_TEXT } ?: return null
        for (match in HTTP_URL.findAll(text)) {
            xWebUrl(match.value)?.let { return it }
        }
        val bare = BARE_X_URL.find(text)?.value ?: return null
        return xWebUrl("https://$bare")
    }

    /** Normalizes and accepts only an https X page URL. */
    fun xWebUrl(raw: String?): String? {
        val value = raw?.trim()?.trimEnd(*TRAILING_PUNCTUATION.toCharArray())
            ?.takeIf { it.isNotEmpty() && it.length <= MAX_LENGTH } ?: return null
        return if (NavigationPolicy.isXWebUrl(value)) value else null
    }

    private fun fromCustomScheme(raw: String): String? {
        val uri = try {
            URI(raw)
        } catch (_: Exception) {
            return null
        }
        if (!SCHEME.equals(uri.scheme, ignoreCase = true)) return null
        if (!HOST.equals(uri.host, ignoreCase = true)) return null
        val query = uri.rawQuery ?: return null
        for (part in query.split('&')) {
            if (!part.substringBefore('=').equals("url", ignoreCase = true)) continue
            val encoded = part.substringAfter('=', "")
            if (encoded.isEmpty()) return null
            // URLDecoder treats '+' as a space; a literal '+' in a URL must survive.
            val decoded = try {
                // String charset overload: the Charset one is newer than minSdk 26 on Android.
                URLDecoder.decode(encoded.replace("+", "%2B"), "UTF-8")
            } catch (_: Exception) {
                return null
            }
            return xWebUrl(decoded)
        }
        return null
    }

    private fun schemeOf(value: String): String? {
        val idx = value.indexOf(':')
        if (idx <= 0) return null
        val scheme = value.substring(0, idx)
        if (!scheme.all { it.isLetterOrDigit() || it == '+' || it == '-' || it == '.' }) return null
        return scheme.lowercase()
    }
}
