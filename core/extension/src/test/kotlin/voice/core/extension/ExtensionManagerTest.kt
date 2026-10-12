package voice.core.extension

import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.test.runTest
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.ByteArrayOutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
class ExtensionManagerTest {

  private val application = org.robolectric.RuntimeEnvironment.getApplication()
  private val manager = ExtensionManager(application, ExtensionStoreFactory(application))

  private fun zip(vararg entries: Pair<String, String>): ByteArray {
    val out = ByteArrayOutputStream()
    ZipOutputStream(out).use { z ->
      entries.forEach { (name, content) ->
        z.putNextEntry(ZipEntry(name))
        z.write(content.toByteArray(Charsets.UTF_8))
        z.closeEntry()
      }
    }
    return out.toByteArray()
  }

  private fun manifest(
    id: String,
    sourceId: String,
    version: String = "1.0.0",
  ) = """{"id":"$id","name":"包$id","version":"$version","sources":
       [{"id":"$sourceId","name":"源$sourceId","script":"s.js"}]}"""

  private val script = """
    ;(() => { registerSource({ id: 'SRC', async search() { return [] } }) })()
  """.trimIndent()

  @Test
  fun installWritesFilesAndRegisters() = runTest {
    val bytes = zip(
      "manifest.json" to manifest("com.test.one", "one"),
      "s.js" to script.replace("SRC", "one"),
    )
    val manifest = manager.install(bytes)
    assertEquals("com.test.one", manifest.id)
    assertEquals(1, manager.installed().size)
    assertTrue(manager.packageDir("com.test.one").resolve("s.js").isFile)
    assertEquals("one", manager.packageFor("one")?.manifest?.sources?.single()?.id)
  }

  @Test
  fun sourceIdConflictAcrossPackagesIsRejected() = runTest {
    val seeded = manager.install(
      zip(
        "manifest.json" to manifest("com.test.one", "shared"),
        "s.js" to script.replace("SRC", "shared"),
      ),
    )
    assertEquals("com.test.one", seeded.id)
    val e = assertFailsWith<ExtensionInstallException> {
      manager.install(
        zip(
          "manifest.json" to manifest("com.test.two", "shared"),
          "s.js" to script.replace("SRC", "shared"),
        ),
      )
    }
    assertTrue(e.message!!.contains("shared"), e.message)
    assertEquals(1, manager.installed().size)
  }

  @Test
  fun samePackageIdUpdatesInPlaceAndKeepsEnabledState() = runTest {
    val first = zip(
      "manifest.json" to manifest("com.test.one", "one", version = "1.0.0"),
      "s.js" to script.replace("SRC", "one"),
    )
    val seeded = manager.install(first)
    assertEquals("1.0.0", seeded.version)
    manager.setSourceEnabled("one", false)
    assertNull(manager.packageFor("one"))

    val updated = manager.install(
      zip(
        "manifest.json" to manifest("com.test.one", "one", version = "1.1.0"),
        "s.js" to script.replace("SRC", "one"),
      ),
    )
    assertEquals("1.1.0", updated.version)
    assertEquals(1, manager.installed().size)
    assertEquals("1.1.0", manager.installed().single().manifest.version)
    // the disabled flag survives the update
    assertNull(manager.packageFor("one"))
  }

  @Test
  fun uninstallRemovesEverything() = runTest {
    val manifest = manager.install(
      zip(
        "manifest.json" to manifest("com.test.one", "one"),
        "s.js" to script.replace("SRC", "one"),
      ),
    )
    assertEquals("com.test.one", manifest.id)
    manager.uninstall("com.test.one")
    assertEquals(0, manager.installed().size)
    assertTrue(!manager.packageDir("com.test.one").exists())
  }

  @Test
  fun corruptPackageIsRejected() = runTest {
    assertFailsWith<ExtensionInstallException> { manager.install("not a zip".toByteArray()) }
    assertFailsWith<ExtensionInstallException> { manager.install(ByteArray(0)) }
  }
}
