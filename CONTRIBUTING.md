# 参与贡献 | Contributing

欢迎 Issue 与 PR！

## 反馈问题 | Reporting issues

提交 [GitHub Issues](https://github.com/cq10086123/Timbre/issues) 时请附上：

- 设备 / 系统版本与 App 版本号（关于页可见）
- 复现步骤；本地书问题请说明文件格式，WebDAV 问题请说明服务器类型（飞牛 fnOS / 群晖 / Alist 等）

## 翻译 | Translations

Timbre 暂不使用 Weblate 等翻译平台，全部界面文案直接维护在仓库里：

- 基准文案：`core/strings/src/main/res/values/strings.xml`（英文）
- 简体中文：`core/strings/src/main/res/values-zh-rCN/strings.xml`

想新增或修正一种语言：复制一个 `values-xx` 目录完成翻译后提交 PR 即可。
注意每个语言包需要对基准文案 **100% 覆盖**（CI 的 "Check locale config" 会校验，
缺失的 key 会导致该语言从可用语言中掉出去）。

## 提交代码 | Code

1. Fork 本仓库并新建分支；
2. 本地验证（需要 Android SDK 与 JDK）：

   ```bash
   ./gradlew voiceUnitTest lintKotlin :app:lintFreeDebug
   ```

3. 向 `main` 提交 PR，CI 全绿后合并。

## Sandcastle 自动智能体 | Sandcastle agent loop

Timbre 用 [Sandcastle](https://www.npmjs.com/package/@ai-hero/sandcastle)（自主智能体循环）驱动自主开发循环：
AI 智能体自动认领带 **`Sandcastle`** 标签的 open issue，在 Docker 沙箱内实现、验证通过后
直接合回 `main` 并关闭 issue。完整流程（规划、实现、审阅、合并四个角色）见
[docs/sandcastle.md](docs/sandcastle.md)；配置与运行方式（本地 `npx tsx .sandcastle/main.mts`）
见 `.sandcastle/` 目录。

- 想把任务交给智能体：新建 GitHub Issue 并打上 `Sandcastle` 标签即可；
- 人类 PR 依旧欢迎，流程与上节相同，不受影响；想人工处理某个带 `Sandcastle` 标签的
  issue 时，请先移除该标签（或与维护者确认），避免与智能体重复工作。
- 智能体的提交信息统一以 `RALPH:` 开头，Code Review 时可据此快速识别。

## 许可 | License

Timbre 基于 [Voice](https://github.com/PaulWoitaschek/Voice)（GPLv3）二次开发，
向本项目贡献代码即表示同意以 [GPLv3](LICENSE.md) 授权你的贡献。
