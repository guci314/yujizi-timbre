plugins {
  id("voice.library")
  alias(libs.plugins.metro)
  alias(libs.plugins.kotlin.serialization)
}

kotlin {
  explicitApi()
}

dependencies {
  implementation(projects.core.extensionEngine)
  implementation(projects.core.common)
  implementation(projects.core.online)
  implementation(projects.core.initializer)

  implementation(libs.okhttp)
  implementation(libs.serialization.json)
  implementation(libs.datastore)
}
