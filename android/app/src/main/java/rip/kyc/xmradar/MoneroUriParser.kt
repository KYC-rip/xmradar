package rip.kyc.xmradar

import java.math.BigInteger
import java.net.URLDecoder

/**
 * Pure Kotlin port of `src/xmr/address.ts` for strict mainnet Monero address and `monero:` URI
 * validation before dispatching an Android wallet chooser intent (PLAN-ANDROID §2.4).
 *
 * Verifies Monero 8-byte-block Base58 decoding, mainnet network prefix (18=standard, 42=subaddress,
 * 19=integrated), and the 4-byte original Keccak-256 checksum (padding byte 0x01, NOT NIST SHA3 0x06).
 */
object MoneroUriParser {
    private const val ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    private val ENCODED_SIZES = intArrayOf(0, 2, 3, 5, 6, 7, 9, 10, 11)
    private const val FULL_BLOCK = 8
    private const val FULL_ENCODED = 11
    private val FIFTY_EIGHT = BigInteger.valueOf(58)
    private val AMOUNT_RE = Regex("^\\d{1,9}(\\.\\d{1,12})?$")
    private val CONTROL_RE = Regex("[\\u0000-\\u001F\\u007F]")

    enum class AddressType { STANDARD, SUBADDRESS, INTEGRATED }

    data class ParsedMoneroUri(
        val rawUri: String,
        val address: String,
        val type: AddressType,
        val amount: String?,
        val recipientName: String?,
        val description: String?,
    )

    sealed class ParseResult {
        data class Valid(val uri: ParsedMoneroUri) : ParseResult()
        data class Invalid(val reason: String) : ParseResult()
    }

    fun validateMainnetAddress(address: String): AddressType? {
        if (address.length != 95 && address.length != 106) return null
        val bytes = base58Decode(address) ?: return null
        if (bytes.size < 69) return null
        val prefix = bytes[0].toInt() and 0xff
        val (type, expectedLen) = when (prefix) {
            18 -> AddressType.STANDARD to 95
            42 -> AddressType.SUBADDRESS to 95
            19 -> AddressType.INTEGRATED to 106
            else -> return null
        }
        if (address.length != expectedLen) return null
        val body = bytes.copyOfRange(0, bytes.size - 4)
        val hash = keccak256(body)
        for (i in 0 until 4) {
            if (hash[i] != bytes[bytes.size - 4 + i]) return null
        }
        return type
    }

    fun parse(raw: String): ParseResult {
        if (raw.length > 2048 || CONTROL_RE.containsMatchIn(raw)) {
            return ParseResult.Invalid("malformed URI")
        }
        if (!raw.startsWith("monero:", ignoreCase = true)) {
            return ParseResult.Invalid("wrong scheme")
        }
        val rest = raw.substring("monero:".length)
        val qIdx = rest.indexOf('?')
        val address = if (qIdx >= 0) rest.substring(0, qIdx) else rest
        val type = validateMainnetAddress(address)
            ?: return ParseResult.Invalid("invalid mainnet Monero address or checksum")

        var amount: String? = null
        var recipientName: String? = null
        var description: String? = null

        if (qIdx >= 0) {
            val query = rest.substring(qIdx + 1)
            if (query.isNotEmpty()) {
                for (pair in query.split('&')) {
                    if (pair.isEmpty()) continue
                    val eq = pair.indexOf('=')
                    val key = (if (eq >= 0) pair.substring(0, eq) else pair).lowercase()
                    val value = if (eq >= 0) {
                        try {
                            URLDecoder.decode(pair.substring(eq + 1), "UTF-8")
                        } catch (_: Exception) {
                            return ParseResult.Invalid("bad percent-encoding")
                        }
                    } else ""
                    if (CONTROL_RE.containsMatchIn(value) || value.length > 200) {
                        return ParseResult.Invalid("invalid parameter value")
                    }
                    when (key) {
                        "tx_amount" -> {
                            if (!AMOUNT_RE.matches(value)) return ParseResult.Invalid("invalid tx_amount")
                            amount = value
                        }
                        "recipient_name" -> recipientName = value
                        "tx_description" -> description = value
                        "tx_payment_id" -> {
                            if (!Regex("^[0-9a-fA-F]{16}([0-9a-fA-F]{48})?$").matches(value)) {
                                return ParseResult.Invalid("invalid tx_payment_id")
                            }
                        }
                        else -> return ParseResult.Invalid("unsupported parameter: $key")
                    }
                }
            }
        }

        return ParseResult.Valid(
            ParsedMoneroUri(
                rawUri = raw,
                address = address,
                type = type,
                amount = amount,
                recipientName = recipientName,
                description = description,
            )
        )
    }

