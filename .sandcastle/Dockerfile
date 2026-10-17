# Android 沙箱：JDK 25 工具链 + Android SDK（compileSdk 37）+ gh + OpenCode v2
# 项目需求来源：gradle/libs.versions.toml（jvm-toolchain=25, sdk-compile=37）+ AGENTS.md
# 坑：temurin 新版不再出 bookworm 变体，25 只有 noble/ubuntu。
FROM eclipse-temurin:25-jdk-noble

ARG HTTPS_PROXY=""
ARG HTTP_PROXY=""
ARG NO_PROXY=""

# Install system dependencies + GitHub CLI
RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  unzip \
  && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's default user to "agent" and align UID/GID.
RUN groupadd -o -g $AGENT_GID agent 2>/dev/null; \
  useradd -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l -s /bin/bash agent

# Android SDK（compileSdk 37）：坑南昌三件——
# ① AGP 9.4.0 要的是精确包 build-tools;36.0.0 + platforms;android-37.0（agent 实证），
#    不要想当然装 37.x；② SDK 目录必须 chown agent 可写，AGP 会按需补包，
#    只读 SDK 会让 agent 首跑撞 "SDK directory is not writable"；
# ③ 旧版 sdkmanager（纯 Java）可用，新版 Android CLI 是 x86_64 专属、arm64 容器跑不动
#    → 顺带装 libc6:amd64，给 Rosetta 备一个 loader（AGP Maven aapt2 若是 x86_64 就靠它）。
ENV ANDROID_HOME=/opt/android-sdk
# 以下 multiarch 修复仅 arm64 需要：arm64 镜像的源在 ports.ubuntu.com 且不含 amd64 索引
# （不标架构 apt update 就为 amd64 拉 ports 索引 → 404 → 退出 100），Rosetta 还需要
# libc6:amd64 提供 /lib64/ld-linux-x86-64.so.2。x86_64（GitHub runner）上源本来就在
# archive.ubuntu.com、全 native，什么都不用做 —— 结构分支保证两边都能 build。
RUN ARCH="$(dpkg --print-architecture)"; \
  if [ "$ARCH" = "arm64" ]; then \
    sed -i "/^Types:/a Architectures: arm64" /etc/apt/sources.list.d/ubuntu.sources \
    && printf "deb [arch=amd64] http://archive.ubuntu.com/ubuntu noble main restricted universe multiverse\ndeb [arch=amd64] http://archive.ubuntu.com/ubuntu noble-updates main restricted universe multiverse\ndeb [arch=amd64] http://security.ubuntu.com/ubuntu noble-security main restricted universe multiverse\n" > /etc/apt/sources.list.d/amd64.list \
    && dpkg --add-architecture amd64 \
    && apt-get update && apt-get install -y --no-install-recommends libc6:amd64 \
    && rm -rf /var/lib/apt/lists/* \
    && ls /lib64/ld-linux-x86-64.so.2 > /dev/null \
    && echo "arm64 multiarch ready"; \
  else \
    echo "x86_64 native — no multiarch patch needed"; \
  fi

RUN mkdir -p $ANDROID_HOME/cmdline-tools \
  && curl -fsSL -o /tmp/old.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip \
  && unzip -q /tmp/old.zip -d /tmp/clt \
  && mv /tmp/clt/cmdline-tools $ANDROID_HOME/cmdline-tools/latest \
  && rm /tmp/old.zip \
  && yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses > /dev/null \
  && $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager "platforms;android-37.0" "build-tools;36.0.0" "platform-tools" > /dev/null \
  && chown -R ${AGENT_UID}:${AGENT_GID} $ANDROID_HOME

# OpenCode CLI v2 —— 1.x 线 npm 包 opencode-ai 不认识 opencode-go provider；
# v2 走官方安装脚本（自带二进制，无需 Node），装后实体拷贝进 /usr/local/bin
# （root 家目录 700，软链对 agent 用户是悬空的）。
RUN curl -fsSL https://opencode.ai/v2/install | bash \
  && install -m 755 /root/.opencode/bin/opencode /usr/local/bin/opencode \
  && opencode --version

# 显式声明 opencode-go provider：容器内 Bun fetch 不走代理，models.dev 拉不到
# （只剩 10 个内置模型 → provider.no-route）。key 经 {env:OPENCODE_GO_API_KEY} 注入。
# --chown 必须：COPY 自动建的父目录若归 root，opencode 写 service.json.tmp 会 EACCES。
COPY --chown=${AGENT_UID}:${AGENT_GID} .sandcastle/opencode.json /home/agent/.config/opencode/opencode.json

USER ${AGENT_UID}:${AGENT_GID}

# 挂载点保护：docker 会把 ~/.gradle 挂载点及其父目录建成 root 所有，agent 写不了
# → Gradle 提取 libnative-platform.so 失败（"Failed to load native library"）。
# 在镜像里预建 .gradle 目录交给 agent，容器级挂载只会落到 host 目录本身（uid 501 对齐）。
RUN mkdir -p /home/agent/.gradle \
  && chown -R ${AGENT_UID}:${AGENT_GID} /home/agent/.gradle

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at ${SANDBOX_REPO_DIR}
# and overrides the working directory to ${SANDBOX_REPO_DIR} at container start.
ENTRYPOINT ["sleep", "infinity"]
