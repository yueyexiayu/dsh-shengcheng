# shengcheng

当前项目是深度适配个人使用，项目只是给大家提供思路和借鉴，尽量不要直接照搬。

用 DeepSeek Harness 里**已经登录**的 Grok / GPT 账号生图，Grok 还能生成视频。当前对话模型不是它们也可以调用。不要走 API key，不要让模型自己 curl。

- **Grok**：`grok-imagine-image-2.0` 生图，`grok-imagine-video-1.5` 生视频
- **GPT**：`gpt-image-2` 生图（Codex 账号接口）。GPT **不能**生视频

工具只有一个：`shengcheng`（`kind=image` 默认，或 `kind=video`）。文件默认写到会话工作目录，没有工作目录则写到下载文件夹。`zhanshi` 会预览本轮 `saved …png/mp4` 的落盘结果。token 只在 Host 读取 `$DSH_HOME/.credentials.yaml` 的 `llm-pi-ai/xai`、`llm-pi-ai/openai-codex`，不会进对话。

## 安装

复制到 `$DSH_HOME/plugins/shengcheng`，在 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 写入：

```yaml
- insert:
    - id: shengcheng
      name: ../../plugins/shengcheng/lib/index.js
```

完全退出 DeepSeek Harness（macOS：⌘Q）再打开。

## 说明

- 先用输入框下方的 OAuth 插件登录对应账号
- `provider=auto`：当前对话是 Grok/GPT 就用那个账号；否则有 Grok 用 Grok，否则用 GPT
- 生成视频：`kind=video`，只用 Grok；指定 `provider=gpt` 会直接报错
- 不读取 `~/.grok/auth.json` / `~/.codex/auth.json`

## 开发

```bash
node --check lib/index.js lib/parse.js lib/oauth.js lib/media.js lib/tools.js
node --test
```
