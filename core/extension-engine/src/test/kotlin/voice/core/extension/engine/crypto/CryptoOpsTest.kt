package voice.core.extension.engine.crypto

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class CryptoOpsTest {

  @Test
  fun md5() {
    assertEquals("900150983cd24fb0d6963f7d28e17f72", CryptoOps.md5Hex("abc"))
    assertEquals("d41d8cd98f00b204e9800998ecf8427e", CryptoOps.md5Hex(""))
  }

  @Test
  fun sha256() {
    assertEquals(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      CryptoOps.sha256Hex("abc"),
    )
  }

  @Test
  fun aesEcbFips197Vector() {
    // FIPS-197 appendix C.1 (no padding path checked through the raw block):
    // PKCS#7 adds a full block for an exact 16-byte input, so encrypt 16 bytes
    // and expect the FIPS block followed by an encrypted padding block.
    val key = "000102030405060708090a0b0c0d0e0f".hexToByteArray()
    val plaintext = "00112233445566778899aabbccddeeff".hexToByteArray()
    val out = CryptoOps.aesEcbEncrypt(plaintext, key)
    assertEquals(32, out.size)
    assertEquals("69c4e0d86a7b0430d8cdb78070b4c55a", out.copyOfRange(0, 16).toHexString())
    assertContentEquals(plaintext, CryptoOps.aesEcbDecrypt(out, key))
  }

  @Test
  fun aesEcbUtf8KeyLikeSourceScripts() {
    // mirrors the itingshu audio request: 16-char ascii key, utf8 payload
    val key = "ag5fmPpUrWwDAMY6".toByteArray(Charsets.UTF_8)
    val plaintext = "2.6.5-1699999999-0123456789abcdef0123456789abcdef"
    val encrypted = CryptoOps.aesEcbEncrypt(plaintext.toByteArray(Charsets.UTF_8), key)
    assertContentEquals(plaintext.toByteArray(Charsets.UTF_8), CryptoOps.aesEcbDecrypt(encrypted, key))
  }

  @Test
  fun aesGcmVector() {
    // NIST GCM test case: known key/iv/plaintext, ct||tag must decrypt back
    val key = "feffe9928665731c6d6a8f9467308308".hexToByteArray()
    val nonce = "cafebabefacedbaddecaf888".hexToByteArray()
    val plaintext =
      (
        "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a72" +
          "1c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39"
        )
        .hexToByteArray()
    val out = CryptoOps.aesGcmEncrypt(key, nonce, plaintext, null)
    assertEquals(plaintext.size + 16, out.size)
    assertContentEquals(plaintext, CryptoOps.aesGcmDecrypt(key, nonce, out, null))
  }

  @Test
  fun aesGcmDetectsTampering() {
    val key = ByteArray(16) { it.toByte() }
    val nonce = ByteArray(12) { (it + 1).toByte() }
    val out = CryptoOps.aesGcmEncrypt(key, nonce, "payload".toByteArray(), null)
    out[0] = (out[0].toInt() xor 1).toByte()
    assertFailsWith<Exception> { CryptoOps.aesGcmDecrypt(key, nonce, out, null) }
  }

  @Test
  fun urlEncodeDecode() {
    assertEquals("%E6%96%97%E7%BD%97", CryptoOps.urlEncode("斗罗"))
    assertEquals("a%20b", CryptoOps.urlEncode("a b"))
    assertEquals("斗罗", CryptoOps.urlDecode(CryptoOps.urlEncode("斗罗")))
  }
}
