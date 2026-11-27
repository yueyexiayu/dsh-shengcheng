# 测试清单（shengcheng）

本文件回答：测试在哪、怎么跑、覆盖了什么、**明确没覆盖什么**。产品边界见 [PRODUCT.md](./PRODUCT.md)，接口契约见 [API.md](./API.md)。

## 1. 怎么跑

```bash
pnpm install                 # 只为 test:host 装 vitest；其余测试只用 node 内置模块
npm test                     # 9 个 node:test 文件（当前 108 项）
npm run check                # 8 个 lib/*.js 的语法检查，不含逻辑
DSH_OFFICIAL_ROOT=/path/to/extracted/dsh npm run test:official
DSH_HOST_SOURCE_ROOT=/path/to/dsh-source npm run test:host
```

| 入口 | 跑什么 | 前置 | 缺前置时的真实行为 |
| --- | --- | --- | --- |
| `test`（package.json:9） | `test/*.test.mjs` 里 9 个文件 | 无（仅 node 内置模块 + 系统 FFmpeg） | — |
| `check`（package.json:10） | `lib/` 8 个文件的 `node --check` | 无 | — |
| `test:official`（package.json:11） | `reference.test.mjs`、`official-fs.test.mjs` | `DSH_OFFICIAL_ROOT` 指向解包后的官方 DSH 运行时 | 抛 `Set DSH_OFFICIAL_ROOT to an extracted official DSH runtime before running filesystem integration tests.`（`test/official-fixture.mjs:9`）；两个文件各报 `test failed`，**不是 skip**（同文件 :7-8） |
| `test:host`（package.json:12） | `test/host-integration.spec.ts` | `DSH_HOST_SOURCE_ROOT` 指向已装依赖的 DSH 源码 + 可用的 `vitest` | 抛 `DSH_HOST_SOURCE_ROOT is required for Host integration validation`（`test/host-vitest.config.mjs:5`），vitest 启动即失败 |

