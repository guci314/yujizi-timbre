# Sandcastle 智能体循环 | Sandcastle agent loop

Timbre 用 [Sandcastle](https://github.com/ai-hero/sandcastle) 驱动自主开发循环（配置在 `.sandcastle/`）：AI 智能体领取带 **`Sandcastle`** 标签的 open issue，一次处理一个，直到清空。

循环由四个角色组成：

- **规划（Planner）**：读取 open issues，按依赖关系建图，确定哪些任务可开工、哪些被阻塞。
- **实现（Implementer）**：在 Docker 沙箱（JDK 25 + Android SDK）内领取一个 issue，检出 `sandcastle/issue-N` 分支，遵循根目录 `AGENTS.md` 的模块边界与命令，用红→绿→重构写码并以 `RALPH:` 前缀提交。
- **审阅（Reviewer）**：对照 `AGENTS.md` 测试规则验证 — 单模块用 `:module:testDebugUnitTest`，跨模块用 `voiceUnitTest`，收尾必跑 `lintKotlin`。
- **合并（Merger）**：验证通过后把分支合回 `main` 并关闭对应 issue。

人无需手动分派：给 issue 打上 `Sandcastle` 标签即进入队列。运行入口：`npx tsx .sandcastle/main.mts`。
