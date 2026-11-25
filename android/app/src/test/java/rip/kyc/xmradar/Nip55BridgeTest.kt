package rip.kyc.xmradar

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class Nip55BridgeTest {

    // Official NIP-19 test vector:
    // hex:  3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d
    // npub: npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6
    private val sampleHex = "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d"
    private val sampleNpub = "npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6"
    private val sampleSig = "a".repeat(128)
    private val sampleId = "b".repeat(64)

    @Test
    fun `normalizePubkey accepts 64-hex and NIP-19 npub`() {
        assertEquals(sampleHex, Nip55Bridge.normalizePubkey(sampleHex))
        assertEquals(sampleHex, Nip55Bridge.normalizePubkey("  ${sampleHex.uppercase()}  "))
        assertEquals(sampleHex, Nip55Bridge.normalizePubkey(sampleNpub))
        assertEquals(sampleHex, Nip55Bridge.normalizePubkey(sampleNpub.uppercase()))
    }

    @Test
    fun `normalizePubkey rejects bad checksum, wrong hrp, and short hex`() {
        val badChecksum = sampleNpub.dropLast(1) + if (sampleNpub.last() == '6') '7' else '6'
        assertNull(Nip55Bridge.normalizePubkey(badChecksum))
        assertNull(Nip55Bridge.normalizePubkey("nsec180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6"))
        assertNull(Nip55Bridge.normalizePubkey("deadbeef"))
        assertNull(Nip55Bridge.normalizePubkey(null))
        assertNull(Nip55Bridge.normalizePubkey(""))
    }

    @Test
    fun `permissionsJsonForGetPublicKey includes preauth kinds (including Blossom 24242) and excludes public posts`() {
        val arr = JSONArray(Nip55Bridge.permissionsJsonForGetPublicKey())
        val kinds = mutableSetOf<Int>()
        for (i in 0 until arr.length()) {
            val item = arr.getJSONObject(i)
            assertEquals("sign_event", item.getString("type"))
            kinds.add(item.getInt("kind"))
        }
        assertEquals(Nip55Bridge.PREAUTH_KINDS, kinds)
        assertTrue("Blossom auth (24242) should be pre-authorizable", 24242 in kinds)
        for (interactiveKind in listOf(1, 30023)) {
            assertFalse("Public post/article kind $interactiveKind must NOT be pre-authorized", interactiveKind in kinds)
        }
    }

    @Test
    fun `validateSignEventRequest allows identity, Blossom, and interactive kinds and strips unknown fields`() {
        val identityEv = JSONObject()
            .put("kind", 17)
            .put("created_at", 1700000000L)
            .put("tags", JSONArray().put(JSONArray().put("i").put("twitter:123")))
            .put("content", "xo")
            .put("extra_injected", "drop_me")

        val validated = Nip55Bridge.validateSignEventRequest(identityEv, sampleHex)
        assertNotNull(validated)
        assertEquals(17, validated!!.kind)
        assertFalse(validated.requiresInteractive)
        assertFalse(validated.canonicalEventJson.contains("extra_injected"))

        val blossomEv = JSONObject()
            .put("kind", 24242)
            .put("created_at", 1700000000L)
            .put("tags", JSONArray().put(JSONArray().put("t").put("upload")))
            .put("content", "Upload")
        val blossomValidated = Nip55Bridge.validateSignEventRequest(blossomEv, sampleHex)
        assertNotNull(blossomValidated)
        assertFalse("Blossom auth (24242) should not require interactive popup per image", blossomValidated!!.requiresInteractive)

        val noteEv = JSONObject()
            .put("kind", 1)
            .put("created_at", 1700000000L)
            .put("tags", JSONArray())
            .put("content", "hello nostr")

        val noteValidated = Nip55Bridge.validateSignEventRequest(noteEv, sampleNpub)
        assertNotNull(noteValidated)
        assertEquals(sampleHex, noteValidated!!.pubkeyHex)
        assertTrue("Kind 1 must always require interactive signer approval", noteValidated.requiresInteractive)
    }

    @Test
    fun `validateSignEventRequest rejects disallowed kinds, malformed events, and oversized payloads`() {
        val dmKind = JSONObject()
            .put("kind", 4)
            .put("created_at", 1700000000L)
            .put("tags", JSONArray())
            .put("content", "secret")
        assertNull(Nip55Bridge.validateSignEventRequest(dmKind, sampleHex))

        val badTags = JSONObject()
            .put("kind", 17)
            .put("created_at", 1700000000L)
            .put("tags", JSONArray().put(JSONArray().put(123)))
            .put("content", "xo")
        assertNull(Nip55Bridge.validateSignEventRequest(badTags, sampleHex))

        val hugeContent = JSONObject()
            .put("kind", 1)
            .put("created_at", 1700000000L)
            .put("tags", JSONArray())
            .put("content", "x".repeat(Nip55Bridge.MAX_CONTENT_CHARS + 1))
        assertNull(Nip55Bridge.validateSignEventRequest(hugeContent, sampleHex))

        val tooManyTags = JSONArray()
        for (i in 0..Nip55Bridge.MAX_TAGS) tooManyTags.put(JSONArray().put("t").put("a"))
        val bigTagsEv = JSONObject()
            .put("kind", 1)
            .put("created_at", 1700000000L)
            .put("tags", tooManyTags)
            .put("content", "hi")
        assertNull(Nip55Bridge.validateSignEventRequest(bigTagsEv, sampleHex))

        val badPubkey = JSONObject()
            .put("kind", 17)
            .put("created_at", 1700000000L)
            .put("tags", JSONArray())
            .put("content", "xo")
        assertNull(Nip55Bridge.validateSignEventRequest(badPubkey, "not-a-pubkey"))
    }

    @Test
    fun `parseSignResponse handles signed event json, signature-only, rejection, missing id, and id mismatch`() {
        val fullEvent = JSONObject()
            .put("id", sampleId)
            .put("pubkey", sampleHex)
            .put("created_at", 1700000000L)
            .put("kind", 17)
            .put("tags", JSONArray())
            .put("content", "xo")
            .put("sig", sampleSig)
            .toString()

        val okFull = Nip55Bridge.parseSignResponse(fullEvent, sampleSig, "req-1", "req-1", false)
        assertTrue(okFull is Nip55Bridge.ParsedSignResponse.SignedEvent)
        assertEquals(sampleId, (okFull as Nip55Bridge.ParsedSignResponse.SignedEvent).event.getString("id"))

        val okSigOnly = Nip55Bridge.parseSignResponse(null, sampleSig.uppercase(), "req-1", "req-1", false)
        assertTrue(okSigOnly is Nip55Bridge.ParsedSignResponse.SignatureOnly)
        assertEquals(sampleSig, (okSigOnly as Nip55Bridge.ParsedSignResponse.SignatureOnly).sigHex)

        val rejected = Nip55Bridge.parseSignResponse(fullEvent, sampleSig, "req-1", "req-1", true)
        assertTrue(rejected is Nip55Bridge.ParsedSignResponse.Rejected)

        val mismatch = Nip55Bridge.parseSignResponse(fullEvent, sampleSig, "req-1", "req-2", false)
        assertTrue(mismatch is Nip55Bridge.ParsedSignResponse.Rejected)

        val missingId = Nip55Bridge.parseSignResponse(fullEvent, sampleSig, "req-1", null, false)
        assertTrue("Missing echoed id must be rejected on interactive path", missingId is Nip55Bridge.ParsedSignResponse.Rejected)

        // ContentResolver path passes expectedId = null
        val okBg = Nip55Bridge.parseSignResponse(fullEvent, null, null, null, false)
        assertTrue(okBg is Nip55Bridge.ParsedSignResponse.SignedEvent)

        val empty = Nip55Bridge.parseSignResponse(null, null, null, null, false)
        assertTrue(empty is Nip55Bridge.ParsedSignResponse.Empty)
    }
}
