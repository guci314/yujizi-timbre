#!/usr/bin/env kotlin
// Packs a directory (manifest.json + scripts) into a .jdr package:
//   kotlin scripts/pack_jdr.main.kts samples/itingshu itingshu.jdr
@file:Suppress("SimplifyBooleanWithConstants")

import java.io.File
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

val dir = File(args.getOrNull(0) ?: error("用法: pack_jdr.main.kts <目录> <输出.jdr>"))
val output = File(args.getOrNull(1) ?: error("用法: pack_jdr.main.kts <目录> <输出.jdr>"))

require(dir.isDirectory) { "不是目录: $dir" }
require(!dir.listFiles().isNullOrEmpty()) { "目录为空: $dir" }

ZipOutputStream(output.outputStream().buffered()).use { zip ->
  dir.walkTopDown()
    .filter { it.isFile }
    .sortedBy { it.relativeTo(dir).invariantSeparatorsPath }
    .forEach { file ->
      val name = file.relativeTo(dir).invariantSeparatorsPath
      require(!name.contains("..") && !name.startsWith("/")) { "非法文件名: $name" }
      zip.putNextEntry(ZipEntry(name))
      file.inputStream().use { it.copyTo(zip) }
      zip.closeEntry()
      println("  + $name (${file.length()} bytes)")
    }
}
println("已生成 ${output.absolutePath} (${output.length()} bytes)")