    internal fun base58Decode(input: String): ByteArray? {
        val fullBlocks = input.length / FULL_ENCODED
        val remChars = input.length % FULL_ENCODED
        val remBytes = ENCODED_SIZES.indexOf(remChars)
        if (remBytes < 0) return null
        val out = ByteArray(fullBlocks * FULL_BLOCK + remBytes)
        for (i in 0 until fullBlocks) {
            if (!decodeBlock(input.substring(i * FULL_ENCODED, (i + 1) * FULL_ENCODED), out, i * FULL_BLOCK, FULL_BLOCK)) {
                return null
            }
        }
        if (remChars > 0) {
            if (!decodeBlock(input.substring(fullBlocks * FULL_ENCODED), out, fullBlocks * FULL_BLOCK, remBytes)) {
                return null
            }
        }
        return out
    }

    private fun decodeBlock(chunk: String, out: ByteArray, offset: Int, size: Int): Boolean {
        var n = BigInteger.ZERO
        for (ch in chunk) {
            val d = ALPHABET.indexOf(ch)
            if (d < 0) return false
            n = n.multiply(FIFTY_EIGHT).add(BigInteger.valueOf(d.toLong()))
        }
        if (n.shiftRight(size * 8) != BigInteger.ZERO) return false
        for (i in size - 1 downTo 0) {
            out[offset + i] = (n.and(BigInteger.valueOf(0xff))).toByte()
            n = n.shiftRight(8)
        }
        return true
    }

    // ---- Pure Kotlin Keccak-256 (original Keccak padding 0x01, rate = 136 bytes) ----

    private val RC = longArrayOf(
        0x0000000000000001L, 0x0000000000008082L, -0x7fffffffffff7f76L, -0x7fffffff7fff8000L,
        0x000000000000808bL, 0x0000000080000001L, -0x7fffffff7fff7f7fL, -0x7fffffffffff7ff7L,
        0x000000000000008aL, 0x0000000000000088L, 0x0000000080008009L, 0x000000008000000aL,
        0x000000008000808bL, -0x7fffffffffffff75L, -0x7fffffffffff7f77L, -0x7fffffffffff7ffdL,
        -0x7fffffffffff7ffeL, -0x7fffffffffffff80L, 0x000000000000800aL, -0x7fffffff7ffffff6L,
        -0x7fffffff7fff7f7fL, -0x7fffffffffff7f80L, 0x0000000080000001L, -0x7fffffff7fff7ff8L,
    )

    private val ROT = intArrayOf(
        1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44
    )

    private val PILN = intArrayOf(
        10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1
    )

    internal fun keccak256(input: ByteArray): ByteArray {
        val state = LongArray(25)
        val rate = 136
        var offset = 0
        while (offset + rate <= input.size) {
            absorbBlock(state, input, offset, rate)
            keccakF1600(state)
            offset += rate
        }
        val block = ByteArray(rate)
        val rem = input.size - offset
        System.arraycopy(input, offset, block, 0, rem)
        block[rem] = (block[rem].toInt() xor 0x01).toByte()
        block[rate - 1] = (block[rate - 1].toInt() xor 0x80).toByte()
        absorbBlock(state, block, 0, rate)
        keccakF1600(state)

        val out = ByteArray(32)
        for (i in 0 until 4) {
            val lane = state[i]
            for (b in 0 until 8) {
                out[i * 8 + b] = ((lane ushr (b * 8)) and 0xffL).toByte()
            }
        }
        return out
    }

    private fun absorbBlock(state: LongArray, data: ByteArray, offset: Int, rate: Int) {
        val lanes = rate / 8
        for (i in 0 until lanes) {
            var lane = 0L
            val base = offset + i * 8
            for (b in 0 until 8) {
                lane = lane or ((data[base + b].toLong() and 0xffL) shl (b * 8))
            }
            state[i] = state[i] xor lane
        }
    }

    private fun keccakF1600(st: LongArray) {
        val bc = LongArray(5)
        for (round in 0 until 24) {
            // Theta
            for (i in 0 until 5) {
                bc[i] = st[i] xor st[i + 5] xor st[i + 10] xor st[i + 15] xor st[i + 20]
            }
            for (i in 0 until 5) {
                val t = bc[(i + 4) % 5] xor java.lang.Long.rotateLeft(bc[(i + 1) % 5], 1)
                for (j in 0 until 25 step 5) {
                    st[j + i] = st[j + i] xor t
                }
            }
            // Rho and Pi
            var t = st[1]
            for (i in 0 until 24) {
                val j = PILN[i]
                val tmp = st[j]
                st[j] = java.lang.Long.rotateLeft(t, ROT[i])
                t = tmp
            }
            // Chi
            for (j in 0 until 25 step 5) {
                for (i in 0 until 5) bc[i] = st[j + i]
                for (i in 0 until 5) {
                    st[j + i] = st[j + i] xor (bc[(i + 1) % 5].inv() and bc[(i + 2) % 5])
                }
            }
            // Iota
            st[0] = st[0] xor RC[round]
        }
    }
}
