package rip.kyc.xmradar

import java.net.URI
import java.util.Base64
import org.json.JSONArray
import org.json.JSONObject

/**
 * Pure-Kotlin catalog of xmr.club verified sites + logos bridged from XMRadar's bundled WebExtension
 * (`src/sites/android-catalog.ts`). Powers:
 * 1. Instant offline autocomplete in the Private Swap / Browse dialog.
 * 2. Native floating FAB site recognition (verified WebP logo + grade/warning status ring).
 *
 * Kept free of Android framework UI types so all parsing, host matching, ranking, and WebP
 * validation run directly in fast JVM unit tests.
 */
object SiteCatalog {

    const val MAX_LOGO_BYTES = 4096
    private const val MAX_LOGO_B64_CHARS = ((MAX_LOGO_BYTES + 2) / 3) * 4
    private const val WEBP_DATA_URI_PREFIX = "data:image/webp;base64,"
    private val XMRCLUB_URL_RE = Regex("^https://xmr\\.club/[A-Za-z0-9/_.-]*$")

    // Mirror of src/sites/feed.ts PLATFORM_HOSTS so multi-tenant platforms never match as a single service.
    private val PLATFORM_HOSTS = setOf(
        "github.com",
        "gitlab.com",
        "codeberg.org",
        "youtube.com",
        "reddit.com",
        "x.com",
        "twitter.com",
        "matrix.to",
        "t.me",
        "telegram.me",
        "medium.com",
        "substack.com",
        "mastodon.social",
        "discord.com",
        "discord.gg",
        "github.dev",
        "github.blog",
        "githubusercontent.com",
        "youtu.be",
        "redd.it",
        "stackexchange.com",
    )

    // Exact xmr.club / badgeFor ARGB palette (src/sites/feed.ts).
    const val COLOR_GRADE_A = 0xFF3F7A26.toInt()
    const val COLOR_GRADE_B = 0xFFC45A1A.toInt()
    const val COLOR_GRADE_C = 0xFF9C2E2E.toInt()
    const val COLOR_GRADE_D = 0xFF5B5142.toInt()
    const val COLOR_GRADE_EF = 0xFFC91515.toInt()
    const val COLOR_GRADE_NONE = 0xFF6B6880.toInt()
    const val COLOR_WARN_RED = 0xFFD93025.toInt()
    const val COLOR_CAUTION_AMBER = 0xFFB26A00.toInt()
    const val COLOR_VERIFIED_GREEN = 0xFF1E7D34.toInt()

    data class CatalogSite(
        val id: String,
        val name: String,
        val category: String,
        val grade: String,
        val url: String?,
        val incident: Boolean,
        val incidentWhen: String?,
        val incidentSummary: String?,
        val intern: Boolean,
        val internHoldsFunds: Boolean,
        val internDay: Int?,
        val internDaysRequired: Int?,
        val hosts: List<String>,
        val nkip01Level: Int?,
        val logOnly: Boolean,
        val hasLog: Boolean,
        val logoDataUri: String?,
    ) {
        val primaryHost: String get() = hosts.first()
    }

    data class CatalogSnapshot(
        val issuedAt: Long,
        val sites: List<CatalogSite>,
    )

    fun normalizeHost(host: String): String =
        host.trim().lowercase().trimEnd('.').removePrefix("www.")

    fun extractHost(url: String?): String? {
        val raw = url?.trim() ?: return null
        if (!raw.startsWith("https://", ignoreCase = true)) return null
        val uri = try {
            URI(raw)
        } catch (_: Exception) {
            return null
        }
        val h = uri.host ?: return null
        val norm = normalizeHost(h)
        return norm.takeIf { it.isNotEmpty() && "." in it }
    }

    fun parse(json: JSONObject): CatalogSnapshot? {
        val issuedAt = json.optLong("issuedAt", -1L)
        if (issuedAt < 0L) return null
        val arr = json.optJSONArray("sites") ?: return CatalogSnapshot(issuedAt = issuedAt, sites = emptyList())
        val out = ArrayList<CatalogSite>(arr.length())
        for (i in 0 until arr.length()) {
            val item = arr.optJSONObject(i) ?: continue
            parseSite(item)?.let { out.add(it) }
        }
        return CatalogSnapshot(issuedAt = issuedAt, sites = out)
    }

