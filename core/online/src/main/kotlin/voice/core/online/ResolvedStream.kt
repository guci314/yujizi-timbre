package voice.core.online

/**
 * A resolved chapter stream: the direct url plus the http headers the source
 * script asked the player to send when fetching it (e.g. a Referer for
 * hotlink-protected CDNs). Empty [headers] means a plain headerless request,
 * exactly what sources that only return a url always got.
 */
public data class ResolvedStream(
  val url: String,
  val headers: Map<String, String> = emptyMap(),
)
