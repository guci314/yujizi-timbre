# 接口源（.jdr 扩展包）设计方案

> 动手写源看这里：**`samples/README.md`**（开发套件首页：编写接口、打包 .jdr、导入验证，含 Python→JS 对照实例）。

## 目标

让播放器支持导入第三方「接口源」：每个源由 JS 脚本实现 **搜索 / 获取章节 / 音频直链** 三个阶段，
打包成 `.jdr` 文件（ZIP + manifest.json），可从本机文件或网络链接导入。
源脚本在设备本地执行，所有请求从用户本机 IP 直连源站 API —— **与卡密下载服务器完全无关**，
服务器源（原 A/B 接口）逻辑保持不变，且不配置服务器也不影响扩展源的使用。

## 总体结构

```
搜索UI(源chip) ──> OnlineSourceService
   ├─ source=="A"/"B"(服务器源,可选) ──> 卡密服务器(原逻辑不变)
   └─ source=="jdr:<源id>" ──(登录前分流)──> ExtensionSourceBackend (:core:extension)
                                              └─> QuickJS 沙箱执行源脚本（手机本地）
                                                  ├─ http 桥 → 手机直连源站API（用户IP）
                                                  └─ crypto 桥 (md5/aes/gcm/chacha/sm4...)
播放: ChapterId = online://play?s=jdr:xxx&b=&c= → RoutingDataSource → OnlineStreamingDataSource
      → resolveDirectUrl(jdr:...) → JS audio() → 直链（TTL重解析/离线缓存全复用，零改动）
```

复用的本地资产：源 chip 搜索 UI、`online://` 书架寻址、流式 DataSource、直链 TTL 缓存重解析、
章节离线缓存、手动缓存任务。`online://` 只是 App 内部记账 URI，不代表走网络服务器。

## 模块划分

| 模块 | 职责 |
|---|---|
| `:core:extension-engine`（Kotlin JVM） | QuickJS 引擎封装、JS prelude、http/crypto 沙箱桥、契约校验、.jdr 包解析。纯 JVM，可直接在宿主机跑单测 |
| `:core:extension`（Android 库） | .jdr 安装/更新/卸载（filesDir/extensions/<包id>/）、DataStore 注册表、引擎缓存、`ExtensionSourceBackend`、Metro 装配 |
| `:core:online`（小改） | 新增 `ExtensionOnlineSource` 接口；`OnlineSourceService` 在登录逻辑**之前**按 `jdr:` 前缀分流；`isConfigured()` 兼容仅有扩展源的情况 |
| `:features:extensions`（新屏） | 接口源管理：包/源列表、启用开关、卸载、SAF 文件导入、URL 导入 |
| `samples/` | `itingshu.jdr`、`tingyoufm.jdr` 两个样例包 + `_template.js` 源开发模板 |

JS 引擎：`io.github.dokar3:quickjs-kt:1.0.15`（Android .so 已 16KB 对齐；JVM 构件自带
windows/linux/macos native，宿主机单测可跑真引擎）。

## .jdr 包格式

ZIP 文件（后缀 `.jdr`）：

```
manifest.json          包描述 + 源声明
itingshu.js            sources[].script 指向的脚本（可多个）
```

```json
{
  "id": "com.timbre.itingshu", "name": "爱听书源", "version": "1.0.0",
  "author": "", "description": "", "homepage": "",
  "allowInsecure": false,
  "sources": [{ "id": "itingshu", "name": "爱听书", "script": "itingshu.js",
                "capabilities": ["search", "chapters", "audio"] }]
}
```

校验规则（`JdrArchive.parse`）：manifest schema、包内路径不得越界（`..`/绝对路径）、
单脚本 ≤5MB、整包 ≤20MB、≤64 个文件、源 id 全局唯一（`[a-z0-9][a-z0-9_-]{0,63}`）、
manifest id 全局唯一、能力 ∈ {search, chapters, audio}。
导入冲突：同 manifest id = 更新（需保留启用状态）；源 id 被其他包占用 = 拒绝。

## JS 脚本契约

```js
;(function () {
  registerSource({
    id: 'itingshu',                       // 必须与 manifest.sources[].id 一致
    async search(params)   { /* {keyword,page,limit} → [{id,bookTitle,...}] */ },
    async chapters(params) { /* {bookId,page,size,...透传字段} → [{chapter_id,title,...}] */ },
    async audio(params)    { /* {bookId,chapterId,...透传字段} → 'https://...' 或 {url} */ },
  })
})()
```

