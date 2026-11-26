package rip.kyc.xmradar

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SiteCatalogTest {

    // Minimal valid 34-byte RIFF/WEBP header + payload (base64).
    private val validWebpDataUri =
        "data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA="

    private fun samplePayload(): JSONObject = JSONObject().apply {
        put("type", "sync_site_catalog")
        put("issuedAt", 1_760_000_000L)
        put(
            "sites",
            JSONArray().apply {
                put(
                    JSONObject().apply {
                        put("id", "trocador")
                        put("name", "Trocador")
                        put("category", "swap-aggregator")
                        put("grade", "A")
                        put("incident", false)
                        put("intern", false)
                        put("internHoldsFunds", false)
                        put("hosts", JSONArray(listOf("www.trocador.app", "trocador.app", "github.com")))
                        put("nkip01Level", 3)
                        put("logOnly", false)
                        put("hasLog", true)
                        put("logo", validWebpDataUri)
                    },
                )
                put(
                    JSONObject().apply {
                        put("id", "kycrip-swap")
                        put("name", "KYC.rip Swap")
                        put("category", "swap")
                        put("grade", "A+")
                        put("incident", false)
                        put("intern", false)
                        put("internHoldsFunds", false)
                        put("hosts", JSONArray(listOf("kyc.rip")))
                        put("nkip01Level", 3)
                        put("logOnly", false)
                        put("hasLog", true)
                    },
                )
                put(
                    JSONObject().apply {
                        put("id", "kycrip-card")
                        put("name", "KYC.rip Card")
                        put("category", "card")
                        put("grade", "B")
                        put("incident", false)
                        put("intern", false)
                        put("internHoldsFunds", false)
                        put("hosts", JSONArray(listOf("kyc.rip")))
                        put("nkip01Level", JSONObject.NULL)
                        put("logOnly", false)
                        put("hasLog", false)
                    },
                )
                put(
                    JSONObject().apply {
                        put("id", "shady-swap")
                        put("name", "ShadySwap")
                        put("category", "swap")
                        put("grade", "F")
                        put("url", "https://xmr.club/exchanges/shady-swap")
                        put("incident", true)
                        put("incidentWhen", "critical, 2026-09-25")
                        put("incidentSummary", "Large swaps held indefinitely without payout.")
                        put("intern", false)
                        put("internHoldsFunds", false)
                        put("hosts", JSONArray(listOf("shadyswap.io", "shadyswap.org")))
                        put("nkip01Level", 0)
                        put("logOnly", true)
                        put("hasLog", true)
                        put("logo", "data:image/png;base64,AAAA") // non-WebP must be dropped
                    },
                )
                put(
                    JSONObject().apply {
                        put("id", "fresh-intern")
                        put("name", "FreshMonero")
                        put("category", "swap")
                        put("grade", "")
                        put("url", "https://xmr.club/exchanges/freshmonero")
                        put("incident", false)
                        put("intern", true)
                        put("internHoldsFunds", true)
                        put("internDay", 5)
                        put("internDaysRequired", 90)
                        put("hosts", JSONArray(listOf("freshmonero.org")))
                        put("nkip01Level", JSONObject.NULL)
                        put("logOnly", false)
                        put("hasLog", false)
                    },
                )
            },
        )
    }

    @Test
    fun parsesCatalogStrippingPlatformHostsAndInvalidLogos() {
        val snap = SiteCatalog.parse(samplePayload())
        assertNotNull(snap)
        assertEquals(1_760_000_000L, snap!!.issuedAt)
        assertEquals(5, snap.sites.size)

        val trocador = snap.sites.first { it.id == "trocador" }
        assertEquals(listOf("trocador.app"), trocador.hosts)
        assertNotNull(trocador.logoDataUri)
        assertNotNull(SiteCatalog.decodeWebpBase64(trocador.logoDataUri))

        val shady = snap.sites.first { it.id == "shady-swap" }
        assertNull(shady.logoDataUri)
    }

    @Test
    fun matchUrlMatchesExactNormalizedHostAndPicksLeadSite() {
        val sites = SiteCatalog.parse(samplePayload())!!.sites

        assertEquals("trocador", SiteCatalog.matchUrl(sites, "https://www.trocador.app/en/swap")?.id)
        // Subdomains and lookalikes must NOT match exact-host entries.
        assertNull(SiteCatalog.matchUrl(sites, "https://evil-trocador.app/"))
        assertNull(SiteCatalog.matchUrl(sites, "https://trocador.app.evil.com/"))
        assertNull(SiteCatalog.matchUrl(sites, "https://github.com/trocador"))
        assertNull(SiteCatalog.matchUrl(sites, "http://trocador.app/"))

        // Multiple listings on kyc.rip: worst grade (B over A+) wins like desktop leadSite().
        assertEquals("kycrip-card", SiteCatalog.matchUrl(sites, "https://kyc.rip/")?.id)
    }

    @Test
    fun searchRanksPrefixMatchesAboveSubstringAndStripsUrlScheme() {
        val sites = SiteCatalog.parse(samplePayload())!!.sites

        val byPrefix = SiteCatalog.search(sites, "https://www.troc")
        assertEquals(1, byPrefix.size)
        assertEquals("trocador", byPrefix[0].id)

        val byCategory = SiteCatalog.search(sites, "aggregator")
        assertEquals(listOf("trocador"), byCategory.map { it.id })

        // Blank query returns curated top sites with non-incident higher-graded sites before interns/incidents.
        val defaults = SiteCatalog.search(sites, "")
        assertEquals(4, defaults.size) // kyc.rip deduplicated to 1 row
        assertEquals("trocador", defaults[0].id) // A before B (kyc.rip lead) before intern before incident
        assertEquals("shady-swap", defaults.last().id)
    }

    @Test
    fun colorsAndLabelsMatchDesktopBadgeForPalette() {
        val sites = SiteCatalog.parse(samplePayload())!!.sites
        val trocador = sites.first { it.id == "trocador" }
        val shady = sites.first { it.id == "shady-swap" }
        val intern = sites.first { it.id == "fresh-intern" }

        assertEquals(SiteCatalog.COLOR_GRADE_A, SiteCatalog.gradeColorInt(trocador.grade, trocador.incident, trocador.intern))
        assertEquals("A", SiteCatalog.badgeLabel(trocador))
        assertEquals("NKIP-0001 L3", SiteCatalog.proofSummary(trocador))

        assertEquals(SiteCatalog.COLOR_WARN_RED, SiteCatalog.gradeColorInt(shady.grade, shady.incident, shady.intern))
        assertEquals("F", SiteCatalog.badgeLabel(shady))
        assertEquals("LoG", SiteCatalog.proofSummary(shady))

        assertEquals(SiteCatalog.COLOR_CAUTION_AMBER, SiteCatalog.gradeColorInt(intern.grade, intern.incident, intern.intern))
        assertEquals("new", SiteCatalog.badgeLabel(intern))
        assertNull(SiteCatalog.proofSummary(intern))
    }

    @Test
    fun decodeWebpRejectsNonWebpOrOversizedPayloads() {
        assertNull(SiteCatalog.decodeWebpBase64("data:image/png;base64,AAAA"))
        assertNull(SiteCatalog.decodeWebpBase64("data:image/webp;base64,not-valid-base64!!!"))
        assertNull(SiteCatalog.decodeWebpBase64("data:image/webp;base64,AAAAAAAAAAAAAAAAAAAAAAAAAAAA"))
        assertTrue(SiteCatalog.decodeWebpBase64(validWebpDataUri)!!.size >= 30)
    }

    @Test
    fun warningsAndSiblingHostsMirrorDesktopRules() {
        val sites = SiteCatalog.parse(samplePayload())!!.sites
        val trocador = sites.first { it.id == "trocador" }
        val shady = sites.first { it.id == "shady-swap" }
        val intern = sites.first { it.id == "fresh-intern" }

        assertEquals(false, SiteCatalog.needsWarning(trocador))
        assertNull(SiteCatalog.shortWarningLine(trocador))

        assertTrue(SiteCatalog.needsWarning(shady))
        assertTrue(SiteCatalog.isHighSeverityWarning(shady))
        assertEquals("⚠ Open incident (critical, 2026-09-25)", SiteCatalog.shortWarningLine(shady))
        assertEquals("⚠ Open incident · ShadySwap (critical, 2026-09-25)", SiteCatalog.warningTitle(shady))
        assertEquals("Large swaps held indefinitely without payout.", SiteCatalog.warningBody(shady))
        assertEquals("https://xmr.club/exchanges/shady-swap", shady.url)

        assertTrue(SiteCatalog.needsWarning(intern))
        assertEquals(false, SiteCatalog.isHighSeverityWarning(intern))
        assertEquals("⚠ New on xmr.club · holds coins during swap", SiteCatalog.shortWarningLine(intern))
        assertTrue(SiteCatalog.warningBody(intern).contains("day 5 of 90"))

        assertEquals(setOf("shadyswap.io", "shadyswap.org"), SiteCatalog.siblingHostsFor(sites, "www.shadyswap.org"))
        assertEquals(emptySet<String>(), SiteCatalog.siblingHostsFor(sites, "unknown.example"))
    }
}
