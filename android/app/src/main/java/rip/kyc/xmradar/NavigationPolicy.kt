package rip.kyc.xmradar

import java.net.URI

/**
 * Default-deny navigation & scheme policy enforced in both `NavigationDelegate.onLoadRequest`
 * (including redirects) and `NavigationDelegate.onNewSession` (`window.open` / `target=_blank`)
 * across isolated GeckoView compartments (PLAN-ANDROID §2.4).
 */
object NavigationPolicy {

    enum class Compartment {
        X,
        CHAT,
        SWAP,
        EXTENSION,
    }

    sealed class Decision {
        data object AllowInApp : Decision()
        data class OpenExternalBrowser(val url: String) : Decision()
        data class ConfirmMoneroUri(val parsed: MoneroUriParser.ParsedMoneroUri) : Decision()
        data class OpenMailto(val uri: String) : Decision()
        data class Deny(val reason: String) : Decision()
    }

    private val X_HOSTS = setOf("x.com", "twitter.com", "twimg.com")
    /** X pages only (no twimg assets); used to validate external deep links and shares. */
    private val X_PAGE_HOSTS = setOf("x.com", "twitter.com")
    private val X_AUTH_HOSTS = setOf(
        "accounts.google.com",
        "appleid.apple.com",
        "arkoselabs.com",
        "funcaptcha.com",
        "challenges.cloudflare.com",
    )
    private val X_AUTH_PATH_PREFIXES = listOf(
        "/i/flow/login",
        "/i/flow/signup",
        "/login",
        "/account/access",
        "/i/oauth2",
    )
    private val CHAT_HOSTS = setOf("chat.xmr.club")
    private val ECOSYSTEM_SWAP_HOSTS = setOf("xmr.club", "xmr.bio", "nkips.org", "kyc.rip", "xmradar.app")

    fun isXAuthUrl(url: String?): Boolean {
        val u = parseUri(url ?: return false) ?: return false
        if (u.scheme?.lowercase() != "https") return false
        val host = u.host?.lowercase() ?: return false
        if (!matchesDomain(host, X_HOSTS)) return false
        val path = (u.rawPath ?: "").lowercase()
        return X_AUTH_PATH_PREFIXES.any { path.startsWith(it) }
    }

    /**
     * True for a plain https X page URL with no userinfo and the default port.
     * External intents are filtered through this before they reach the X compartment.
     */
    fun isXWebUrl(raw: String?): Boolean {
        val u = parseUri(raw?.trim() ?: return false) ?: return false
        if (u.scheme?.lowercase() != "https") return false
        if (!u.rawUserInfo.isNullOrEmpty()) return false
        if (u.port != -1 && u.port != 443) return false
        val host = u.host?.lowercase()?.trimEnd('.') ?: return false
        return matchesDomain(host, X_PAGE_HOSTS)
    }

    /** True when the X tab navigated to a normal (non-login) X page, so auth-flow hosts must close. */
    fun isXNonAuthUrl(url: String?): Boolean {
        val u = parseUri(url ?: return false) ?: return false
        if (u.scheme?.lowercase() != "https") return false
        val host = u.host?.lowercase() ?: return false
        if (!matchesDomain(host, X_HOSTS)) return false
        return !isXAuthUrl(url)
    }

