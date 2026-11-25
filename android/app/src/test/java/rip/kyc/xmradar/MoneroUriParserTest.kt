package rip.kyc.xmradar

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import rip.kyc.xmradar.MoneroUriParser.AddressType
import rip.kyc.xmradar.MoneroUriParser.ParseResult

class MoneroUriParserTest {
    // Real mainnet addresses matching tests/xmr.test.ts (Monero General Fund & @xbtoshi subaddress)
    private val std = "44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A"
    private val sub = "89fM69NVioz94JQrJFLGPDa8PMpjea7TV8JQktbLBLpX9gKMfrt3dge7KMdqg86coZjCxCm3fn1WKdM8WBMJhEdaUimo8Q3"

    @Test
    fun validatesMainnetStandardAndSubaddressWithKeccakChecksum() {
        assertEquals(AddressType.STANDARD, MoneroUriParser.validateMainnetAddress(std))
        assertEquals(AddressType.SUBADDRESS, MoneroUriParser.validateMainnetAddress(sub))
    }

    @Test
    fun rejectsSingleCharFlippedChecksum() {
        val corrupted = std.dropLast(1) + if (std.last() == 'A') 'B' else 'A'
        assertNull(MoneroUriParser.validateMainnetAddress(corrupted))
        assertTrue(MoneroUriParser.parse("monero:$corrupted") is ParseResult.Invalid)
    }

    @Test
    fun rejectsBadLengthOverflowAndNonBase58() {
        assertNull(MoneroUriParser.validateMainnetAddress(""))
        assertNull(MoneroUriParser.validateMainnetAddress(std.dropLast(1)))
        assertNull(MoneroUriParser.validateMainnetAddress(std.dropLast(1) + "0"))
        assertNull(MoneroUriParser.validateMainnetAddress("zzzzzzzzzzz" + std.substring(11)))
    }

    @Test
    fun parsesValidMoneroUriAndRejectsBadParamsOrControlChars() {
        val ok = MoneroUriParser.parse("monero:$sub?tx_amount=0.05&tx_description=tip%20thanks")
        assertTrue(ok is ParseResult.Valid)
        val parsed = (ok as ParseResult.Valid).uri
        assertEquals(sub, parsed.address)
        assertEquals(AddressType.SUBADDRESS, parsed.type)
        assertEquals("0.05", parsed.amount)
        assertEquals("tip thanks", parsed.description)

        assertTrue(MoneroUriParser.parse("monero:$std?tx_amount=-1") is ParseResult.Invalid)
        assertTrue(MoneroUriParser.parse("monero:$std?tx_amount=1e3") is ParseResult.Invalid)
        assertTrue(MoneroUriParser.parse("monero:$std?unknown=1") is ParseResult.Invalid)
        assertTrue(MoneroUriParser.parse("monero:$std?tx_description=hi%0Aevil") is ParseResult.Invalid)
        assertTrue(MoneroUriParser.parse("bitcoin:$std") is ParseResult.Invalid)
    }
}
