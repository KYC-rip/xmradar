package rip.kyc.xmradar

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ExternalLinkTest {
    @Test
    fun acceptsXPagesFromViewAndShare() {
        assertEquals("https://x.com/XBToshi/status/123", ExternalLink.fromViewUri("https://x.com/XBToshi/status/123"))
        assertEquals("https://twitter.com/XBToshi/status/9?s=20", ExternalLink.fromViewUri("https://twitter.com/XBToshi/status/9?s=20"))
        assertEquals("https://mobile.twitter.com/XBToshi", ExternalLink.fromViewUri("https://mobile.twitter.com/XBToshi"))
        assertEquals("https://x.com/home", ExternalLink.fromSharedText("Look at this https://x.com/home."))
    }

    @Test
    fun acceptsXLinkWithQueryInsideSharedText() {
        assertEquals(
            "https://twitter.com/XBToshi/status/123?s=20",
            ExternalLink.fromSharedText("Check this https://twitter.com/XBToshi/status/123?s=20"),
        )
    }

    @Test
    fun acceptsBareXLinkInSharedText() {
        assertEquals("https://x.com/XBToshi/status/7", ExternalLink.fromSharedText("x.com/XBToshi/status/7"))
    }

    @Test
    fun acceptsCustomSchemeDeepLink() {
        val encoded = "https%3A%2F%2Fx.com%2FXBToshi%2Fstatus%2F123%3Fs%3D20"
        assertEquals(
            "https://x.com/XBToshi/status/123?s=20",
            ExternalLink.fromViewUri("xmradar://open?url=$encoded"),
        )
    }

    @Test
    fun rejectsNonXAndUnsafeLinks() {
        assertNull(ExternalLink.fromViewUri("http://x.com/XBToshi")) // https only
        assertNull(ExternalLink.fromViewUri("https://t.co/abc123"))
        assertNull(ExternalLink.fromViewUri("https://pbs.twimg.com/media/x.jpg")) // X page hosts only
        assertNull(ExternalLink.fromViewUri("https://evil.example/x.com"))
        assertNull(ExternalLink.fromViewUri("https://x.com.evil.example/a"))
        assertNull(ExternalLink.fromViewUri("https://user@x.com/a"))
        assertNull(ExternalLink.fromViewUri("https://x.com:8443/a"))
        assertNull(ExternalLink.fromViewUri("javascript:alert(1)"))
        assertNull(ExternalLink.fromViewUri("xmradar://elsewhere?url=https%3A%2F%2Fx.com%2Fa"))
        assertNull(ExternalLink.fromViewUri("xmradar://open?url=https%3A%2F%2Ft.co%2Fabc"))
        assertNull(ExternalLink.fromViewUri("xmradar://open?next=https%3A%2F%2Fx.com%2Fa"))
    }

    @Test
    fun rejectsSharesWithNoXLink() {
        assertNull(ExternalLink.fromSharedText(null))
        assertNull(ExternalLink.fromSharedText(""))
        assertNull(ExternalLink.fromSharedText("no links here"))
        assertNull(ExternalLink.fromSharedText("https://example.com/x.com/status/1"))
        assertNull(ExternalLink.fromSharedText("https://t.co/abc123"))
    }
}
