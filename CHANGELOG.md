# 变更记录

格式参考 Keep a Changelog；每个版本对应一个 git tag（`v0.1.x`），条目取自该 tag 与上一个 tag 之间的提交标题，未改写。
`v0.1.5` 没有对应 tag（历史缺号），不在列表里；0.1.22 起的条目由本次改动写成中文摘要。

版本口径：沿用既有的补丁位递增（`0.1.x`）。本机 `~/.dsh/AGENTS.md` 的「逢十进一」与现存 `0.1.10`–`0.1.21` 冲突，口径待定，不在本次单方面改动。

## 0.1.22 — 2026-11-28

### 新增

- 文档：`docs/PRODUCT.md`（问题、用户与场景、能力边界、验收口径、非功能约束）、`docs/API.md`（两个工具与三条设置路由的契约）、`docs/TESTING.md`（三个测试入口、分层、逐文件覆盖、明确没覆盖什么）、`docs/ACCEPTANCE.md`（本次验收的真实命令与结果）、`AGENTS.md`（本项目执行约定）、`CHANGELOG.md`（本文件）。
- `README.md` / `README.en.md`：新增「安装」一节（本地插件挂到 profile 的步骤），并加文档索引。

### 变更

- `package.json`：补 `peerDependencies`（`react`，`optional: true`）与 `devDependencies`（`vitest`），提交 `pnpm-lock.yaml`；版本 0.1.21 → 0.1.22。此前源码引用了宿主与宿主源码树提供的模块，但清单没有任何依赖字段。
- `.gitignore`：忽略 `.jilv/`（纪律扫描过程产物）。

### 未改动

- 未改 `lib/` 代码；工具名、参数名、错误码、超时与安全约束全部保持原样。
## 0.1.21 — 2026-11-12

- Add reference-sized image editing

## 0.1.20 — 2026-11-11

- Fix audit findings: uncertain submit gating, job store, localization

## 0.1.19 — 2026-11-04

- Polish plugin interface

## 0.1.18 — 2026-11-03

- Localize plugin listing information

## 0.1.17 — 2026-11-02

- Update host media capability integration fixture

## 0.1.16 — 2026-11-01

- Use configured video fallback on submission 503

## 0.1.15 — 2026-11-01

- Explain video 503 parameter discrepancies

## 0.1.14 — 2026-11-01

- Remove video submission guard

## 0.1.13 — 2026-11-01

- Diagnose submissions and respect selected defaults

## 0.1.12 — 2026-11-01

- Protect and recover uncertain video jobs

## 0.1.11 — 2026-11-01

- Use compatible default video resolution

## 0.1.10 — 2026-11-01

- Offer standard media defaults

## 0.1.9 — 2026-11-01

- Allow selecting configured models for media

## 0.1.8 — 2026-11-01

- Discover media routes from configured providers

## 0.1.7 — 2026-11-01

- Protect media jobs with uncertain outcomes

## 0.1.6 — 2026-11-01

- Report media Host capability failures accurately
- Fix desktop model catalog request routing
- Do not retry local preparation timeouts
- Redact media adapter errors in single-route failures
- Use DSH media routes with optional fallback

## 0.1.4 — 2026-10-31

- make generation model identifiers configurable

## 0.1.3 — 2026-10-31

- add generation default settings

## 0.1.2 — 2026-10-31

- sync documented plugin version
- set localized plugin name
- docs: add Chinese-first bilingual README and original diagrams

## 0.1.1 — 2026-10-12

- Separate reference reads from output write authorization
- fix: sandbox reference images and do not replay paid generation
- fix: accept Grok video cover image as a non-playable stream
- fix: harden generation, media validation and sandboxed saving
- Fix shengcheng credential refresh and media delivery
- Add shengcheng plugin for Grok/GPT account image and video generation.
