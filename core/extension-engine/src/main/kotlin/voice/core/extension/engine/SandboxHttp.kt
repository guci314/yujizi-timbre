package voice.core.extension.engine

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.FormBody
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/**
 * The http bridge source scripts use. Options and the response cross the JS
 * boundary as JSON strings:
 * options = `{params?, headers?, body?, json?, form?, timeoutMs?}`,
 * response = `{status, headers, body}`.
 */
public fun interface SandboxHttp {

  public suspend fun request(
    method: String,
    url: String,
    optionsJson: String,
  ): String
}

private const val MAX_RESPONSE_BYTES = 10L * 1024 * 1024
private const val DEFAULT_TIMEOUT_MS = 30_000L

public class OkHttpSandboxHttp(baseClient: OkHttpClient) : SandboxHttp {

  private val baseClient = baseClient.newBuilder().build()

  override suspend fun request(
    method: String,
    url: String,
    optionsJson: String,
  ): String {
    val options: JsonObject = if (optionsJson.isBlank()) {
      JsonObject(emptyMap())
    } else {
      Json.parseToJsonElement(optionsJson).jsonObject
    }
    val timeoutMs = options["timeoutMs"]?.jsonPrimitive?.content?.toLongOrNull() ?: DEFAULT_TIMEOUT_MS
    val httpUrl = url.toHttpUrl()
    val urlBuilder = httpUrl.newBuilder()
    options["params"]?.jsonObject?.forEach { (name, value) ->
      urlBuilder.addQueryParameter(name, value.jsonPrimitive.content)
    }
    val client = baseClient.newBuilder()
      .callTimeout(timeoutMs, TimeUnit.MILLISECONDS)
      .build()
    val builder = Request.Builder().url(urlBuilder.build())
    options["headers"]?.jsonObject?.forEach { (name, value) ->
      builder.header(name, value.jsonPrimitive.content)
    }
    val body = when {
      options["json"] != null -> {
        options["json"].toString()
          .toRequestBody("application/json; charset=utf-8".toMediaType())
      }
      options["form"] != null -> {
        val form = FormBody.Builder()
        options["form"]?.jsonObject?.forEach { (name, value) ->
          form.add(name, value.jsonPrimitive.content)
        }
        form.build()
      }
      options["body"] != null -> {
        options["body"]?.jsonPrimitive?.content
          ?.toRequestBody("application/octet-stream".toMediaType())
      }
      method.equals("POST", ignoreCase = true) -> ByteArray(0).toRequestBody(null)
      else -> null
    }
    builder.method(method.uppercase(), body)
    return withContext(Dispatchers.IO) {
      client.newCall(builder.build()).execute().use { response ->
        val source = response.body.source()
        source.request(MAX_RESPONSE_BYTES + 1)
        check(source.buffer.size <= MAX_RESPONSE_BYTES) { "响应超过 ${MAX_RESPONSE_BYTES / 1024 / 1024}MB 上限: $url" }
        val text = source.readUtf8()
        val headers = buildJsonObject {
          // duplicate header names (set-cookie!) are joined, not overwritten
          val merged = LinkedHashMap<String, String>()
          response.headers.forEach { (name, value) ->
            val key = name.lowercase()
            merged[key] = merged[key]?.let { "$it, $value" } ?: value
          }
          merged.forEach { (name, value) -> put(name, value) }
        }
        buildJsonObject {
          put("status", response.code)
          put("headers", headers)
          put("body", text)
        }.toString()
      }
    }
  }
}
