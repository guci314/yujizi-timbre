package voice.core.extension.engine.crypto

import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * XChaCha20-Poly1305 (draft-irtf-cfrg-xchacha) on top of the platform
 * ChaCha20-Poly1305 cipher: HChaCha20 derives the subkey, then the standard
 * AEAD runs with a zero-prefixed 12-byte nonce.
 */
internal object XChaCha20 {

  private val CONSTANTS = intArrayOf(0x61707865, 0x3320646e, 0x79622d32, 0x6b206574)

  /** Derives a 32-byte subkey from a 32-byte key and a 16-byte nonce. */
  internal fun hChaCha20(
    key: ByteArray,
    nonce: ByteArray,
  ): ByteArray {
    require(key.size == 32) { "HChaCha20 key must be 32 bytes" }
    require(nonce.size == 16) { "HChaCha20 nonce must be 16 bytes" }
    val state = IntArray(16)
    CONSTANTS.copyInto(state, 0)
    for (i in 0 until 8) {
      state[4 + i] = littleEndianWord(key, i * 4)
    }
    for (i in 0 until 4) {
      state[12 + i] = littleEndianWord(nonce, i * 4)
    }
    val working = state.copyOf()
    repeat(10) {
      quarterRound(working, 0, 4, 8, 12)
      quarterRound(working, 1, 5, 9, 13)
      quarterRound(working, 2, 6, 10, 14)
      quarterRound(working, 3, 7, 11, 15)
      quarterRound(working, 0, 5, 10, 15)
      quarterRound(working, 1, 6, 11, 12)
      quarterRound(working, 2, 7, 8, 13)
      quarterRound(working, 3, 4, 9, 14)
    }
    val out = ByteArray(32)
    val words = intArrayOf(0, 1, 2, 3, 12, 13, 14, 15)
    for ((index, wordIndex) in words.withIndex()) {
      // no feedforward addition for HChaCha20 (draft-irtf-cfrg-xchacha section 2.2)
      putLittleEndianWord(out, index * 4, working[wordIndex])
    }
    return out
  }

  internal fun encrypt(
    key: ByteArray,
    nonce: ByteArray,
    plaintext: ByteArray,
    aad: ByteArray?,
  ): ByteArray = aead(Cipher.ENCRYPT_MODE, key, nonce, plaintext, aad)

  internal fun decrypt(
    key: ByteArray,
    nonce: ByteArray,
    ciphertextWithTag: ByteArray,
    aad: ByteArray?,
  ): ByteArray = aead(Cipher.DECRYPT_MODE, key, nonce, ciphertextWithTag, aad)

  private fun aead(
    mode: Int,
    key: ByteArray,
    nonce: ByteArray,
    data: ByteArray,
    aad: ByteArray?,
  ): ByteArray {
    require(key.size == 32) { "ChaCha20 key must be 32 bytes" }
    val subkey: ByteArray
    val nonce12: ByteArray
    when (nonce.size) {
      12 -> {
        subkey = key
        nonce12 = nonce
      }
      24 -> {
        subkey = hChaCha20(key, nonce.copyOfRange(0, 16))
        nonce12 = ByteArray(12)
        nonce.copyInto(nonce12, 4, 16, 24)
      }
      else -> throw IllegalArgumentException("ChaCha20 nonce must be 12 or 24 bytes")
    }
    val cipher = Cipher.getInstance("ChaCha20-Poly1305")
    cipher.init(mode, SecretKeySpec(subkey, "ChaCha20"), IvParameterSpec(nonce12))
    if (aad != null && aad.isNotEmpty()) {
      cipher.updateAAD(aad)
    }
    return cipher.doFinal(data)
  }

  private fun quarterRound(
    x: IntArray,
    a: Int,
    b: Int,
    c: Int,
    d: Int,
  ) {
    x[a] += x[b]
    x[d] = x[d] xor x[a]
    x[d] = (x[d] shl 16) or (x[d] ushr 16)
    x[c] += x[d]
    x[b] = x[b] xor x[c]
    x[b] = (x[b] shl 12) or (x[b] ushr 20)
    x[a] += x[b]
    x[d] = x[d] xor x[a]
    x[d] = (x[d] shl 8) or (x[d] ushr 24)
    x[c] += x[d]
    x[b] = x[b] xor x[c]
    x[b] = (x[b] shl 7) or (x[b] ushr 25)
  }

  private fun littleEndianWord(
    bytes: ByteArray,
    offset: Int,
  ): Int = (bytes[offset].toInt() and 0xff) or
    ((bytes[offset + 1].toInt() and 0xff) shl 8) or
    ((bytes[offset + 2].toInt() and 0xff) shl 16) or
    ((bytes[offset + 3].toInt() and 0xff) shl 24)

  private fun putLittleEndianWord(
    bytes: ByteArray,
    offset: Int,
    value: Int,
  ) {
    bytes[offset] = value.toByte()
    bytes[offset + 1] = (value ushr 8).toByte()
    bytes[offset + 2] = (value ushr 16).toByte()
    bytes[offset + 3] = (value ushr 24).toByte()
  }
}
