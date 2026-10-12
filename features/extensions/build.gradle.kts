plugins {
  id("voice.library")
  id("voice.compose")
  alias(libs.plugins.metro)
  alias(libs.plugins.kotlin.serialization)
}

dependencies {
  implementation(projects.core.ui)
  implementation(projects.core.common)
  implementation(projects.core.strings)
  implementation(projects.core.extension)
  implementation(projects.core.extensionEngine)
  implementation(projects.navigation)
}
