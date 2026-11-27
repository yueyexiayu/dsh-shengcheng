# 决策记录

每条写清：背景 / 决定 / 代价。没有写代价的决定不算决定。

## D1 视频提交「状态不明」不自动兜底

**背景**：视频提交可能出现 HTTP 503 或传输中断，但请求已被提供方受理。此时重试会生成两次并计费两次。

**决定**：状态不明按「可能仍在运行」处理，报 `MEDIA_JOB_UNCERTAIN` 并落一条任务记录，由用户用 `shengcheng_video_jobs` 的 `status` / `resume` 续取（`lib/tools.js:190`、`:143-146`）。

**代价**：一次失败不会自动恢复，需要用户多一步操作；宁可慢一步，也不重复扣费。这条不许为了成功率放宽。

## D2 宿主模块不写进依赖声明

**背景**：源码引用 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-llm-pi-ai`（均在 `test/host-integration.spec.ts:3-5`），但这些包由 DSH 宿主与 `DSH_HOST_SOURCE_ROOT` 指向的源码树提供，其传递 peer（如 `@deepseek-ai/dsh-environment`）不在 npm registry 上。

**决定**：依赖声明只保留 `react`（可选 peer，前端注入）与 `vitest`（devDependency）；宿主模块由 `test/host-vitest.config.mjs:11-14` 的 alias 指到宿主源码，`pnpm install` 不去解析它们。

**代价**：`package.json` 不能回答「宿主需要哪些模块」，新接手的人必须读 README 的依赖说明与 TESTING 的 alias 表；一旦宿主模块改名，报错点会出现在测试加载阶段而不是安装阶段。

## D3 产物永不覆盖

**背景**：同名生成很常见（同一提示词反复跑）。覆盖会静默销毁用户已有的文件。

**决定**：先写 `.shengcheng-<uuid>.part`，再用 `link` 发布；命中 `EEXIST` 时递增 `-1`…`-1000` 后缀，超出报「同名文件过多」（`lib/storage.js:86`、`:127-144`）。发布失败保留数据并给出 `recoveryPath`，避免重新生成。

**代价**：目录里会出现多份近似文件，长期看磁盘占用上升，且插件不负责清理（见 MAINTENANCE 已知边界）。

## D4 设置用 revision 比对，不用长轮询锁

**背景**：多个 DSH 窗口共享同一 `DSH_HOME`，可能同时写同一份设置。

**决定**：`GET` 返回文件字节的 sha256 作为 `revision`；`POST` 必须带上它，不匹配返回 409 `settings_conflict`，由前端提示刷新（`lib/settings.js:71`、`:104-115`）。写入另加 `BEGIN IMMEDIATE` 与串行链（`lib/settings.js:95-121`）。

**代价**：后写者必然要重做一次编辑；没有自动合并，也没有「最后写入获胜」的省事路径。
