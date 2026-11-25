package rip.kyc.xmradar

import android.content.Intent
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject

/**
 * Pure Kotlin NIP-55 protocol validation, Bech32 `npub` decoding, intent construction,
 * and response parsing for external Android Nostr signers (e.g., Amber).
 *
 * Security boundaries:
 * - Split kind allowlists: `PREAUTH_KINDS` (identity/xo/xap + Blossom upload auth kind 24242) may
 *   be pre-authorized for ContentResolver background signing, while `INTERACTIVE_ONLY_KINDS`
 *   (public notes kind 1 and NIP-23 long-form articles kind 30023) are NEVER pre-authorized and
 *   ALWAYS require foreground interactive approval in the signer app.
 * - Callers MUST select and pin `targetPackage` from `PackageManager.queryIntentActivities`,
 *   never trusting a `package` string echoed by an untrusted signer response.
 */
object Nip55Bridge {

    const val NATIVE_APP_ID = "xmradar_android"

    /** Matches `MANAGED_KINDS` in `src/identity/managed.ts`. */
    val IDENTITY_KINDS: Set<Int> = setOf(0, 5, 17, 9042, 9044, 10002, 10011, 10133, 27235)

    /** Blossom media upload auth (per-image during Copy-to-Nostr; safe for background pre-auth). */
    const val BLOSSOM_AUTH_KIND: Int = 24242

    /** Kinds eligible for NIP-55 pre-authorization and silent ContentResolver signing. */
    val PREAUTH_KINDS: Set<Int> = IDENTITY_KINDS + BLOSSOM_AUTH_KIND

    /** Public posts & articles — NEVER pre-authorized; ALWAYS require foreground interactive approval. */
    val INTERACTIVE_ONLY_KINDS: Set<Int> = setOf(1, 30023)

    val ALL_ALLOWED_KINDS: Set<Int> = PREAUTH_KINDS + INTERACTIVE_ONLY_KINDS

    const val MAX_CONTENT_CHARS = 256 * 1024
    const val MAX_RESPONSE_JSON_CHARS = 512 * 1024
    const val MAX_TAGS = 512
    const val MAX_TAG_ITEMS = 32
    const val MAX_TAG_ITEM_CHARS = 4_096

    private val HEX64_RE = Regex("^[0-9a-f]{64}$")
    private val HEX128_RE = Regex("^[0-9a-f]{128}$")
    private const val BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"

    data class ValidatedSignRequest(
        val kind: Int,
        val pubkeyHex: String,
        val canonicalEventJson: String,
        val requiresInteractive: Boolean,
    )

    sealed class ParsedSignResponse {
        data class SignedEvent(val event: JSONObject) : ParsedSignResponse()
        data class SignatureOnly(val sigHex: String) : ParsedSignResponse()
        data class Rejected(val reason: String) : ParsedSignResponse()
        data object Empty : ParsedSignResponse()
    }

    fun isAllowedKind(kind: Int): Boolean = kind in ALL_ALLOWED_KINDS

    fun isInteractiveOnlyKind(kind: Int): Boolean = kind in INTERACTIVE_ONLY_KINDS

    /**
     * Narrow NIP-55 `permissions` JSON passed with `get_public_key`.
     * Includes `PREAUTH_KINDS` (identity/xo/xap + Blossom 24242) and deliberately excludes
     * `INTERACTIVE_ONLY_KINDS` (1, 30023) so public posts/articles are never silently signed.
     */
    fun permissionsJsonForGetPublicKey(): String {
        val arr = JSONArray()
        for (k in PREAUTH_KINDS.sorted()) {
            arr.put(JSONObject().put("type", "sign_event").put("kind", k))
        }
        return arr.toString()
    }

