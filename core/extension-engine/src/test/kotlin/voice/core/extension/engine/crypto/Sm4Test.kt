package voice.core.extension.engine.crypto

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class Sm4Test {

  // GB/T 32907-2016 example: key = plaintext = 0123456789abcdeffedcba9876543210
  private val key = "0123456789abcdeffedcba9876543210".hexToByteArray()
  private val plaintext = "0123456789abcdeffedcba9876543210".hexToByteArray()
  private val ciphertext = "681edf34d206965e86b3e94f536e4246".hexToByteArray()

  @Test
  fun encryptsStandardVectorBlock() {
    // one block, no padding overhead: pad adds exactly one full block
    val out = Sm4.encrypt(plaintext, key)
    assertEquals(32, out.size)
    assertContentEquals(ciphertext, out.copyOfRange(0, 16))
  }

  @Test
  fun roundTripsArbitraryLengths() {
    for (length in listOf(0, 1, 15, 16, 17, 100, 1000)) {
      val data = ByteArray(length) { it.toByte() }
      val encrypted = Sm4.encrypt(data, key)
      assertEquals(((length / 16) + 1) * 16, encrypted.size, "length=$length")
      assertContentEquals(data, Sm4.decrypt(encrypted, key), "length=$length")
    }
  }

  @Test
  fun rejectsBadPadding() {
    val corrupted = Sm4.encrypt(plaintext, key)
    corrupted[corrupted.size - 1] = 0 // padding byte must be 0x10 here
    assertFailsWith<IllegalArgumentException> { Sm4.decrypt(corrupted, key) }
  }

  @Test
  fun rejectsWrongKeySize() {
    assertFailsWith<IllegalArgumentException> { Sm4.encrypt(plaintext, ByteArray(15)) }
  }
}
