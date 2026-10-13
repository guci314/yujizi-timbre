package voice.app.yujizi

/** 内置玉机子源的常量：装配（[YujiziSetupOnAppStart]）与完整性校验共用一处。 */
internal object YujiziSource {

  /** 扩展源在 App 内的寻址名，前缀见 ExtensionEngineProvider.SOURCE_PREFIX。 */
  const val SOURCE_NAME = "jdr:yujizi"

  /** 源 id，必须与 yujizi.jdr 里 manifest 的 sources[].id 一致。 */
  const val SOURCE_ID = "yujizi"

  /** 扩展包 id，必须与 yujizi.jdr 里 manifest 的 id 一致。 */
  const val MANIFEST_ID = "org.yujizi.source"

  /** 打进 assets 的接口源包名，由 scripts/make_yujizi_jdr.py 生成。 */
  const val JDR_ASSET = "yujizi.jdr"

  /** 打进 assets 的完整性清单，由 scripts/make_yujizi_integrity.py 生成。 */
  const val INTEGRITY_ASSET = "yujizi_integrity.json"
}
