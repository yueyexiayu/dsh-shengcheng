# 接口契约（shengcheng）

本文件是**当前实现的对外可见接口清单**，从 `lib/` 实际注册的东西反推，不是设计稿。

- 插件 id：`shengcheng`（`lib/parse.js:2`），bundle 通过 `cordis.patch.yml` 以 `insert` 挂入。
- Host `inject`：`["llm", "tools", "fs", "sandboxPolicy", "connection"]`（`lib/index.js:7`）。
- 对外可见面只有三样：DSH 工具 `shengcheng`、DSH 工具 `shengcheng_video_jobs`、设置页自用路由 `/api/shengcheng/*`。

## 1. 工具 `shengcheng`

生成一张图片或一个视频，并保存到本地。

| 字段 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `prompt` | string | 是 | — | 生成提示词；空则报 `prompt 不能为空`（`lib/tools.js:115`） |
| `kind` | enum `image` / `video` | 否 | `image` | 只接受 `image`、`img`、`video`；其他值报 `kind 只能是 image 或 video`（`lib/parse.js:11-13`） |
| `provider` | string | 否 | 设置里对应路线的 provider | 只给 provider 且与已存不同时报 `指定不同提供方时请同时指定模型`（`lib/tools.js:50`） |
| `model` | string | 否 | 设置里对应路线的 model | 与 provider 一起构成路线身份（`lib/tools.js:52`） |
| `aspect_ratio` | string | 否 | 设置 `imageAspectRatio`，为 `auto` 时不下发 | 提供方决定是否支持（`lib/tools.js:65-67`） |
| `quality` | string | 否 | 设置 `imageQuality`，为 `auto` 时不下发 | 同上（`lib/tools.js:69`） |
| `resolution` | string | 否 | 设置 `videoResolution`，为 `auto` 时不下发 | 同上（`lib/tools.js:71`） |
| `size` | string | 否 | 无；尺寸策略为 `reference` 且有参考图时取参考图宽高 | 形如 `1024x1024`（`lib/tools.js:62-64`） |
| `duration` | integer | 否 | 设置 `videoDuration`（`null` 表示自动） | 1–30，越界报 `视频时长必须为 1–30 秒`（`lib/tools.js:105`、`lib/tools.js:116`） |
| `image_path` | string | 否 | 无 | 参考图路径，≤15MB（`lib/tools.js:106`、`lib/parse.js:5`） |
| `path` | string | 否 | 会话 cwd；无 cwd 用 `~/Downloads` | 相对路径按会话 cwd 解析；`outputDirectory` 非空且未给 `path` 时写入该目录（`lib/tools.js:107`、`lib/tools.js:134`） |

`required: ["prompt"]`，`additionalProperties: false`（`lib/tools.js:96`、`lib/tools.js:108`）。参数 schema 里没有 `default` 关键字，默认值由设置与代码注入。

**成功返回**（`lib/tools.js:168`，输出 schema `lib/tools.js:109`）：

```json
{ "kind": "image|video", "provider": "...", "model": "...", "path": "/abs/path", "duration": 5 }
```

- `duration` 只在提供方返回了有效时长时出现。
- 文本渲染为三行：`saved <path>`、`<provider> <model>`、`shengcheng_result {"path":...}`（`lib/parse.js:40-45`）。
- 输出 schema 声明了 `record_id`，但成功路径不返回它；只有失败且拿到了任务记录时才出现在提示里（`lib/tools.js:86`、`lib/tools.js:203`）。

**失败信息结构**：`<阶段>失败 (<CODE>，<细节>)`，超时改为 `<阶段>超时`（`lib/tools.js:84-87`）。

| 阶段 | 何时进入 | 依据 |
| --- | --- | --- |
| `请求准备` | 解析参数、准备路线 | `lib/tools.js:128` |
| `本地准备` | 读参考图、探测尺寸 | `lib/tools.js:131` |
| `上游生成` | 调用 `generateMedia` | `lib/tools.js:142` |
| `媒体响应` | 下载与校验结果 | `lib/tools.js:148` |
| `本地保存` | 写盘发布 | `lib/tools.js:165` |

| 错误码 / 分支 | 含义 | 依据 |
| --- | --- | --- |
| `MEDIA_PROVIDER_ERROR` | 上游返回错误 | `lib/tools.js:84-85` |
| `MEDIA_TRANSPORT` | 传输异常 | `lib/tools.js:191` |
| `MEDIA_REFERENCE_UNAVAILABLE` | 无法确认参考图输入方式，未提交 | `lib/tools.js:87` |
| `MEDIA_MODERATION_BLOCKED` | 提供方内容审核拒绝，不切兜底 | `lib/tools.js:87`、`lib/tools.js:180` |
| `MEDIA_JOB_UNCERTAIN` | 视频任务状态未知，可能仍在运行 | `lib/tools.js:190` |
| `MEDIA_VIDEO_TOO_LONG` | 时长越界（参数层） | `lib/tools.js:116` |
| `silent` | 宿主取消：直接抛宿主 signal 的 reason，不包装成阶段文案 | `lib/tools.js:170`、`lib/tools.js:199` |

