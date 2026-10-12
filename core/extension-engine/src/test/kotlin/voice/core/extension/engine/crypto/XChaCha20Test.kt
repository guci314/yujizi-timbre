package voice.core.extension.engine.crypto

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class XChaCha20Test {

  // draft-irtf-cfrg-xchacha section A.2 HChaCha20 test vector
  @Test
  fun hChaCha20Vector() {
    val key = (0 until 32).map { it.toByte() }.toByteArray()
    val nonce =
      "000000090000004a0000000031415927".hexToByteArray()
    val subkey = XChaCha20.hChaCha20(key, nonce)
    assertEquals(
      "82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc",
      subkey.toHexString(),
    )
  }

  // draft-irtf-cfrg-xchacha section A.3 XChaCha20-Poly1305 test vector
  @Test
  fun xChaCha20Poly1305Vector() {
    val key = (0x80 until 0xa0).map { it.toByte() }.toByteArray()
    val nonce = (0x40 until 0x58).map { it.toByte() }.toByteArray()
    val plaintext =
      (
        "Ladies and Gentlemen of the class of '99: If I could offer you " +
          "only one tip for the future, sunscreen would be it."
        ).toByteArray(Charsets.US_ASCII)
    val aad = "50515253c0c1c2c3c4c5c6c7".hexToByteArray()
    val expectedCiphertext =
      (
        "bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb" +
          "731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b45" +
          "22f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3ff" +
          "f921f9664c97637da9768812f615c68b13b52e"
        ).hexToByteArray()
    val expectedTag = "c0875924c1c7987947deafd8780acf49".hexToByteArray()

    val out = XChaCha20.encrypt(key, nonce, plaintext, aad)
    assertContentEquals(expectedCiphertext, out.copyOfRange(0, expectedCiphertext.size))
    assertContentEquals(expectedTag, out.copyOfRange(out.size - 16, out.size))
    assertContentEquals(plaintext, XChaCha20.decrypt(key, nonce, out, aad))
  }

  @Test
  fun plainChaCha20Poly1305RoundTrip() {
    val key = ByteArray(32) { (it * 7).toByte() }
    val nonce = ByteArray(12) { (it * 3).toByte() }
    val plaintext = "听友FM测试".toByteArray(Charsets.UTF_8)
    val out = XChaCha20.encrypt(key, nonce, plaintext, null)
    assertContentEquals(plaintext, XChaCha20.decrypt(key, nonce, out, null))
  }

  @Test
  fun rejectsWrongNonceLength() {
    assertFailsWith<IllegalArgumentException> {
      XChaCha20.encrypt(ByteArray(32), ByteArray(16), ByteArray(4), null)
    }
  }
}