`test:host` 的配置把 `vitest`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-llm-pi-ai` 全部 alias 到宿主源码（`test/host-vitest.config.mjs:11-14`）。所以**被测模块一定来自宿主源码**；`vitest` 只作为运行器，本地 `devDependencies` 里的版本与宿主版本不同也不会改变被测代码。

`test` 入口不带覆盖率脚本：没有 c8/nyc，本仓库也不统计覆盖率。

## 2. 分层

| 层 | 代表文件 | 用真东西还是替身 |
| --- | --- | --- |
| 纯单元 | `test/parse.test.mjs`、`test/tools.test.mjs` | 只有纯函数与假 ctx |
| 契约替身 | `test/storage.test.mjs`、`test/client.test.mjs`、`test/model-catalog.test.mjs` | 自建 `ctx.fs` / `sandboxPolicy` / `llm` 替身，配合真实临时目录 |
| 真实系统集成 | `test/validate-media.test.mjs`、`test/network.test.mjs` | 真 FFmpeg 子进程、真 socket 语义（DNS/HTTPS 用 mock 方法拦截） |
| 官方 SDK 集成 | `test/official-fs.test.mjs`、`test/reference.test.mjs` | 真 `Context` + `SandboxPolicyService` + `SandboxedFileSystem` |
| 跨模块 | `test/host-integration.spec.ts` | 真 `LlmRuntime` + `PiAiAdapter`，只有网络被 stub |

## 3. 每个文件覆盖什么

| 文件 | 覆盖的行为 |
| --- | --- |
| `test/parse.test.mjs` | `kind` 只认 image/img/video；含引号/反斜杠/换行的路径仍能解出 `shengcheng_result`；默认文件名前缀；图片魔数判定；`mediaUrl` 拒绝 http 与带账号 URL |
| `test/tools.test.mjs` | 注册的工具名与超时（1 210 000 / 630 000）；描述里「显式参数优先」；600 秒尝试超时与取消传播；路线解析与报错；默认参数覆盖；参考图尺寸模式 |
| `test/jobs.test.mjs` | 记录 0600；load/update/list/remove；`../outside` 与伪造 model 被拒；205 条只留 200 且优先淘汰终态；损坏记录只进 `invalid` 且不回显内容 |
| `test/model-catalog.test.mjs` | provider 身份保留；能力只来自媒体注册表；目录失败不外泄 secret；`interface_missing`/`invalid_response`/`mediaEmpty` 区分；单 provider 超时不影响其它；取消返回 499 |
| `test/network.test.mjs` | 只放行全局单播（`127.1`、十进制/十六进制 IP、`::1`、`::ffff:127.0.0.1` 全拒且不发请求）；公私混合 DNS 拒绝；连接钉已校验 IP、无 authorization 头；IPv6 不可达后换 IPv4 不重解析；重定向到私网不开 socket；6 次 302 报「重定向过多」；长度上限/流式超限/长度不符；`text/html`、`gzip`、500 拒绝；DNS 报错不含 secret；DNS 挂起时 abort 立即返回 |
| `test/settings.test.mjs` | 精确路由持久化；`video_duration_invalid` 带 `params.max`；坏 JSON 400；文件 0600；坏文件不被覆盖；legacy 原样保留为 `legacySettings` 且文件字节不变；stale revision 409；并发一胜一败 `[200, 409]`；非法 route/兜底与主相同/尺寸策略的报错；归一化去空白；旧版缺字段补默认且不写盘 |
| `test/validate-media.test.mjs` | 真解码接受 png/webp/jpeg/gif；`resizeImage` 得到精确尺寸；12 字节签名与截断判无效；假 ftyp、截半 mp4、纯音频 mp4 被拒；`attached_pic` 封面不计第二轨；尾部音频包损坏失败；PNG CRC 翻位失败；预取消不启动解码器；暂存目录用回调且清空；取消活动校验器后子进程被杀并回收 |
| `test/reference.test.mjs` | 返回字节与 1x1 png；空/html/12 字节/目录分别报错；稀疏 15MB+1 在读内容前被拒；FIFO 当非普通文件拒绝且 <1000ms；已取消 signal 下抛 `AbortError` |
| `test/official-fs.test.mjs` | 官方 fs 下 `referencePath` 对绝对路径/别名/`../outside` 的解析一致；`prepareOutput` 在 read-only 抛 `FS_SANDBOX_DENIED` 且不留文件；workspace-write 拒 `/Users/Shared`；三种 mode 各自写入行为；切 read-only 后 `save` 被拒 |
| `test/storage.test.mjs` | 生成前拒绝 read-only、`../outside`、symlink 别名、缺 `checkedTarget`；danger-full-access 写 root 外；同名并发得 `-2` 后缀；abort / 中途改 read-only / 暂存被替换都不发布且无残留；发布失败保留数据并给 `recoveryPath`；`resolveOutPath` 拒空、`\0`、换行、`.`、`..`、目录；参考图走读能力；图片/视频派发与显式覆盖；兜底只在 upstream 失败或无效媒体时各跑一次；两段失败文案含双方模型且不含 secret；`MEDIA_JOB_UNCERTAIN`/`MEDIA_TRANSPORT`/超时报「状态未知」且不兜底；accepted 记录可 `list`/`status`/`resume` 且只提交一次；本地记录保存失败仍报不确定；提交诊断带 HTTP 503 且不含私有 body；视频 503 不兜底；503 时用目录声明差异给排查线索；视频兜底要求本次确认失败；400/422 与 `MEDIA_UNSUPPORTED`/`MEDIA_ROUTE_CHANGED`/`MEDIA_AUTH`/`MISSING_CREDENTIAL` 可兜底；两次尝试各有独立 600 秒 |
| `test/client.test.mjs` | 不再请求 `/video-jobs`；provider+model 成对选择、保存带 revision、legacy 随保存回传；未设置路由不误标；切换路由保留默认值；兜底与主相同报错；无元数据时常用值仍可选；已保存分辨率不被改写；目录失败时禁用模型选择；字典注册与 en 生效、未知 key 回落中文、错误码本地化 |
| `test/host-integration.spec.ts` | 真 `PiAiAdapter` 下按 `videoRoute` 提交（含 `data:image/png;base64` 首帧）、`768p` 归一、`workspace-write` 拒 `../escape.mp4`、400 触发兜底、503 不兜底、兜底缺参考图能力报 `MEDIA_REFERENCE_UNAVAILABLE` |

## 4. 替身策略

- `test/storage.test.mjs` 自建 `ctx.sandboxPolicy` / `ctx.fs` 替身，注释写明「故意独立于插件自己的 storage 实现」（`test/storage.test.mjs:13-14`），配合真实 `mkdtemp` 目录。
- `test/official-fixture.mjs` 用真实官方服务：`Context`、`SessionProjectionRegistry`、`SandboxPolicyService`、`SandboxedFileSystem`，会话 id 固定 `isolated-media-fixture`（`test/official-fixture.mjs:22-28`）。
- `test/network.test.mjs` 用 `t.mock.method` 拦 `dns.lookup` 与 `https.request`，并断言「unexpected request must never reach the real network」（`test/network.test.mjs:11-17`）。
- `test/client.test.mjs` 用 `vm.runInNewContext` 加载 `lib/client.js`，自带极简 React 与 fetch 回调（`test/client.test.mjs:6-23`）。
- `test/host-integration.spec.ts` 只伪造 `fetch` 与 provider 目录 JSON，其余是真宿主模块（`test/host-integration.spec.ts:27-47`）。

## 5. 环境依赖

| 依赖 | 用途 | 缺了会怎样 |
| --- | --- | --- |
| `DSH_OFFICIAL_ROOT` | `test:official` 载入官方 cordis / sandbox / session 模块（`test/official-fixture.mjs:11-16`） | 两个文件直接报错，不跳过 |
| `DSH_HOST_SOURCE_ROOT` | `test:host` 的 alias 根与 `vitest.shared.ts` 来源（`test/host-vitest.config.mjs:4-9`） | vitest 启动即失败 |
| 系统 `ffmpeg` / `ffprobe` | 媒体解码与样本合成（`lib/validate-media.js:13-21`、`test/validate-media.test.mjs:13-16`） | 库抛「媒体验证需要 …，请先安装 FFmpeg」；测试无样本可造 |
| `DSH_HOME` | 设置与任务记录的默认根（`lib/settings.js:15-17`、`lib/jobs.js:14-16`） | 生产默认路径 `~/.dsh` 在所有测试里**没有被设置过**，见第 6 节 |
| Node | 仓库在本机跑在 `v26.13.1`；`node --test` 需要能跑 ESM 与 `test` 模块 | — |
| `vitest` | 只是 `test:host` 的运行器；被测模块来自宿主源码（见第 1 节） | `vitest: command not found` |

## 6. 明确没覆盖什么

**真实远端与真实网络**：所有远端调用都被 stub（`test/host-integration.spec.ts:32`、`test/network.test.mjs:11-12`）。真实 TLS 握手、真实证书失败、真实 CDN 重定向链、真实提供方账号与计费都没有测试。

**FFmpeg 异常分支**（这些字符串在 `test/` 里命中数为 0）：`媒体验证需要 …`（`lib/validate-media.js:20`）、`无法启动 FFmpeg 媒体验证程序`（:53）、`媒体验证输出超过安全上限`（:44）、`媒体尺寸无效或超过 64MP 像素上限`（:100）、`MP4 未包含支持的视频编码轨道`（:105）、`媒体没有完整帧或超过验证帧数上限`（:114）、`媒体验证临时目录校验失败`（:119、:148）、`图片尺寸调整参数无效`（:127）、`待调整文件不是有效图片`（:129）、`调整尺寸后的图片为空或超过大小上限`（:145）。

**`shengcheng_video_jobs` 的错误分支**：`action 只能是 list、status 或 resume`（`lib/tools.js:243`）、`record_id 不能为空`（:248）、`找不到有效的视频任务记录`（:251）、`当前 DSH Host 不支持查询视频任务`（:252）、`提供方返回的视频任务状态无效`（:257）、`视频任务已确认失败`（:260）、`当前 DSH Host 不支持获取已完成视频任务的结果`（:265）、`恢复的视频结果与任务路线不一致`（:276）、`恢复的视频结果缺少唯一的字节或地址`（:279）、`恢复视频任务超时，任务记录已保留`（:286）均无断言。

**生成工具的形状校验**：`媒体生成结果缺少唯一的字节或地址`（`lib/tools.js:153`）、`媒体生成结果时长无效`（:150）、`图片尺寸调整未得到参考图尺寸`（:162）。

**设置**：`设置内容过大` / 413（`lib/settings.js:104`）、`旧设置快照不能通过设置页面修改` / `legacy_snapshot_locked`（:116）、`legacy_snapshot_invalid` 的 8192 字节边界（:40）。

**任务记录**：`媒体任务目录必须是绝对路径`（`lib/jobs.js:50`）、`媒体任务时钟无效`（:51）、`媒体任务记录包含未知字段`（:36）、`媒体任务保存路径无效`（:42）、`媒体任务身份不完整`（:29）、`媒体任务记录版本或状态无效`（:39）、`媒体任务记录无效或超过大小上限`（:109）、`媒体任务记录不是有效 JSON`（:112）。

**模型目录**：`DSH 模型目录服务不可用`（`lib/model-catalog.js:36`）、`无效的提供方列表`（:41）、`无效或重复的提供方`（:44）、`模型列表读取失败`（:61）、`模型目录请求已取消`（:115，只断言了 499 状态）、`concurrency` 参数（:38）、`invalid_config`（:77）。

**参考图**：`参考图不存在`（`lib/reference.js:15`）、`参考图读取返回了无效或超限数据`（:20）、`FS_TOO_LARGE` 映射（:26）。

**写盘**：`同名文件过多`（`lib/storage.js:144`）、`媒体写入未取得进展`（:118）、`目标文件在发布期间被替换`（:140）、`没有可保存的有效媒体`（:112）、`输出路径经符号链接解析后目录不一致`（:83）、`当前 DSH 文件服务不支持…`（:33、:59）、无 cwd 时回落 `~/Downloads`（:13）。

**下载边界**：`下载大小上限无效`（`lib/network.js:82`）、`生成文件重定向缺少下载地址`（:101）、`下载生成文件失败 (HTTP …)`（:106）、默认 180 秒 signal（:71）。

**前端状态**：`action.revert`、`action.refresh`、`action.saving`、`status.loading`、`error.problems` 与兜底冲突文案都没有断言（`lib/client.js:19-53`、:240-253）。

**生产默认路径**：`DSH_HOME` 在所有测试里都没有被显式设置（命中数 0），即「真的写到 `~/.dsh`」这条路径只由实现保证，没有测试。

**CI**：仓库根没有 `.github/`，上述两个环境变量在自动化里无人提供；本清单只说明本机怎么跑。

## 7. 新测试放哪个入口

1. 不碰 DSH 内部服务、只用 `node:test` 能表达的 → 加进 `test` 入口（记得在 `package.json:9` 的文件列表里补上名字）。
2. 需要真官方 SDK（cordis / sandbox / session）→ 走 `test:official`，用 `test/official-fixture.mjs`。
3. 需要宿主源码 alias（`dsh-llm`、`PiAiAdapter`、宿主的 `vitest.shared.ts`）→ 写进 `test/host-integration.spec.ts`，`test:host` 会自动带上。
4. 改 `lib/` 的对外文案、错误码、参数名之前，先改 [API.md](./API.md)：那些字符串是契约，测试与文档都以它为准。
