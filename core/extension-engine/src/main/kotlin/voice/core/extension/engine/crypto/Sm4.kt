package voice.core.extension.engine.crypto

/**
 * SM4 block cipher (GB/T 32907-2016), ECB mode with PKCS#7 padding.
 * Some audio source APIs (device fingerprints, signed requests) use it.
 */
internal object Sm4 {

  private val SBOX = intArrayOf(
    0xd6, 0x90, 0xe9, 0xfe, 0xcc, 0xe1, 0x3d, 0xb7, 0x16, 0xb6, 0x14, 0xc2, 0x28, 0xfb, 0x2c, 0x05,
    0x2b, 0x67, 0x9a, 0x76, 0x2a, 0xbe, 0x04, 0xc3, 0xaa, 0x44, 0x13, 0x26, 0x49, 0x86, 0x06, 0x99,
    0x9c, 0x42, 0x50, 0xf4, 0x91, 0xef, 0x98, 0x7a, 0x33, 0x54, 0x0b, 0x43, 0xed, 0xcf, 0xac, 0x62,
    0xe4, 0xb3, 0x1c, 0xa9, 0xc9, 0x08, 0xe8, 0x95, 0x80, 0xdf, 0x94, 0xfa, 0x75, 0x8f, 0x3f, 0xa6,
    0x47, 0x07, 0xa7, 0xfc, 0xf3, 0x73, 0x17, 0xba, 0x83, 0x59, 0x3c, 0x19, 0xe6, 0x85, 0x4f, 0xa8,
    0x68, 0x6b, 0x81, 0xb2, 0x71, 0x64, 0xda, 0x8b, 0xf8, 0xeb, 0x0f, 0x4b, 0x70, 0x56, 0x9d, 0x35,
    0x1e, 0x24, 0x0e, 0x5e, 0x63, 0x58, 0xd1, 0xa2, 0x25, 0x22, 0x7c, 0x3b, 0x01, 0x21, 0x78, 0x87,
    0xd4, 0x00, 0x46, 0x57, 0x9f, 0xd3, 0x27, 0x52, 0x4c, 0x36, 0x02, 0xe7, 0xa0, 0xc4, 0xc8, 0x9e,
    0xea, 0xbf, 0x8a, 0xd2, 0x40, 0xc7, 0x38, 0xb5, 0xa3, 0xf7, 0xf2, 0xce, 0xf9, 0x61, 0x15, 0xa1,
    0xe0, 0xae, 0x5d, 0xa4, 0x9b, 0x34, 0x1a, 0x55, 0xad, 0x93, 0x32, 0x30, 0xf5, 0x8c, 0xb1, 0xe3,
    0x1d, 0xf6, 0xe2, 0x2e, 0x82, 0x66, 0xca, 0x60, 0xc0, 0x29, 0x23, 0xab, 0x0d, 0x53, 0x4e, 0x6f,
    0xd5, 0xdb, 0x37, 0x45, 0xde, 0xfd, 0x8e, 0x2f, 0x03, 0xff, 0x6a, 0x72, 0x6d, 0x6c, 0x5b, 0x51,
    0x8d, 0x1b, 0xaf, 0x92, 0xbb, 0xdd, 0xbc, 0x7f, 0x11, 0xd9, 0x5c, 0x41, 0x1f, 0x10, 0x5a, 0xd8,
    0x0a, 0xc1, 0x31, 0x88, 0xa5, 0xcd, 0x7b, 0xbd, 0x2d, 0x74, 0xd0, 0x12, 0xb8, 0xe5, 0xb4, 0xb0,
    0x89, 0x69, 0x97, 0x4a, 0x0c, 0x96, 0x77, 0x7e, 0x65, 0xb9, 0xf1, 0x09, 0xc5, 0x6e, 0xc6, 0x84,
    0x18, 0xf0, 0x7d, 0xec, 0x3a, 0xdc, 0x4d, 0x20, 0x79, 0xee, 0x5f, 0x3e, 0xd7, 0xcb, 0x39, 0x48,
  )

  private val FK = intArrayOf(
    0xa3b1bac6.toInt(),
    0x56aa3350,
    0x677d9197,
    0xb27022dc.toInt(),
  )

  /** CK[i] = word from bytes ((4i+j)*7 mod 256) for j = 0..3, big-endian, per the spec. */
  private val CK = IntArray(32) { i ->
    (0..3).sumOf { j -> (((4 * i + j) * 7) % 256) shl (8 * (3 - j)) }
  }