    private fun parseSite(obj: JSONObject): CatalogSite? {
        val id = obj.optString("id", "").trim()
        val name = obj.optString("name", "").trim()
        if (id.isEmpty() || name.isEmpty()) return null
        val hostsArr = obj.optJSONArray("hosts") ?: return null
        val hosts = parseHosts(hostsArr)
        if (hosts.isEmpty()) return null
        val category = obj.optString("category", "").trim()
        val grade = obj.optString("grade", "").trim().uppercase().take(3)
        val rawUrl = obj.optString("url", "").trim()
        val url = rawUrl.takeIf { it.isNotEmpty() && !it.contains("..") && XMRCLUB_URL_RE.matches(it) }
        val incident = obj.optBoolean("incident", false)
        val incidentWhen = if (incident) obj.optString("incidentWhen", "").trim().take(48).takeIf { it.isNotEmpty() } else null
        val incidentSummary = if (incident) obj.optString("incidentSummary", "").trim().take(240).takeIf { it.isNotEmpty() } else null
        val intern = obj.optBoolean("intern", false)
        val internHoldsFunds = obj.optBoolean("internHoldsFunds", false)
        val internDay = if (!intern || obj.isNull("internDay")) null else obj.optInt("internDay", -1).takeIf { it in 1..3650 }
        val internDaysRequired = if (!intern || obj.isNull("internDaysRequired")) null else obj.optInt("internDaysRequired", -1).takeIf { it in 1..3650 }
        val nkip01Level = if (obj.isNull("nkip01Level")) null else {
            val v = obj.optInt("nkip01Level", -1)
            if (v in 0..3) v else null
        }
        val logOnly = obj.optBoolean("logOnly", false)
        val hasLog = obj.optBoolean("hasLog", false)
        val rawLogo = obj.optString("logo", "").takeIf { it.isNotEmpty() }
        val logo = rawLogo?.takeIf { decodeWebpBase64(it) != null }
        return CatalogSite(
            id = id,
            name = name,
            category = category,
            grade = grade,
            url = url,
            incident = incident,
            incidentWhen = incidentWhen,
            incidentSummary = incidentSummary,
            intern = intern,
            internHoldsFunds = internHoldsFunds,
            internDay = internDay,
            internDaysRequired = internDaysRequired,
            hosts = hosts,
            nkip01Level = nkip01Level,
            logOnly = logOnly,
            hasLog = hasLog,
            logoDataUri = logo,
        )
    }

    private fun parseHosts(arr: JSONArray): List<String> {
        val out = ArrayList<String>(arr.length())
        val seen = HashSet<String>()
        for (i in 0 until arr.length()) {
            val raw = arr.optString(i, "")
            val h = normalizeHost(raw)
            if (h.isEmpty() || "." !in h || h in PLATFORM_HOSTS) continue
            if (h.any { it.isWhitespace() || it.code < 0x20 }) continue
            if (seen.add(h)) out.add(h)
        }
        return out
    }

    /** Exact host match (mirroring `sitesFor` + `leadSite` in src/sites/feed.ts). */
    fun matchUrl(sites: List<CatalogSite>, url: String?): CatalogSite? {
        val host = extractHost(url) ?: return null
        return matchHost(sites, host)
    }

    /** Exact normalized host match (mirroring `sitesFor` + `leadSite` in src/sites/feed.ts). */
    fun matchHost(sites: List<CatalogSite>, rawHost: String?): CatalogSite? {
        val host = normalizeHost(rawHost ?: return null)
        if (host.isEmpty() || "." !in host || host in PLATFORM_HOSTS) return null
        val matches = sites.filter { host in it.hosts }
        if (matches.isEmpty()) return null
        return leadSite(matches)
    }

    /**
     * All verified sibling hosts belonging to any catalog listing that owns `rawHost`
     * (e.g. `fixedfloat.com` -> `{"ff.io", "fixedfloat.com"}`), so Swap tab allowlists
     * allow canonical redirects between a service's own listed domains.
     */
    fun siblingHostsFor(sites: List<CatalogSite>, rawHost: String): Set<String> {
        val host = normalizeHost(rawHost)
        if (host.isEmpty() || host in PLATFORM_HOSTS) return emptySet()
        val out = LinkedHashSet<String>()
        for (site in sites) {
            if (host in site.hosts) {
                for (h in site.hosts) {
                    if (h !in PLATFORM_HOSTS) out.add(h)
                }
            }
        }
        return out
    }

    /** Mirrors desktop `needsBanner(sites)` in src/sites/feed.ts: open incident, D–F grade, or funds intern. */
    fun needsWarning(site: CatalogSite): Boolean =
        site.incident || site.internHoldsFunds || site.grade.firstOrNull() in listOf('D', 'E', 'F')

