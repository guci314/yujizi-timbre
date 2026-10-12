package voice.core.online

import java.security.MessageDigest

/**
 * Book keys are source controlled and can contain any character (a book id
 * may be a path, a CJK string, a signed url fragment): file names of the
 * per-book stores are hashes of the key.
 */
internal fun hashedFileName(key: String): String {
  val digest = MessageDigest.getInstance("SHA-256").digest(key.toByteArray(Charsets.UTF_8))
  return digest.joinToString(separator = "") { byte -> "%02x".format(byte) }
}
