import org.gradle.api.tasks.testing.Test
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.tasks.KotlinCompile

plugins {
  alias(libs.plugins.kotlin.jvm)
  alias(libs.plugins.kotlin.serialization)
  id("voice.ktlint")
}

kotlin {
  explicitApi()
  jvmToolchain {
    languageVersion.set(JavaLanguageVersion.of(libs.versions.jvm.toolchain.get().toInt()))
  }
}

java {
  sourceCompatibility = JavaVersion.toVersion(libs.versions.jvm.bytecode.get())
  targetCompatibility = JavaVersion.toVersion(libs.versions.jvm.bytecode.get())
}

tasks.withType<KotlinCompile>().configureEach {
  compilerOptions {
    jvmTarget.set(JvmTarget.fromTarget(libs.versions.jvm.bytecode.get()))
    freeCompilerArgs.addAll(
      "-Xreturn-value-checker=full",
    )
    optIn.addAll(
      listOf(
        "kotlin.RequiresOptIn",
        "kotlin.ExperimentalStdlibApi",
        "kotlin.contracts.ExperimentalContracts",
        "kotlin.time.ExperimentalTime",
        "kotlinx.coroutines.ExperimentalCoroutinesApi",
        "kotlinx.coroutines.FlowPreview",
      ),
    )
    allWarningsAsErrors.set(providers.gradleProperty("voice.warningsAsErrors").map(String::toBooleanStrict))
  }
}

tasks.withType(Test::class.java).configureEach {
  maxParallelForks = (Runtime.getRuntime().availableProcessors() / 2).coerceAtLeast(1)
}

dependencies {
  implementation(libs.quickjs.kt)
  implementation(libs.coroutines.core)
  implementation(libs.okhttp)
  implementation(libs.serialization.json)

  testImplementation(libs.kotlin.testJunit)
  testImplementation(libs.coroutines.test)
  testImplementation(libs.mockwebserver)
}
