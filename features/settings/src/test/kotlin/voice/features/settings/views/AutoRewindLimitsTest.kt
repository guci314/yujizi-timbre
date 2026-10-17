package voice.features.settings.views

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class AutoRewindLimitsTest {

  @Test
  fun `auto rewind selectable upper limit is one minute`() {
    assertEquals(expected = 60, actual = AutoRewindLimits.MAX_SECONDS)
  }

  @Test
  fun `auto rewind selectable lower limit is zero`() {
    assertEquals(expected = 0, actual = AutoRewindLimits.MIN_SECONDS)
  }

  @Test
  fun `legacy saved values stay selectable without clamping`() {
    val legacyLimit = 20
    val storeDefault = 2

    (0..legacyLimit).forEach { seconds ->
      assertEquals(
        expected = seconds,
        actual = seconds.coerceIn(AutoRewindLimits.MIN_SECONDS, AutoRewindLimits.MAX_SECONDS),
      )
    }
    assertTrue(storeDefault in AutoRewindLimits.MIN_SECONDS..AutoRewindLimits.MAX_SECONDS)
  }
}