    fun evaluate(
        rawUrl: String,
        compartment: Compartment,
        ownExtensionBaseUrl: String?,
        hasUserGesture: Boolean,
        isRedirect: Boolean = false,
        inXAuthFlow: Boolean = false,
        userAllowedSwapHosts: Set<String> = emptySet(),
    ): Decision {
        val trimmed = rawUrl.trim()
        if (trimmed.isEmpty()) return Decision.Deny("empty url")
        if (trimmed.equals("about:blank", ignoreCase = true)) return Decision.AllowInApp

        val scheme = extractScheme(trimmed) ?: return Decision.Deny("missing scheme")
        when (scheme) {
            "monero" -> {
                if (!hasUserGesture || isRedirect) {
                    return Decision.Deny("monero: requires direct user gesture")
                }
                return when (val parsed = MoneroUriParser.parse(trimmed)) {
                    is MoneroUriParser.ParseResult.Valid -> Decision.ConfirmMoneroUri(parsed.uri)
                    is MoneroUriParser.ParseResult.Invalid -> Decision.Deny("invalid monero uri: ${parsed.reason}")
                }
            }
            "mailto" -> {
                if (!hasUserGesture || isRedirect) return Decision.Deny("mailto: requires direct user gesture")
                return Decision.OpenMailto(trimmed)
            }
            "moz-extension" -> {
                val base = ownExtensionBaseUrl?.lowercase()
                if (base != null && trimmed.lowercase().startsWith(base)) {
                    // Only allow own extension origin; web pages in non-extension compartments
                    // may only navigate top-level to guard.html (from DNR redirect).
                    if (compartment == Compartment.EXTENSION) return Decision.AllowInApp
                    val rel = trimmed.substring(ownExtensionBaseUrl.length)
                    if (rel == "guard.html" || rel.startsWith("guard.html?") || rel.startsWith("guard.html#")) return Decision.AllowInApp
                    return Decision.Deny("non-extension compartment cannot navigate directly to $rel")
                }
                return Decision.Deny("foreign moz-extension origin")
            }
            "https" -> {
                val uri = parseUri(trimmed) ?: return Decision.Deny("malformed https url")
                if (!uri.rawUserInfo.isNullOrEmpty()) return Decision.Deny("userinfo not allowed")
                val host = uri.host?.lowercase()?.trimEnd('.') ?: return Decision.Deny("missing host")

                // Explicitly keep t.co out of the GeckoView cookie jar (prevents open-redirect leaks).
                if (host == "t.co" || host.endsWith(".t.co")) {
                    return if (hasUserGesture && !isRedirect) {
                        Decision.OpenExternalBrowser(trimmed)
                    } else {
                        Decision.Deny("t.co blocked without user gesture")
                    }
                }

                val allowedInCompartment = when (compartment) {
                    Compartment.X -> matchesDomain(host, X_HOSTS) ||
                        (inXAuthFlow && matchesDomain(host, X_AUTH_HOSTS))
                    Compartment.CHAT -> matchesDomain(host, CHAT_HOSTS)
                    Compartment.SWAP -> matchesDomain(host, ECOSYSTEM_SWAP_HOSTS) ||
                        matchesDomain(host, userAllowedSwapHosts)
                    Compartment.EXTENSION -> matchesDomain(host, ECOSYSTEM_SWAP_HOSTS) ||
                        matchesDomain(host, X_HOSTS) ||
                        matchesDomain(host, CHAT_HOSTS)
                }

                if (allowedInCompartment) return Decision.AllowInApp

                return if (hasUserGesture && !isRedirect) {
                    Decision.OpenExternalBrowser(trimmed)
                } else {
                    Decision.Deny("host $host not in compartment $compartment allowlist")
                }
            }
            else -> {
                // Default-deny all other schemes: http, javascript, intent, file, content, data,
                // blob, filesystem, ws, wss, tel, sms, geo, market, nostrsigner, etc.
                return Decision.Deny("blocked scheme: $scheme")
            }
        }
    }

    /** Normalizes a user-typed host or HTTPS URL from the Swap opener dialog into `https://...` and its host. */
    fun normalizeUserSwapInput(raw: String): Pair<String, String>? {
        val s = raw.trim()
        if (s.isEmpty() || s.any { it.isWhitespace() || it.code < 0x20 }) return null
        val withScheme = if ("://" in s) s else "https://$s"
        val uri = parseUri(withScheme) ?: return null
        if (uri.scheme?.lowercase() != "https") return null
        if (!uri.rawUserInfo.isNullOrEmpty()) return null
        val host = uri.host?.lowercase()?.trimEnd('.') ?: return null
        if (host.isEmpty() || "." !in host || host == "t.co" || host.endsWith(".t.co")) return null
        return uri.toASCIIString() to host
    }

    private fun extractScheme(url: String): String? {
        val idx = url.indexOf(':')
        if (idx <= 0) return null
        val s = url.substring(0, idx)
        if (!s.all { it.isLetterOrDigit() || it == '+' || it == '-' || it == '.' }) return null
        return s.lowercase()
    }

    private fun parseUri(url: String): URI? = try {
        URI(url)
    } catch (_: Exception) {
        null
    }

    private fun matchesDomain(host: String, allowlist: Set<String>): Boolean {
        for (entry in allowlist) {
            val d = entry.lowercase().trimEnd('.')
            if (host == d || host.endsWith(".$d")) return true
        }
        return false
    }
}