标准字段：搜索 `id`+`bookTitle` 必填；章节 `chapter_id`+`title` 必填；音频返回 http(s) URL。
自定义字段在 搜索→章节→音频 间透传（backend 内存缓存 + 脚本兜底反查，模板中有说明）。

### 沙箱注入的全局 API

- 网络：`http.get(url, {params?, headers?, body?, json?, form?, timeoutMs?})` /
  `http.post(...)` → `{status, headers, body}`（响应体上限 10MB，重复响应头会合并）
- 契约：`registerSource`
- 摘要：`md5Hex`, `sha256Hex`, `hmacSha256Hex`
- 编码：`base64Encode/Decode/ToUtf8`, `hexToBytes`, `bytesToHex`, `utf8ToBytes`, `bytesToUtf8`
- 对称：`aesEcbEncryptB64(data, key)` / `aesEcbDecrypt(dataB64, key)`（PKCS#7）、
  `aesGcmEncrypt(key, nonce, data)` / `aesGcmDecrypt`（ct‖tag）、
  `chacha20Poly1305Encrypt/Decrypt`（12 字节 nonce = ChaCha20，24 字节 = XChaCha20）、
  `sm4EcbEncrypt(data, key)` / `sm4EcbDecrypt`（GB/T 32907-2016，ECB+PKCS#7）
- 杂项：`randomBytes(n)`, `timestamp()`, `timestampMs()`, `urlEncode/Decode`, `log(...)`

所有跨界参数都是字符串（JSON/base64/hex），字节类型（Uint8Array）只在 JS 侧出现。

## 沙箱与安全

- QuickJS 无任何 Java/Android 互操作，脚本只能使用注入的全局 API。
- 网络仅能通过 http 桥发起，仅允许 http/https；UA/头/超时由脚本声明。
- 每源独立 QuickJS 实例 + 专属单线程调度器；操作级 `withTimeout`
  （搜索 15s / 章节 20s / 音频 30s，audio 阶段默认 30s 上限）。
- 内存上限 64MB（`memoryLimit`），响应体 10MB 上限，包体积上限。
- `allowInsecure` 仅放宽该包 http 桥的 TLS 校验（部分源站证书链损坏）。

## 与播放链路的对接

- `OnlineSourceService.search/chapters/resolveDirectUrl` 入口先查
  `ExtensionOnlineSource.handles(source)`（`jdr:` 前缀），命中即转交本地 backend，
  **不经过 `authed()`（登录/token/验证码）**；未命中走原服务器路径，行为不变。
- `sources()` = 扩展源 chip（免密，永远可用）+ 服务器源 chip（仅已配置时，失败不阻塞扩展源）。
- `isConfigured()` = 服务器已配置 || 有启用的扩展源。
- 播放：`online://play?s=jdr:...` 的直链解析经 `OnlinePlaybackCatalog.resolveStreamUrl`
  → backend → JS `audio()`；直链过期 401/404 → `invalidateStreamUrl` → 重解析，全部复用。

## 样例源

`samples/` 目录是脱敏的接口源开发套件（README + 开发指南 + 空白模板 + 最小示例包），
不包含任何真实站点接口。两个按真实接口移植的脚本仅作为**引擎测试夹具**保留在
`:core:extension-engine` 的测试资源里（`voicesamples/*.js`），用于端到端冒烟测试。

打包：`python scripts/pack_jdr.py <目录> <输出.jdr>`。

## 测试

- `:core:extension-engine`（纯 JVM，宿主机直接跑）：crypto 标准向量
  （AES FIPS-197 / GCM / ChaCha20 RFC 8439 / XChaCha draft-irtf / SM4 GB&T）、
  prelude+引擎契约、.jdr 解析校验、**两个样例源的 mock 服务器端到端冒烟**
  （guest→搜索→章节→直链，真实加解密链路）。
- `:core:extension`：Robolectric 安装/冲突/更新/卸载；backend 字段映射与透传（mock 引擎）。
- `:core:online`：`jdr:` 分流不触碰服务器客户端、无服务器配置时 `isConfigured()` 为真。

## 已知限制 / 后续

- 章节自定义字段的透传缓存在内存中，进程被杀后脚本需自行兜底（听友FM 的反查逻辑即是）。
- 聚合搜索（一次搜所有源）未做，当前沿用「按源 chip 逐源搜索」的交互。
- 未加「用其他应用打开 .jdr 直接导入」的 intent-filter，目前走设置页里的文件选择器。