    /**
     * Normalizes a NIP-55 `get_public_key` result into 64-char lowercase hex.
     * Accepts either 64-char hex or a checksum-verified NIP-19 `npub1...` Bech32 string.
     */
    fun normalizePubkey(raw: String?): String? {
        val s = raw?.trim()?.lowercase() ?: return null
        if (HEX64_RE.matches(s)) return s
        if (s.startsWith("npub1")) return decodeNpubToHex(s)
        return null
    }

    /**
     * Validates a `sign_event` request from the extension background script (including size caps
     * and kind allowlist) and returns a sanitized canonical unsigned event JSON containing ONLY
     * `{kind, created_at, tags, content}`.
     */
    fun validateSignEventRequest(eventObj: JSONObject?, pubkeyRaw: String?): ValidatedSignRequest? {
        val pubkey = normalizePubkey(pubkeyRaw) ?: return null
        if (eventObj == null) return null

        val kind = when (val k = eventObj.opt("kind")) {
            is Int -> k
            is Long -> if (k in Int.MIN_VALUE..Int.MAX_VALUE) k.toInt() else return null
            is Number -> {
                val d = k.toDouble()
                if (d % 1.0 == 0.0 && d >= Int.MIN_VALUE && d <= Int.MAX_VALUE) d.toInt() else return null
            }
            else -> return null
        }
        if (!isAllowedKind(kind)) return null

        val createdAt = when (val c = eventObj.opt("created_at")) {
            is Long -> c
            is Int -> c.toLong()
            is Number -> c.toLong()
            else -> return null
        }
        if (createdAt <= 0L) return null

        val contentObj = eventObj.opt("content")
        if (contentObj !is String || contentObj.length > MAX_CONTENT_CHARS) return null

        val rawTags = eventObj.optJSONArray("tags") ?: return null
        if (rawTags.length() > MAX_TAGS) return null
        val cleanTags = JSONArray()
        for (i in 0 until rawTags.length()) {
            val tag = rawTags.optJSONArray(i) ?: return null
            if (tag.length() > MAX_TAG_ITEMS) return null
            val cleanTag = JSONArray()
            for (j in 0 until tag.length()) {
                val elem = tag.opt(j)
                if (elem !is String || elem.length > MAX_TAG_ITEM_CHARS) return null
                cleanTag.put(elem)
            }
            cleanTags.put(cleanTag)
        }

        val clean = JSONObject()
            .put("kind", kind)
            .put("created_at", createdAt)
            .put("tags", cleanTags)
            .put("content", contentObj)

        return ValidatedSignRequest(
            kind = kind,
            pubkeyHex = pubkey,
            canonicalEventJson = clean.toString(),
            requiresInteractive = isInteractiveOnlyKind(kind),
        )
    }

    /**
     * Parses a NIP-55 `sign_event` response from either `ContentResolver` or `ActivityResult`.
     * When `expectedId` is set (interactive Intent path), requires an exact echoed `id` match.
     */
    fun parseSignResponse(
        eventJsonStr: String?,
        resultStr: String?,
        expectedId: String?,
        returnedId: String?,
        rejected: Boolean,
    ): ParsedSignResponse {
        if (rejected) {
            return ParsedSignResponse.Rejected("Signer rejected this request")
        }
        if (!expectedId.isNullOrEmpty() && returnedId != expectedId) {
            return ParsedSignResponse.Rejected("Signer returned a missing or mismatched request id")
        }

        val candidates = listOfNotNull(
            eventJsonStr?.trim()?.takeIf { it.isNotEmpty() },
            resultStr?.trim()?.takeIf { it.isNotEmpty() },
        )
        for (c in candidates) {
            if (c.startsWith("{")) {
                val parsed = parseSignedEventJson(c)
                if (parsed != null) return ParsedSignResponse.SignedEvent(parsed)
            }
        }
        for (c in candidates) {
            val lower = c.lowercase()
            if (HEX128_RE.matches(lower)) {
                return ParsedSignResponse.SignatureOnly(lower)
            }
        }
        return ParsedSignResponse.Empty
    }