    /** True for red alarms (open incident or D–F grade); false for amber caution (funds intern). */
    fun isHighSeverityWarning(site: CatalogSite): Boolean =
        site.incident || site.grade.firstOrNull() in listOf('D', 'E', 'F')

    /** Short one-line warning chip for Swap autocomplete rows and sheet headers. */
    fun shortWarningLine(site: CatalogSite): String? {
        if (!needsWarning(site)) return null
        return when {
            site.incident -> if (site.incidentWhen != null) "⚠ Open incident (${site.incidentWhen})" else "⚠ Open incident on xmr.club"
            site.grade.firstOrNull() in listOf('D', 'E', 'F') -> "⚠ Grade ${site.grade} on xmr.club"
            site.internHoldsFunds -> "⚠ New on xmr.club · holds coins during swap"
            else -> null
        }
    }

    /** Dialog/card title for a warned site. */
    fun warningTitle(site: CatalogSite): String = when {
        site.incident -> if (site.incidentWhen != null) {
            "⚠ Open incident · ${site.name} (${site.incidentWhen})"
        } else {
            "⚠ Open incident · ${site.name}"
        }
        site.grade.firstOrNull() in listOf('D', 'E', 'F') -> "⚠ ${site.name} · Grade ${site.grade}"
        site.internHoldsFunds -> "⚠ ${site.name} · New on xmr.club"
        else -> site.name
    }

    /** Full warning summary mirroring desktop `bannerText` in src/entrypoints/content/site.ts. */
    fun warningBody(site: CatalogSite): String = when {
        site.incident -> site.incidentSummary ?: "xmr.club lists an open incident for ${site.name}."
        site.internHoldsFunds -> {
            val d = site.internDay
            val req = site.internDaysRequired
            val dayPart = if (d != null && req != null) {
                " (intern, day ${minOf(d, req)} of $req, not graded yet)"
            } else {
                " (intern, not graded yet)"
            }
            "${site.name} is new on xmr.club$dayPart. It holds your coins during a swap: keep amounts small."
        }
        site.grade.firstOrNull() in listOf('D', 'E', 'F') ->
            "xmr.club grades ${site.name} ${site.grade}. Review its listing on xmr.club before sending funds."
        else -> ""
    }

    /**
     * Picks the lead listing when multiple xmr.club entries share a host (mirrors `leadSite` in
     * src/sites/feed.ts): open incident -> D/E/F grade -> intern holding funds -> any intern -> worst grade.
     */
    fun leadSite(matches: List<CatalogSite>): CatalogSite? {
        if (matches.isEmpty()) return null
        if (matches.size == 1) return matches[0]
        matches.firstOrNull { it.incident }?.let { return it }
        val bad = matches.filter { it.grade.firstOrNull() in listOf('D', 'E', 'F') }
        if (bad.isNotEmpty()) return bad.maxByOrNull { gradeRank(it.grade) }
        matches.firstOrNull { it.intern && it.internHoldsFunds }?.let { return it }
        matches.firstOrNull { it.intern }?.let { return it }
        return matches.maxByOrNull { gradeRank(it.grade) } ?: matches[0]
    }

    /** How bad a grade is: none 0, A+ 1, A 2, A- 3, B+ 4 ... F- 18. */
    fun gradeRank(grade: String): Int {
        if (grade.isEmpty()) return 0
        val letterIdx = "ABCDEF".indexOf(grade[0].uppercaseChar())
        if (letterIdx < 0) return 0
        val mod = when (grade.getOrNull(1)) {
            '+' -> 1
            '-', '\u2212' -> 3
            else -> 2
        }
        return letterIdx * 3 + mod
    }

    /** Exact xmr.club grade/status ARGB color. */
    fun gradeColorInt(grade: String, incident: Boolean, intern: Boolean): Int {
        if (incident) return COLOR_WARN_RED
        if (intern) return COLOR_CAUTION_AMBER
        return when (grade.firstOrNull()?.uppercaseChar()) {
            'A' -> COLOR_GRADE_A
            'B' -> COLOR_GRADE_B
            'C' -> COLOR_GRADE_C
            'D' -> COLOR_GRADE_D
            'E', 'F' -> COLOR_GRADE_EF
            else -> COLOR_GRADE_NONE
        }
    }

    fun badgeLabel(site: CatalogSite): String {
        if (site.incident) return site.grade.ifEmpty { "!" }
        if (site.intern) return "new"
        return site.grade.ifEmpty { "•" }
    }

