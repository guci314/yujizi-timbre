import { run, opencode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

// Simple loop: an agent that picks open issues one by one and closes them.
// Run this with: npx tsx .sandcastle/main.mts
// Or add to package.json scripts: "sandcastle": "npx tsx .sandcastle/main.mts"

await run({
  // A name for this run, shown as a prefix in log output.
  name: "worker",

  // Sandbox provider — runs the agent inside an isolated container.
  sandbox: docker({
    // 只挂依赖缓存与 wrapper（凭据文件 ~/.gradle/gradle.properties 不在内）
    mounts: [
      { hostPath: "~/.gradle/caches", sandboxPath: "/home/agent/.gradle/caches" },
      { hostPath: "~/.gradle/wrapper", sandboxPath: "/home/agent/.gradle/wrapper" },
    ],
  }),

  // The agent provider. Pass a model string to opencode() — sonnet balances
  // capability and speed for most tasks. Switch to claude-opus-4-8 for harder
  // problems, or claude-haiku-4-5-20251001 for speed.
  agent: opencode("opencode-go/glm-5.3-flash"),

  // Path to the prompt file. Shell expressions inside are evaluated inside the
  // sandbox at the start of each iteration, so the agent always sees fresh data.
  promptFile: "./.sandcastle/prompt.md",

  // Maximum number of iterations (agent invocations) to run in a session.
  // Each iteration works on a single issue. Increase this to process more issues
  // per run, or set it to 1 for a single-shot mode.
  maxIterations: 3,

  // Branch strategy — merge-to-head creates a temporary branch for the agent
  // to work on, then merges the result back to HEAD when the run completes.
  branchStrategy: { type: "merge-to-head" },

  // Gradle/Android 构建慢：agent 无输出 10 分钟才超时默认不够，放宽到 40 分钟。
  idleTimeoutSeconds: 2400,
});