    private fun parseSignedEventJson(raw: String): JSONObject? {
        if (raw.length > MAX_RESPONSE_JSON_CHARS) return null
        return try {
            val obj = JSONObject(raw)
            val id = obj.optString("id", "").lowercase()
            val pk = obj.optString("pubkey", "").lowercase()
            val sig = obj.optString("sig", "").lowercase()
            if (!HEX64_RE.matches(id) || !HEX64_RE.matches(pk) || !HEX128_RE.matches(sig)) return null
            if (!obj.has("kind") || !obj.has("created_at") || obj.opt("content") !is String || obj.optJSONArray("tags") == null) return null
            obj
        } catch (_: Exception) {
            null
        }
    }

    fun buildGetPublicKeyIntent(targetPackage: String): Intent =
        Intent(Intent.ACTION_VIEW, Uri.parse("nostrsigner:")).apply {
            setPackage(targetPackage)
            putExtra("type", "get_public_key")
            putExtra("permissions", permissionsJsonForGetPublicKey())
        }

    fun buildSignEventIntent(
        targetPackage: String,
        canonicalEventJson: String,
        currentUserHex: String,
        requestId: String,
    ): Intent =
        Intent(Intent.ACTION_VIEW, Uri.parse("nostrsigner:${Uri.encode(canonicalEventJson)}")).apply {
            setPackage(targetPackage)
            putExtra("type", "sign_event")
            putExtra("current_user", currentUserHex)
            putExtra("id", requestId)
        }

    /**
     * Pure Kotlin BIP-173 Bech32 decoder for NIP-19 `npub1...` (32-byte public key).
     * Verifies the 6-character Bech32 polymod checksum and rejects non-zero padding bits.
     */
    internal fun decodeNpubToHex(bech32: String): String? {
        val lower = bech32.lowercase()
        if (lower.length < 8 || lower.length > 90) return null
        val sep = lower.lastIndexOf('1')
        if (sep < 1 || sep + 7 > lower.length) return null
        val hrp = lower.substring(0, sep)
        if (hrp != "npub") return null

        val dataPart = lower.substring(sep + 1)
        val values = IntArray(dataPart.length)
        for (i in dataPart.indices) {
            val idx = BECH32_CHARSET.indexOf(dataPart[i])
            if (idx < 0) return null
            values[i] = idx
        }
        if (bech32Polymod(hrpExpand(hrp) + values) != 1) return null

        val payload5 = values.copyOfRange(0, values.size - 6)
        val bytes = convertBits5To8(payload5) ?: return null
        if (bytes.size != 32) return null
        return bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }

    private fun hrpExpand(hrp: String): IntArray {
        val out = IntArray(hrp.length * 2 + 1)
        for (i in hrp.indices) {
            out[i] = hrp[i].code ushr 5
            out[i + hrp.length + 1] = hrp[i].code and 31
        }
        out[hrp.length] = 0
        return out
    }

    private fun bech32Polymod(values: IntArray): Int {
        val gen = intArrayOf(0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3)
        var chk = 1
        for (v in values) {
            val b = chk ushr 25
            chk = ((chk and 0x1ffffff) shl 5) xor v
            for (i in 0 until 5) {
                if (((b ushr i) and 1) != 0) chk = chk xor gen[i]
            }
        }
        return chk
    }

    private fun convertBits5To8(data: IntArray): ByteArray? {
        var acc = 0
        var bits = 0
        val out = ArrayList<Byte>((data.size * 5) / 8)
        for (v in data) {
            if (v < 0 || v > 31) return null
            acc = (acc shl 5) or v
            bits += 5
            while (bits >= 8) {
                bits -= 8
                out.add(((acc ushr bits) and 0xff).toByte())
            }
        }
        if (bits >= 5) return null
        if (((acc shl (8 - bits)) and 0xff) != 0) return null
        return out.toByteArray()
    }
}