    fun proofSummary(site: CatalogSite): String? {
        val lvl = site.nkip01Level
        if (lvl != null && lvl >= 1) return "NKIP-0001 L$lvl"
        if (site.logOnly || site.hasLog) return "LoG"
        return null
    }

    fun formatCategory(raw: String): String {
        if (raw.isBlank()) return ""
        return raw.replace('-', ' ').replace('_', ' ')
            .split(' ')
            .filter { it.isNotEmpty() }
            .joinToString(" ") { part ->
                part.replaceFirstChar { c -> c.uppercaseChar() }
            }
    }

    /**
     * Filters and ranks sites for the Swap / Browse AutoCompleteTextView.
     * Deduplicates by `primaryHost` (keeping the lead listing per host) so a multi-listing domain
     * doesn't crowd the dropdown.
     */
    fun search(sites: List<CatalogSite>, rawQuery: CharSequence?, limit: Int = 8): List<CatalogSite> {
        if (sites.isEmpty() || limit <= 0) return emptyList()
        val deduped = dedupeByPrimaryHost(sites)
        val q = cleanQuery(rawQuery?.toString().orEmpty())

        if (q.isEmpty()) {
            return deduped
                .sortedWith(
                    compareBy<CatalogSite>(
                        { if (it.incident) 2 else if (it.intern) 1 else 0 },
                        { if (it.grade.isEmpty()) 99 else gradeRank(it.grade) },
                        { it.name.lowercase() },
                    ),
                )
                .take(limit)
        }

        val scored = ArrayList<Pair<Int, CatalogSite>>()
        for (site in deduped) {
            val score = matchScore(site, q)
            if (score != null) scored.add(score to site)
        }
        scored.sortWith(
            compareBy<Pair<Int, CatalogSite>>(
                { it.first },
                { if (it.second.incident) 1 else 0 },
                { if (it.second.grade.isEmpty()) 99 else gradeRank(it.second.grade) },
                { it.second.name.lowercase() },
            ),
        )
        return scored.take(limit).map { it.second }
    }

    private fun dedupeByPrimaryHost(sites: List<CatalogSite>): List<CatalogSite> {
        val grouped = LinkedHashMap<String, MutableList<CatalogSite>>()
        for (s in sites) {
            grouped.getOrPut(s.primaryHost) { mutableListOf() }.add(s)
        }
        return grouped.values.mapNotNull { leadSite(it) }
    }

    private fun cleanQuery(raw: String): String {
        var q = raw.trim().lowercase()
        q = q.removePrefix("https://").removePrefix("http://").removePrefix("www.")
        val slash = q.indexOf('/')
        if (slash >= 0) q = q.substring(0, slash)
        return q.trim()
    }

    private fun matchScore(site: CatalogSite, q: String): Int? {
        val nameLower = site.name.lowercase()
        val catLower = site.category.lowercase()
        val primary = site.primaryHost
        if (primary == q || nameLower == q) return 0
        if (primary.startsWith(q) || nameLower.startsWith(q)) return 1
        if (site.hosts.any { it.startsWith(q) }) return 2
        if (nameLower.split(' ', '-', '_').any { it.startsWith(q) }) return 3
        if (site.hosts.any { q in it } || q in nameLower) return 4
        if (catLower.isNotEmpty() && q in catLower) return 5
        return null
    }

    /**
     * Validates and decodes a small WebP `data:image/webp;base64,...` URI from the verified logo pack.
     * Mirrors the size & RIFF/WEBP header guard in `src/sites/logos.ts`.
     */
    fun decodeWebpBase64(dataUri: String?): ByteArray? {
        if (dataUri == null || !dataUri.startsWith(WEBP_DATA_URI_PREFIX)) return null
        val b64 = dataUri.substring(WEBP_DATA_URI_PREFIX.length)
        if (b64.isEmpty() || b64.length > MAX_LOGO_B64_CHARS) return null
        val bytes = try {
            Base64.getDecoder().decode(b64)
        } catch (_: IllegalArgumentException) {
            return null
        }
        if (bytes.size < 30 || bytes.size > MAX_LOGO_BYTES) return null
        // RIFF....WEBP
        if (bytes[0] != 'R'.code.toByte() ||
            bytes[1] != 'I'.code.toByte() ||
            bytes[2] != 'F'.code.toByte() ||
            bytes[3] != 'F'.code.toByte() ||
            bytes[8] != 'W'.code.toByte() ||
            bytes[9] != 'E'.code.toByte() ||
            bytes[10] != 'B'.code.toByte() ||
            bytes[11] != 'P'.code.toByte()
        ) {
            return null
        }
        return bytes
    }
}
