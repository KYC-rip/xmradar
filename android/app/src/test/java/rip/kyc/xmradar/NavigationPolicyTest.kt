package rip.kyc.xmradar

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import rip.kyc.xmradar.NavigationPolicy.Compartment
import rip.kyc.xmradar.NavigationPolicy.Decision

class NavigationPolicyTest {
    private val ownBase = "moz-extension://11111111-2222-3333-4444-555555555555/"

    @Test
    fun allowsXHostsInXCompartmentAndBlocksThirdPartyRedirects() {
        assertEquals(
            Decision.AllowInApp,
            NavigationPolicy.evaluate("https://x.com/home", Compartment.X, ownBase, hasUserGesture = false)
        )
        assertEquals(
            Decision.AllowInApp,
            NavigationPolicy.evaluate("https://mobile.x.com/XBToshi", Compartment.X, ownBase, hasUserGesture = true)
        )
        // t.co is NEVER loaded inside GeckoView; handed to system browser only on user gesture
        assertEquals(
            Decision.OpenExternalBrowser("https://t.co/abc123"),
            NavigationPolicy.evaluate("https://t.co/abc123", Compartment.X, ownBase, hasUserGesture = true)
        )
        assertTrue(
            NavigationPolicy.evaluate("https://t.co/abc123", Compartment.X, ownBase, hasUserGesture = false) is Decision.Deny
        )
        assertTrue(
            NavigationPolicy.evaluate("https://t.co/abc123", Compartment.X, ownBase, hasUserGesture = true, isRedirect = true) is Decision.Deny
        )
    }

    @Test
    fun scopesAuthHostsStrictlyToActiveXAuthFlow() {
        assertTrue(NavigationPolicy.isXAuthUrl("https://x.com/i/flow/login"))
        assertFalse(NavigationPolicy.isXAuthUrl("https://x.com/home"))
        assertTrue(NavigationPolicy.isXNonAuthUrl("https://x.com/XBToshi"))
        assertFalse(NavigationPolicy.isXNonAuthUrl("https://x.com/i/flow/login"))
        assertFalse(NavigationPolicy.isXNonAuthUrl("https://accounts.google.com/o/oauth2"))

        // Outside auth flow, accounts.google.com / arkoselabs.com / challenges.cloudflare.com are NOT allowed in X compartment
        assertTrue(
            NavigationPolicy.evaluate(
                "https://arkoselabs.com/challenge",
                Compartment.X,
                ownBase,
                hasUserGesture = false,
                inXAuthFlow = false,
            ) is Decision.Deny
        )
        assertTrue(
            NavigationPolicy.evaluate(
                "https://challenges.cloudflare.com/cdn-cgi/challenge-platform",
                Compartment.X,
                ownBase,
                hasUserGesture = false,
                inXAuthFlow = false,
            ) is Decision.Deny
        )
        // Inside active auth flow, they are allowed
        assertEquals(
            Decision.AllowInApp,
            NavigationPolicy.evaluate(
                "https://client-api.arkoselabs.com/challenge",
                Compartment.X,
                ownBase,
                hasUserGesture = false,
                inXAuthFlow = true,
            )
        )
        assertEquals(
            Decision.AllowInApp,
            NavigationPolicy.evaluate(
                "https://challenges.cloudflare.com/cdn-cgi/challenge-platform",
                Compartment.X,
                ownBase,
                hasUserGesture = false,
                inXAuthFlow = true,
            )
        )
    }

    @Test
    fun enforcesDefaultDenyOnDangerousAndUnknownSchemes() {
        val blocked = listOf(
            "http://x.com/home",
            "javascript:alert(1)",
            "intent://scan/#Intent;scheme=zxing;end",
            "file:///etc/hosts",
            "content://com.android.contacts/data",
            "data:text/html,<h1>hi</h1>",
            "blob:https://x.com/uuid",
            "nostrsigner:abc123",
            "tel:+1234567890",
            "sms:12345",
            "market://details?id=evil",
            "customscheme://payload",
        )
        for (url in blocked) {
            assertTrue(
                "Expected Deny for $url",
                NavigationPolicy.evaluate(url, Compartment.X, ownBase, hasUserGesture = true) is Decision.Deny
            )
        }
    }

