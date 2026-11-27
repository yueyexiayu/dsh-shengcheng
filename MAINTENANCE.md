# 维护与回滚

## 数据在哪

| 内容 | 路径 | 说明 |
| --- | --- | --- |
| 设置 | `$DSH_HOME/storages/shengcheng/settings.json` | 目录 `0o700`、文件 `0o600`，临时文件 + `rename` 原子写（`lib/settings.js:15-17`、`:75-86`）；旧的不可映射设置保留在 `legacySettings` 字段里 |
| 视频任务记录 | `$DSH_HOME/storages/shengcheng/video-jobs/<recordId>.json` | 最多 200 条、单条 16KB（`lib/jobs.js:7-8`）；超出时**优先淘汰已终态的旧记录**（`lib/jobs.js:94-103`） |
| 生成产物 | 会话 cwd、`~/Downloads`，或设置里的 `outputDirectory` | 插件**不清理**产物：写盘只负责生成新文件，不做保留策略 |

`$DSH_HOME` 未设置时回落 `~/.dsh`（`lib/settings.js:16`、`lib/jobs.js:15`）。

## 备份

1. 备份设置与任务记录：整目录复制 `$DSH_HOME/storages/shengcheng/`。
2. 备份后**验证非空且有内容**：`ls -l $DSH_HOME/storages/shengcheng/`、`head -50 $DSH_HOME/storages/shengcheng/settings.json`。空目录不等于备份成功。
3. 产物文件按需单独备份：插件不记录产物清单，只有任务记录里的 `requested_path` 能指向目标，未保存成功的产物只能重跑。

## 回滚

| 要回滚什么 | 怎么做 | 注意 |
| --- | --- | --- |
| 插件代码 | `git checkout <tag>`（版本列表见 [CHANGELOG.md](../CHANGELOG.md)）后重启 DSH 桌面端 | 重启由使用者人工执行；profile 里是 `link:`，不需要重装依赖 |
| 设置 | 用备份的 `settings.json` 覆盖回去；若只是某次保存出错，旧值在 `legacySettings` 里有一份只读快照 | 覆盖前先核对 `revision`（sha256），避免盖掉别人刚保存的版本（`lib/settings.js:71`、`:114`） |
| 误删的任务记录 | 从备份目录恢复对应 `<recordId>.json` | 记录超过 200 条时旧记录已被淘汰，**无法从插件侧恢复**，只能重新生成 |
| 装坏了 | 从 profile 的 `dsh.profile.bundles` 移除 `shengcheng` 并重启 | 不影响其它插件；设置与记录留在 `DSH_HOME`，不出脏数据 |

## 已知边界（这些情况没有自动处理）

- **磁盘只增不减**：产物没有保留上限、没有过期清理；长期使用要自己清理输出目录。
- **任务记录会丢旧的**：超过 200 条按时间淘汰，且优先淘汰终态记录；这不是备份，别当历史档案用。
- **设置快照只读**：`legacySettings` 保存后不能通过设置页修改（`lib/settings.js:116`）。
- **没有迁移工具**：跨机器迁移要靠手工复制上述目录，且 `$DSH_HOME` 路径要一致或自行改设置。

## 还没验证过什么

- 生产默认路径（真实 `~/.dsh`）没有测试覆盖：所有测试都显式传了临时 home，`DSH_HOME` 在测试里命中数为 0。
- 两个窗口并发保存只验证了 `[200, 409]` 这一种竞态，没有验证网络中断、进程被杀等场景。
- 真实远端生成从未在本仓库跑过（全部 stub），因此「上游失败后兜底是否止血」只有单测结论，没有线上证据。
- 恢复流程（`resume`）没有在真实 503 之后跑过，只有 `storage.test.mjs` 的替身断言。

## 出问题时的排查顺序

1. 插件是否加载：DSH 插件详情页是否出现「生成」；`$DSH_HOME/profiles/desktop/package.json` 的 `dsh.profile.bundles` 是否有 `shengcheng`。
2. 设置是否读得到：`GET /api/shengcheng/settings` 返回 `{ settings, revision }`；500 说明文件损坏（`lib/settings.js:104` 一带）。
3. 媒体能力：错误文案里是否有「当前 DSH Host 不提供媒体生成接口」（`lib/tools.js:121`）——那是 Host 版本问题，不是插件参数问题。
4. FFmpeg：报「媒体验证需要 …，请先安装 FFmpeg」（`lib/validate-media.js:20`）时先修 PATH。
5. 视频任务：用 `shengcheng_video_jobs` 的 `list` 找记录，再用 `status` 查上游态；`resume` 只拉已完成的现有结果，不会重新提交。