提交/轮询诊断码（`lib/tools.js:10`）：`submit_transport`、`submit_http`、`submit_invalid_json`、`submit_invalid_id`、`submit_response_too_large`、`submit_aborted`、`accepted_persist_failed`、`poll_or_download`。

**兜底语义**：仅当失败可重试、配置了兜底路线、且兜底不等于主路线时再试一次（`lib/tools.js:200`）。`MEDIA_REFERENCE_UNAVAILABLE`、`MEDIA_MODERATION_BLOCKED` 一律不重试；`MEDIA_JOB_UNCERTAIN` 与上游阶段的超时/传输异常不自动兜底（`lib/tools.js:190-194`）。两次都失败时文案同时带主模型与兜底模型的失败（`lib/tools.js:212`）。

## 2. 工具 `shengcheng_video_jobs`

查询、续取或列出本机记录的视频任务。**不会**重新提交生成。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `action` | enum `list` / `status` / `resume` | 是 | 非法值报 `action 只能是 list、status 或 resume`（`lib/tools.js:243`） |
| `record_id` | string | `status` / `resume` 必填 | 缺失报 `record_id 不能为空`；查不到报 `找不到有效的视频任务记录`（`lib/tools.js:248-251`） |
| `path` | string | 否 | 仅 `resume` 用；覆盖记录中的目标路径，相对路径按会话 cwd 解析（`lib/tools.js:235`、`lib/tools.js:271`） |

| action | 行为 | 返回 |
| --- | --- | --- |
| `list` | 读本机记录，按 `updatedAt` 倒序，最多 200 条 | `{ action, jobs: [...], invalid: [{ recordId, message }] }`（`lib/tools.js:244-247`、`lib/jobs.js:127-134`） |
| `status` | 用 15 秒超时向上游查询一次；`failed` 抛审核拒绝/确认失败；`completed` 先落本地状态 | `{ action, ...record, state, local_state }`（`lib/tools.js:253-263`） |
| `resume` | 同上查询；未完成直接返回 `state: "pending"`；已完成则用 600 秒下载、校验、保存 | `{ action, ...record, state: "completed", path }`（`lib/tools.js:264-283`） |

记录字段（`lib/tools.js:219`）：`record_id`、`provider`、`model`、`job_id`、`state`、`accepted_at`、`updated_at`，可选 `requested_path`。本地状态集合为 `accepted` / `completed` / `failed`（`lib/jobs.js:12`）。

## 3. 设置页路由（自用，不是第三方 API）

| 方法与路径 | 作用 | 关键语义 |
| --- | --- | --- |
| `GET /api/shengcheng/settings` | 读设置 | 返回 `{ settings, revision }`，`revision` 是原文件字节的 sha256（`lib/settings.js:71`） |
| `POST /api/shengcheng/settings` | 写设置 | 必须带 `revision`；不匹配返回 409 `settings_conflict`；请求体 >16384 字节返回 413（`lib/settings.js:104-115`） |
| `GET /api/shengcheng/models` | 读模型目录 | 从 DSH 已配置提供方发现路线，并发 4（`lib/model-catalog.js:2`、`lib/model-catalog.js:69`） |

注册点在 `lib/index.js:11-12`；前端调用点在 `lib/client.js:190-203`。设置字段与约束见 [PRODUCT.md](./PRODUCT.md) 与 `lib/settings.js:9-46`；字段集必须与默认键完全一致，多一个或少一个都报 `settings_fields_invalid`（`lib/settings.js:20-21`）。

## 4. 本机存储

| 内容 | 路径 | 上限 / 权限 |
| --- | --- | --- |
| 设置 | `$DSH_HOME/storages/shengcheng/settings.json` | 目录 0o700、文件 0o600，临时文件 + rename 原子写（`lib/settings.js:15-17`、`lib/settings.js:75-86`） |
| 视频任务记录 | `$DSH_HOME/storages/shengcheng/video-jobs/<recordId>.json` | 200 条、单条 16KB，淘汰时优先删终态记录（`lib/jobs.js:7-8`、`lib/jobs.js:94-103`） |
| 生成产物 | 会话 cwd 或 `~/Downloads`，或设置 `outputDirectory` | 默认名 `shengcheng-<provider>-<kind>-<YYYYMMDD-HHmmss>.<ext>`；同名时递增后缀，不覆盖（`lib/parse.js:15-19`、`lib/storage.js:127-144`） |

`recordId = sha256(provider, model, jobId, routeFingerprint).slice(0, 32)`，同一上游任务永远映射到同一文件（`lib/jobs.js:27-31`）。