  private fun rotl(
    x: Int,
    n: Int,
  ): Int = (x shl n) or (x ushr (32 - n))

  private fun tau(a: Int): Int = (SBOX[(a ushr 24) and 0xff] shl 24) or
    (SBOX[(a ushr 16) and 0xff] shl 16) or
    (SBOX[(a ushr 8) and 0xff] shl 8) or
    SBOX[a and 0xff]

  private fun tEnc(a: Int): Int {
    val b = tau(a)
    return b xor rotl(b, 2) xor rotl(b, 10) xor rotl(b, 18) xor rotl(b, 24)
  }

  private fun tKey(a: Int): Int {
    val b = tau(a)
    return b xor rotl(b, 13) xor rotl(b, 23)
  }

  private fun word(
    block: ByteArray,
    offset: Int,
  ): Int = ((block[offset].toInt() and 0xff) shl 24) or
    ((block[offset + 1].toInt() and 0xff) shl 16) or
    ((block[offset + 2].toInt() and 0xff) shl 8) or
    (block[offset + 3].toInt() and 0xff)

  private fun putWord(
    block: ByteArray,
    offset: Int,
    value: Int,
  ) {
    block[offset] = (value ushr 24).toByte()
    block[offset + 1] = (value ushr 16).toByte()
    block[offset + 2] = (value ushr 8).toByte()
    block[offset + 3] = value.toByte()
  }

  private fun expandKey(key: ByteArray): IntArray {
    require(key.size == 16) { "SM4 key must be 16 bytes" }
    val k = IntArray(4) { word(key, it * 4) xor FK[it] }
    val roundKeys = IntArray(32)
    for (i in 0 until 32) {
      val next = k[0] xor tKey(k[1] xor k[2] xor k[3] xor CK[i])
      roundKeys[i] = next
      k[0] = k[1]
      k[1] = k[2]
      k[2] = k[3]
      k[3] = next
    }
    return roundKeys
  }

  private fun cryptBlock(
    roundKeys: IntArray,
    inBlock: ByteArray,
    inOffset: Int,
    outBlock: ByteArray,
    outOffset: Int,
  ) {
    var x0 = word(inBlock, inOffset)
    var x1 = word(inBlock, inOffset + 4)
    var x2 = word(inBlock, inOffset + 8)
    var x3 = word(inBlock, inOffset + 12)
    for (i in 0 until 32) {
      val next = x0 xor tEnc(x1 xor x2 xor x3 xor roundKeys[i])
      x0 = x1
      x1 = x2
      x2 = x3
      x3 = next
    }
    putWord(outBlock, outOffset, x3)
    putWord(outBlock, outOffset + 4, x2)
    putWord(outBlock, outOffset + 8, x1)
    putWord(outBlock, outOffset + 12, x0)
  }

  internal fun encrypt(
    data: ByteArray,
    key: ByteArray,
  ): ByteArray {
    val roundKeys = expandKey(key)
    val padded = padPkcs7(data)
    val out = ByteArray(padded.size)
    for (offset in padded.indices step 16) {
      cryptBlock(roundKeys, padded, offset, out, offset)
    }
    return out
  }

  internal fun decrypt(
    data: ByteArray,
    key: ByteArray,
  ): ByteArray {
    val roundKeys = expandKey(key).reversedArray()
    require(data.size % 16 == 0 && data.isNotEmpty()) { "SM4 ciphertext must be a positive multiple of 16 bytes" }
    val out = ByteArray(data.size)
    for (offset in data.indices step 16) {
      cryptBlock(roundKeys, data, offset, out, offset)
    }
    return unpadPkcs7(out)
  }

  private fun padPkcs7(data: ByteArray): ByteArray {
    val padLen = 16 - (data.size % 16)
    val out = ByteArray(data.size + padLen)
    data.copyInto(out)
    out.fill(padLen.toByte(), data.size, out.size)
    return out
  }

  private fun unpadPkcs7(data: ByteArray): ByteArray {
    val padLen = data.last().toInt() and 0xff
    if (padLen !in 1..16 || padLen > data.size) {
      throw IllegalArgumentException("Invalid SM4 PKCS#7 padding")
    }
    for (i in data.size - padLen until data.size) {
      if ((data[i].toInt() and 0xff) != padLen) {
        throw IllegalArgumentException("Invalid SM4 PKCS#7 padding")
      }
    }
    return data.copyOf(data.size - padLen)
  }
}
