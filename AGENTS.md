# 项目约定（shengcheng）

本文件只讲**在本项目里干活**要遵守什么；全局约定仍以 `~/.dsh/AGENTS.md` 为准，冲突时项目级更具体的这一条优先。

## 这是什么

DSH 桌面端本地插件（bundle 形式）：`lib/index.js` 是 Host 入口，`lib/client.js` 是设置页前端，`cordis.patch.yml` 声明 insert。desktop profile 用 `link:` 依赖 + `dsh.profile.bundles` 加载它。

## 命令

| 命令 | 用途 |
| --- | --- |
| `npm run check` | 8 个 `lib/*.js` 的语法检查（提交前必跑） |
| `npm test` | 108 项 `node:test`（提交前必跑） |
| `pnpm install --frozen-lockfile` | 按 lockfile 装 `react` / `vitest` |
| `DSH_OFFICIAL_ROOT=… npm run test:official` | 官方 SDK 沙箱集成（无该变量会报错退出，不是 skip） |
| `DSH_HOST_SOURCE_ROOT=… npm run test:host` | 宿主跨模块集成（vitest，无该变量启动即失败） |

## 改动约束

1. **对外契约冻结**：工具名 `shengcheng` / `shengcheng_video_jobs`、参数名、错误码、失败阶段名都写在 [docs/API.md](docs/API.md)；要先改文档并同步测试，再改实现。
2. **设置字段集必须与 `DEFAULT_SETTINGS` 完全一致**（`lib/settings.js:9`）：多一个或少一个都报 `settings_fields_invalid`（`lib/settings.js:20`）。加字段要同时改校验、默认值、前端与测试。
3. **视频「提交状态不明」永远不自动兜底**（`lib/tools.js:190`）：提交可能已被受理，重试会重复生成并重复计费。不要为了「成功率」放宽这条。
4. **下载安全不放宽**：仅 HTTPS、禁 URL 凭据、私网 DNS 拒绝、连接钉已校验 IP（`lib/parse.js:37`、`lib/network.js:49-68`）。
5. **产物不覆盖**：写盘必须走 `lib/storage.js` 的 `.part` + `link` 发布路径（`lib/storage.js:86`、`:127-144`），不要直接写目标文件。
6. **权限检查先行**：写盘前解析 sandbox 授权；权限不足要给 sandbox 拒绝文案（`lib/storage.js:46`），不许 catch 后静默成功。
7. **测试放进对应入口**：按 [docs/TESTING.md](docs/TESTING.md) 第 7 节判断走 `test` / `test:official` / `test:host`；不要为了过测试改实现里的对外文案。
8. **依赖边界**：`react` 是可选 peer（DSH 前端注入），`vitest` 是 devDependency；`@deepseek-ai/cordis`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-llm-pi-ai` 由宿主与 `DSH_HOST_SOURCE_ROOT` 的源码树提供、不在 npm registry，**不要写进依赖声明，也不要 `pnpm add` 它们**。
9. **重启**：改 `lib/index.js` 或 `lib/client.js` 后要重启 DSH 桌面端才生效；重启由用户人工执行，agent 不自行重启。
10. **文档里的 `file:line` 会漂**：改代码行号后，提交前复核 `docs/` 与 `README` 里的引用是否仍指向同一句话。

## 文档地图

| 文档 | 回答什么 |
| --- | --- |
| [README.md](README.md) | 是什么、怎么装、怎么跑、运行条件 |
| [docs/PRODUCT.md](docs/PRODUCT.md) | 解决什么问题、给谁用、不做什么、怎么算做成 |
| [docs/API.md](docs/API.md) | 两个工具与三条设置路由的契约、错误码、存储路径 |
| [docs/TESTING.md](docs/TESTING.md) | 三个测试入口、分层、逐文件覆盖、明确没覆盖什么 |
| [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) | 每次交付的真实命令、真实结果与未验证项 |
| [CHANGELOG.md](CHANGELOG.md) | 每个版本改了什么，回滚时挑哪一版 |

## 版本

沿用补丁位递增（`0.1.x`）。本机 `~/.dsh/AGENTS.md` 的「逢十进一」与现存 `0.1.10`–`0.1.21` 冲突，口径待定；不要自行改口径、重排或重打历史 tag。

## 不做的事

- 不在测试里打真实网络或真实提供方：现有测试全部 stub（真实远端调用从未被验证，见 ACCEPTANCE 的未验证项）。
- 不提交 `.jilv/`、`node_modules/`、生成产物文件。
- 不为了让报告好看而放宽 `docs/` 里的判定；未验证就写未验证。
