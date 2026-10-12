package voice.core.extension.engine

import com.dokar.quickjs.QuickJs
import com.dokar.quickjs.binding.asyncFunction
import com.dokar.quickjs.binding.define
import com.dokar.quickjs.binding.function
import com.dokar.quickjs.quickJs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/** Spike: verifies the quickjs-kt API shape we build the sandbox on. */
class QuickJsSpikeTest {

  @Test
  fun evaluatesArithmetic() = runTest {
    val result: Int = quickJs { evaluate("1 + 2") }
    assertEquals(3, result)
  }

  @Test
  fun syncBindingReceivesArgs() = runTest {
    val result: String = quickJs {
      define("test") {
        function("join") { args -> args.joinToString("|") { it?.toString() ?: "null" } }
      }
      evaluate("test.join('a', 1, null)")
    }
    assertEquals("a|1|null", result)
  }

  @Test
  fun asyncBindingWithTopLevelAwait() = runTest {
    val result: String = quickJs {
      define("http") {
        asyncFunction("get") { args ->
          delay(10)
          """{"status":200,"body":"ok","url":"${args[0]}"}"""
        }
      }
      evaluate("await http.get('https://example.com')")
    }
    assertTrue(result.contains("\"body\":\"ok\""), result)
  }

  @Test
  fun jsonRoundTripAcrossBoundary() = runTest {
    val result: String = quickJs {
      define("host") {
        function("upper") { args -> (args[0] as String).uppercase() }
      }
      evaluate(
        """
        const p = JSON.parse('{"keyword":"douluo","page":2}');
        await host.upper(JSON.stringify({keyword: p.keyword, page: p.page}))
        """.trimIndent(),
      )
    }
    assertTrue(result.contains("KEYWORD"), result)
  }

  @Test
  fun jsErrorSurfacesAsException() = runTest {
    assertFailsWith<Exception> {
      quickJs { evaluate("throw new Error('boom')") }
    }
  }

  @Test
  fun longLivedInstanceKeepsStateAndRunsOnSingleThread() = runTest {
    val engineDispatcher = Dispatchers.Default.limitedParallelism(1)
    val quickJs = QuickJs.create(jobDispatcher = engineDispatcher)
    try {
      withContext(engineDispatcher) {
        quickJs.evaluate<Unit>("var counter = 0; function inc() { counter += 1 }")
        quickJs.evaluate<Unit>("inc(); inc()")
      }
      assertEquals(2, withContext(engineDispatcher) { quickJs.evaluate<Int>("counter") })
    } finally {
      quickJs.close()
    }
  }
}
