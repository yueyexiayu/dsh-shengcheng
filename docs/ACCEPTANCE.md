# 验收报告

## 2026-11-28 — v0.1.22（工程形态补全）

**版本**：0.1.22　**提交前父提交**：36f9a0d　**执行人**：本机会话（agent 执行，用户复核）

**环境**：macOS 27.0.1（arm64）、Node v26.13.1、pnpm 10.14.0、FFmpeg 9.0.1（系统 PATH）

### 本次交付内容

1. `package.json`：补 `peerDependencies`（`react`，可选）+ `devDependencies`（`vitest`），并提交 `pnpm-lock.yaml`；版本 0.1.21 → 0.1.22。
2. 新增文档：`docs/PRODUCT.md`、`docs/API.md`、`docs/TESTING.md`、`CHANGELOG.md`、`AGENTS.md`。
3. `README.md` / `README.en.md`：补「安装」一节、文档索引、版本号同步。
4. `.gitignore`：忽略 `.jilv/` 扫描过程产物。

本次不改 `lib/` 任何代码，不改工具名、参数名与错误码。

### 执行命令与真实结果

| 命令 | 退出码 | 真实输出 |
| --- | --- | --- |
| `npm run check` | 0 | 8 个 `lib/*.js` 全部通过 `node --check` |
| `npm test` | 0 | `tests 108`、`pass 108`、`fail 0`、`duration_ms 4799.635084` |
| `pnpm install --frozen-lockfile` | 0 | `+ react 19.3.1`、`+ vitest 5.1.2` |
| `npm run test:official`（未设 `DSH_OFFICIAL_ROOT`） | 1 | `Set DSH_OFFICIAL_ROOT to an extracted official DSH runtime before running filesystem integration tests.`，两个文件各 `test failed` |
| `npm run test:host`（未设 `DSH_HOST_SOURCE_ROOT`） | 1 | `Error: DSH_HOST_SOURCE_ROOT is required for Host integration validation`（修复前是 `sh: vitest: command not found`） |

`npm test` 的 108 项覆盖：`client`、`jobs`、`model-catalog`、`network`、`parse`、`settings`、`storage`、`tools`、`validate-media` 九个文件（含真实 FFmpeg 解码、真实临时目录、DNS/HTTPS 拦截）。

### 未验证（明确记录，不当作通过）

- `test:official` 未在设置 `DSH_OFFICIAL_ROOT` 的环境下跑过：本机没有解包后的官方运行时目录。
- `test:host` 未在设置 `DSH_HOST_SOURCE_ROOT` 的环境下跑过：本机没有带依赖的 DSH 源码树，只有错误前置信息可核对。
- 真实远端生成：没有调用任何真实提供方，未验证账号、模型、计费与审核行为。
- 窗口内 UI：未在 DSH 设置页实际点击保存；`lib/client.js` 的改动只由 `client.test.mjs` 的 `vm` 断言覆盖。
- 安装步骤（README「安装」一节）未在干净 profile 上实测：本次未改任何 profile 配置。

### 复现方式

```bash
cd ~/.dsh/plugins/shengcheng
pnpm install --frozen-lockfile
npm run check && npm test
DSH_OFFICIAL_ROOT=/path/to/extracted/dsh npm run test:official
DSH_HOST_SOURCE_ROOT=/path/to/dsh-source npm run test:host
```

### 结论

限定范围内通过：语法检查通过、108 项单元与集成测试全绿、依赖可复现安装。两个环境门禁入口与真实远端调用**未验证**，按上表逐条补齐后才能算完整验收。