    @Test
    fun enforcesOwnMozExtensionOriginAndGuardOnlyFromWebCompartments() {
        assertEquals(
            Decision.AllowInApp,
            NavigationPolicy.evaluate("${ownBase}popup.html", Compartment.EXTENSION, ownBase, hasUserGesture = false)
        )
        assertEquals(
            Decision.AllowInApp,
            NavigationPolicy.evaluate("${ownBase}guard.html", Compartment.SWAP, ownBase, hasUserGesture = false)
        )
        assertEquals(
            Decision.AllowInApp,
            NavigationPolicy.evaluate("${ownBase}guard.html#abc", Compartment.SWAP, ownBase, hasUserGesture = false)
        )
        assertEquals(
            Decision.AllowInApp,
            NavigationPolicy.evaluate("${ownBase}guard.html?x=1", Compartment.SWAP, ownBase, hasUserGesture = false)
        )
        assertTrue(
            NavigationPolicy.evaluate("${ownBase}guard.html.evil", Compartment.SWAP, ownBase, hasUserGesture = true) is Decision.Deny
        )
        assertTrue(
            NavigationPolicy.evaluate("${ownBase}guard.html/extra", Compartment.SWAP, ownBase, hasUserGesture = true) is Decision.Deny
        )
        assertTrue(
            NavigationPolicy.evaluate("${ownBase}options.html", Compartment.X, ownBase, hasUserGesture = true) is Decision.Deny
        )
        assertTrue(
            NavigationPolicy.evaluate("moz-extension://99999999-0000-0000-0000-000000000000/popup.html", Compartment.EXTENSION, ownBase, hasUserGesture = true) is Decision.Deny
        )
    }

    @Test
    fun isolatesCompartmentsAndValidatesSwapInput() {
        // Chat compartment only allows chat.xmr.club
        assertEquals(
            Decision.AllowInApp,
            NavigationPolicy.evaluate("https://chat.xmr.club/?room=x", Compartment.CHAT, ownBase, hasUserGesture = false)
        )
        assertTrue(
            NavigationPolicy.evaluate("https://x.com/home", Compartment.CHAT, ownBase, hasUserGesture = false) is Decision.Deny
        )

        // Swap compartment allows ecosystem + explicitly entered swap host only
        assertEquals(
            Decision.AllowInApp,
            NavigationPolicy.evaluate("https://trocador.app/en", Compartment.SWAP, ownBase, hasUserGesture = false, userAllowedSwapHosts = setOf("trocador.app"))
        )
        assertTrue(
            NavigationPolicy.evaluate("https://evil.example/", Compartment.SWAP, ownBase, hasUserGesture = false, userAllowedSwapHosts = setOf("trocador.app")) is Decision.Deny
        )

        assertEquals("https://trocador.app" to "trocador.app", NavigationPolicy.normalizeUserSwapInput("trocador.app"))
        assertNull(NavigationPolicy.normalizeUserSwapInput("http://trocador.app"))
        assertNull(NavigationPolicy.normalizeUserSwapInput("t.co/abc"))
        assertNull(NavigationPolicy.normalizeUserSwapInput("javascript:alert(1)"))
    }

    @Test
    fun requiresUserGestureAndValidChecksumForMoneroUris() {
        val validAddr = "44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A"
        val uri = "monero:$validAddr?tx_amount=0.01"

        assertTrue(
            NavigationPolicy.evaluate(uri, Compartment.X, ownBase, hasUserGesture = false) is Decision.Deny
        )
        assertTrue(
            NavigationPolicy.evaluate(uri, Compartment.X, ownBase, hasUserGesture = true, isRedirect = true) is Decision.Deny
        )
        val ok = NavigationPolicy.evaluate(uri, Compartment.X, ownBase, hasUserGesture = true)
        assertTrue(ok is Decision.ConfirmMoneroUri)
        assertEquals("0.01", (ok as Decision.ConfirmMoneroUri).parsed.amount)

        // Bad checksum rejected
        val badChecksum = validAddr.dropLast(1) + if (validAddr.last() == 'A') 'B' else 'A'
        assertTrue(
            NavigationPolicy.evaluate("monero:$badChecksum", Compartment.X, ownBase, hasUserGesture = true) is Decision.Deny
        )
    }
}
