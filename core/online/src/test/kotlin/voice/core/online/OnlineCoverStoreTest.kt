package voice.core.online

import kotlinx.coroutines.test.runTest
import kotlin.io.path.createTempDirectory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class OnlineCoverStoreTest {

  private val baseDir = createTempDirectory("online-covers").toFile()
  private val store = OnlineCoverStore(baseDir)

  @Test
  fun `a written cover is read back and survives a new store instance`() = runTest {
    val bytes = byteArrayOf(1, 2, 3, -42)
    val file = assertNotNull(store.write("A::b1", bytes))

    assertEquals(file, store.file("A::b1"))
    val reloaded = OnlineCoverStore(baseDir)
    assertEquals(file, reloaded.file("A::b1"))
  }

  @Test
  fun `empty bytes are rejected`() = runTest {
    assertNull(store.write("A::b1", ByteArray(0)))
    assertNull(store.file("A::b1"))
  }

  @Test
  fun `overwriting replaces the bytes`() = runTest {
    val _ = store.write("A::b1", byteArrayOf(1))
    val second = assertNotNull(store.write("A::b1", byteArrayOf(2, 2)))

    assertEquals(second, store.file("A::b1"))
    assertEquals(listOf<Byte>(2, 2), store.file("A::b1")!!.readBytes().toList())
  }

  @Test
  fun `remove deletes the file`() = runTest {
    val _ = store.write("A::b1", byteArrayOf(1))
    assertNotNull(store.file("A::b1"))

    store.remove("A::b1")

    assertNull(store.file("A::b1"))
  }
}
