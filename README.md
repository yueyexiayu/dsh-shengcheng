# shengcheng

当前项目是深度适配个人使用，项目只是给大家提供思路和借鉴，尽量不要直接照搬。

通过 DeepSeek Harness 里**已经登录**的 Grok / GPT 账号调用图像生成接口，Grok 分支还提供视频生成。是否可用取决于远端接口接受该账号及其权限；对话登录成功不代表生成接口一定可用。当前对话模型不是它们也可以调用。不要走 API key，不要让模型自己 curl。

- **Grok**：`grok-imagine-image-2.0` 生图，`grok-imagine-video-1.5` 生视频
- **GPT**：`gpt-image-2` 生图（Codex 账号接口，尚未完成真实账号验收）。本插件不提供 GPT 视频生成

工具只有一个：`shengcheng`（`kind=image` 默认，或 `kind=video`）。文件默认写到会话工作目录，没有工作目录则写到下载文件夹。`zhanshi` 会预览本轮 `saved …png/mp4` 的落盘结果。token 只在 Host 读取 `$DSH_HOME/.credentials.yaml` 的 `llm-pi-ai/xai`、`llm-pi-ai/openai-codex`，不会进对话。

## 安装

复制到 `$DSH_HOME/plugins/shengcheng`，在 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 写入：

```yaml
- insert:
    - id: shengcheng
      name: ../../plugins/shengcheng/lib/index.js
```

完全退出 DeepSeek Harness（macOS：⌘Q）再打开。

本插件使用官方 `@earendil-works/pi-ai@0.87.1` 的 OAuth 续期实现。在插件源码目录安装依赖：

```bash
/Users/ning/.local/bin/pnpm install --frozen-lockfile
```

遵循项目指定的 `pnpm@11.7.0`。当前 Grok/GPT 续期路径不依赖其他 provider 的安装脚本，`pnpm-workspace.yaml` 已明确禁用相关脚本。

## 说明

- 先用输入框下方的 OAuth 插件登录对应账号
- `provider=auto`：当前对话是 Grok/GPT 就用那个账号；否则有 Grok 用 Grok，否则用 GPT
- 生成视频：`kind=video`，只用 Grok；指定 `provider=gpt` 会直接报错
- 不读取 `~/.grok/auth.json` / `~/.codex/auth.json`
- 凭证续期在 DSH 共享凭证锁内完成；等待期间换号或退出不会被旧续期覆盖。无法确认账号连续性时明确停止，要求重新发起任务
- 生成文件仅通过 HTTPS 下载，下载请求不携带账号凭证；错误页面、未知文件类型不会作为成功结果落盘
- 文件后缀跟随实际生成格式：例如请求 `image.png` 但服务端返回 JPEG 时，保存为 `image.jpg`，工具返回真实路径
- 取消及超时会中止请求和视频轮询；并发保存不会覆盖已有文件
- 读取、保存凭证或生成失败会明确报错，禁止把失败结果显示成生成成功

## 开发

```bash
for file in lib/*.js; do node --check "$file" || exit; done
node --test
```

## 验收记录（2026-10-06）

- DSH `0.2.1-alpha.1` 桌面端，使用 Grok 4.7 对话实际调用本工具
- `grok-imagine-image-2.0` 生图成功：JPEG，1024×1024，文件能正常打开
- 使用该图调用 `grok-imagine-video-1.5` 生视频成功：H.264，544×544，约 1.04 秒，完整解码通过
- 46 项测试通过；当前官方 Host 的 8 项检查通过，包含实际 JPEG 后缀、失败状态及重载
- GPT 的真实生成仍未验收，不将 Grok 的结果视为 GPT 也通过
