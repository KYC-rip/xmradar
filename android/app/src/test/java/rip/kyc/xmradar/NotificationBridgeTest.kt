package rip.kyc.xmradar

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import rip.kyc.xmradar.NavigationPolicy.Compartment

class NotificationBridgeTest {

    private val ownBase = "moz-extension://12345678-1234-4321-abcd-1234567890ab/"

    @Test
    fun classifiesOwnExtensionNotifications() {
        val target = NotificationBridge.classifyNotification(
            origin = "moz-extension://12345678-1234-4321-abcd-1234567890ab",
            source = "moz-extension://12345678-1234-4321-abcd-1234567890ab/background.js",
            ownExtensionBaseUrl = ownBase,
            privateBrowsing = false,
        )
        assertNotNull(target)
        assertEquals(NotificationBridge.CHANNEL_XMRADAR, target!!.channelId)
        assertEquals(Compartment.EXTENSION, target.compartment)
        assertEquals("XMRadar", target.defaultTitle)
    }

    @Test
    fun rejectsForeignExtensionNotificationsIncludingPrefixCollisions() {
        assertNull(
            NotificationBridge.classifyNotification(
                origin = "moz-extension://99999999-1234-4321-abcd-1234567890ab",
                source = null,
                ownExtensionBaseUrl = ownBase,
                privateBrowsing = false,
            ),
        )
        assertNull(
            NotificationBridge.classifyNotification(
                origin = "moz-extension://12345678-1234-4321-abcd-1234567890ab-evil",
                source = null,
                ownExtensionBaseUrl = ownBase,
                privateBrowsing = false,
            ),
        )
    }

    @Test
    fun classifiesFirstPartyXAndChatNotifications() {
        val xTarget = NotificationBridge.classifyNotification(
            origin = "https://mobile.x.com",
            source = "https://mobile.x.com/sw.js",
            ownExtensionBaseUrl = ownBase,
            privateBrowsing = false,
        )
        assertNotNull(xTarget)
        assertEquals(NotificationBridge.CHANNEL_WEB, xTarget!!.channelId)
        assertEquals(Compartment.X, xTarget.compartment)
        assertEquals("https://x.com", xTarget.originKey)

        val chatTarget = NotificationBridge.classifyNotification(
            origin = "https://chat.xmr.club",
            source = null,
            ownExtensionBaseUrl = ownBase,
            privateBrowsing = false,
        )
        assertNotNull(chatTarget)
        assertEquals(NotificationBridge.CHANNEL_WEB, chatTarget!!.channelId)
        assertEquals(Compartment.CHAT, chatTarget.compartment)
        assertEquals("https://chat.xmr.club", chatTarget.originKey)
    }

    @Test
    fun rejectsPrivateBrowsingAndDisallowedWebOrigins() {
        assertNull(
            NotificationBridge.classifyNotification(
                origin = "https://x.com",
                source = null,
                ownExtensionBaseUrl = ownBase,
                privateBrowsing = true,
            ),
        )
        assertNull(
            NotificationBridge.classifyNotification(
                origin = ownBase,
                source = null,
                ownExtensionBaseUrl = ownBase,
                privateBrowsing = true,
            ),
        )
        for (bad in listOf(
            "http://x.com",
            "https://x.com:8443",
            "https://user:pass@x.com",
            "https://t.co",
            "https://evil.x.com.attacker.test",
            "https://kyc.rip",
            "javascript:alert(1)",
        )) {
            assertNull("Should reject $bad", NotificationBridge.classifyNotification(bad, null, ownBase, false))
        }
    }

    @Test
    fun permissionOriginAllowlistRejectsPrivateAndThirdParty() {
        assertEquals(
            "https://x.com",
            NotificationBridge.allowedPermissionOriginKey("https://x.com/home", ownBase, false, null),
        )
        assertEquals(
            "https://chat.xmr.club",
            NotificationBridge.allowedPermissionOriginKey("https://chat.xmr.club/?embed=1", ownBase, false, null),
        )
        assertEquals(
            "moz-extension://12345678-1234-4321-abcd-1234567890ab",
            NotificationBridge.allowedPermissionOriginKey("${ownBase}options.html", ownBase, false, null),
        )

        assertNull(NotificationBridge.allowedPermissionOriginKey("https://x.com/home", ownBase, true, null))
        assertNull(NotificationBridge.allowedPermissionOriginKey("https://x.com/home", ownBase, false, "https://ads.example"))
        assertNull(NotificationBridge.allowedPermissionOriginKey("https://trocador.app", ownBase, false, null))
        assertNull(NotificationBridge.allowedPermissionOriginKey("http://x.com/home", ownBase, false, null))
    }

    @Test
    fun sanitizeTextStripsControlCharsBidiOverridesAndCapsLength() {
        assertEquals("Fallback", NotificationBridge.sanitizeText("  \u0000\n\t ", 50, "Fallback"))
        assertEquals("New Xap +0.05 XMR", NotificationBridge.sanitizeText("New Xap\u0000\r\n\t+0.05 XMR", 50, ""))
        assertEquals("safe text", NotificationBridge.sanitizeText("safe\u202E text\u200B", 50, ""))
        assertEquals("12345", NotificationBridge.sanitizeText("1234567890", 5, ""))
        // Do not split a UTF-16 surrogate pair at maxLen boundary.
        val emoji = "\uD83D\uDD25"
        assertEquals("ab", NotificationBridge.sanitizeText("ab${emoji}c", 3, ""))
    }

    @Test
    fun notificationIdIsDeterministicForTaggedAndUniqueForUntagged() {
        val id1 = NotificationBridge.notificationIdFor("https://x.com", "dm-42")
        val id2 = NotificationBridge.notificationIdFor("https://x.com", "dm-42")
        val id3 = NotificationBridge.notificationIdFor("https://x.com", "dm-43")
        val id4 = NotificationBridge.notificationIdFor("https://chat.xmr.club", "dm-42")
        val untagged1 = NotificationBridge.notificationIdFor("https://x.com", null)
        val untagged2 = NotificationBridge.notificationIdFor("https://x.com", null)

        assertEquals(id1, id2)
        assertTrue(id1 > 0 && id3 > 0 && id4 > 0 && untagged1 > 0 && untagged2 > 0)
        assertNotEquals(id1, id3)
        assertNotEquals(id1, id4)
        assertNotEquals(untagged1, untagged2)
    }
}
