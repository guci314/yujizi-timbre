package voice.core.extension.engine.crypto

import java.net.URLDecoder
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Crypto operations exposed to source scripts. All inputs/outputs are raw
 * bytes; the JS prelude converts to and from base64/hex strings.
 */
public object CryptoOps {

  private val random = SecureRandom()

  public fun md5Hex(text: String): String = digestHex("MD5") { it.update(text.toByteArray(Charsets.UTF_8)) }

  public fun sha256Hex(text: String): String = digestHex("SHA-256") { it.update(text.toByteArray(Charsets.UTF_8)) }

  public fun hmacSha256Hex(
    keyText: String,
    text: String,
  ): String {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(keyText.toByteArray(Charsets.UTF_8), "HmacSHA256"))
    return mac.doFinal(text.toByteArray(Charsets.UTF_8)).toHexString()
  }

  public fun aesEcbEncrypt(
    data: ByteArray,
    key: ByteArray,
  ): ByteArray {
    val cipher = Cipher.getInstance("AES/ECB/PKCS5Padding")
    cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"))
    return cipher.doFinal(data)
  }

  public fun aesEcbDecrypt(
    data: ByteArray,
    key: ByteArray,
  ): ByteArray {
    val cipher = Cipher.getInstance("AES/ECB/PKCS5Padding")
    cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"))
    return cipher.doFinal(data)
  }

  /** Returns ciphertext with the 16-byte GCM tag appended. */
  public fun aesGcmEncrypt(
    key: ByteArray,
    nonce: ByteArray,
    plaintext: ByteArray,
    aad: ByteArray?,
  ): ByteArray = gcm(Cipher.ENCRYPT_MODE, key, nonce, plaintext, aad)

  public fun aesGcmDecrypt(
    key: ByteArray,
    nonce: ByteArray,
    ciphertextWithTag: ByteArray,
    aad: ByteArray?,
  ): ByteArray = gcm(Cipher.DECRYPT_MODE, key, nonce, ciphertextWithTag, aad)

  /** ChaCha20-Poly1305 with a 12-byte nonce, XChaCha20-Poly1305 with a 24-byte nonce. */
  public fun chacha20Encrypt(
    key: ByteArray,
    nonce: ByteArray,
    plaintext: ByteArray,
    aad: ByteArray?,
  ): ByteArray = XChaCha20.encrypt(key, nonce, plaintext, aad)

  public fun chacha20Decrypt(
    key: ByteArray,
    nonce: ByteArray,
    ciphertextWithTag: ByteArray,
    aad: ByteArray?,
  ): ByteArray = XChaCha20.decrypt(key, nonce, ciphertextWithTag, aad)

  public fun sm4EcbEncrypt(
    data: ByteArray,
    key: ByteArray,
  ): ByteArray = Sm4.encrypt(data, key)

  public fun sm4EcbDecrypt(
    data: ByteArray,
    key: ByteArray,
  ): ByteArray = Sm4.decrypt(data, key)

  public fun randomBytes(length: Int): ByteArray {
    require(length in 0..65536) { "randomBytes length out of range: $length" }
    return ByteArray(length).also(random::nextBytes)
  }

  // The charset is passed by its name on purpose: the (String, Charset) overloads of
  // URLEncoder/URLDecoder only exist from API 33 on, so calling them throws
  // NoSuchMethodError on older devices (minSdk 28) and kills the app.
  public fun urlEncode(text: String): String = URLEncoder.encode(text, Charsets.UTF_8.name()).replace("+", "%20")

  public fun urlDecode(text: String): String = URLDecoder.decode(text, Charsets.UTF_8.name())

  private inline fun digestHex(
    algorithm: String,
    update: (MessageDigest) -> Unit,
  ): String {
    val digest = MessageDigest.getInstance(algorithm)
    update(digest)
    return digest.digest().toHexString()
  }

  private fun gcm(
    mode: Int,
    key: ByteArray,
    nonce: ByteArray,
    data: ByteArray,
    aad: ByteArray?,
  ): ByteArray {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(mode, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
    if (aad != null && aad.isNotEmpty()) {
      cipher.updateAAD(aad)
    }
    return cipher.doFinal(data)
  }
}

public fun ByteArray.toHexString(): String {
  val out = CharArray(size * 2)
  val digits = "0123456789abcdef"
  for (i in indices) {
    val b = this[i].toInt() and 0xff
    out[i * 2] = digits[b ushr 4]
    out[i * 2 + 1] = digits[b and 0xf]
  }
  return String(out)
}

public fun String.hexToByteArray(): ByteArray {
  require(length % 2 == 0) { "Hex string length must be even" }
  return ByteArray(length / 2) { i ->
    val hi = Character.digit(this[i * 2], 16)
    val lo = Character.digit(this[i * 2 + 1], 16)
    require(hi >= 0 && lo >= 0) { "Invalid hex string" }
    ((hi shl 4) or lo).toByte()
  }
}
