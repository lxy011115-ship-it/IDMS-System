# 工作流围栏绑定加密归档 v2

`scripts/workflow-archive.mjs` 提供显式 `createWorkflowArchive(settings)` API；调用者提供当前 `DRAINED` 的 `config`、`operationId`、独立 `keyFile`、私密 `workDirectory` 与 `outputDirectory`。新 key 通过 `generateWorkflowArchiveKey` 生成。归档完成或失败都保持源围栏，不自动释放、不修改业务配置。原 `workflow-freeze-control.mjs` 和 CLI 保持；其 status 仍要求源数据库零会话。

捕获持有原 session advisory lease，绑定实际 cluster、控制库、源 DB/role OID、baseline 和 drainedAt。只读 RR holder、固定 SHA 的 PostgreSQL 16 pg_dump 使用同一导出快照；归档 observer 只接受准确绑定的本次 holder 和独一 appname 的原生只读连接。其他会话（包括维护后台）、权限/OID/lease 漂移均拒绝，不自动修复或放宽旧 status。超级管理员与操作系统管理员仍属于信任边界。

38 表逐行摘要、列、索引、约束、视图、函数、触发器和两条日志序列前后比较。两序列的稳定依靠持久应用围栏、原连接退出及当前会话复核，不能仅凭 MVCC/两次观测认定静默。数据库编码、locale/provider/版本和事实会话参数纳入认证；恢复会实际回读比较这些参数。事实范围不是数据库全部系统对象/权限的备份。

新格式为 IDMSWFA2/AES-256-GCM，独立 v2 key，64 KiB 流式读写；manifest 上限 1 MiB、单行事实 64 MiB、dump 上限 8 GiB。上限是拒绝边界，尚无对应规模容量/SLA 验证。恢复消费者必须先通过完整 GCM、严格 manifest 与完整 dump SHA；不得从未认证内容启动原生恢复或创建数据库。旧 v1 `LIVE_REVIEW_COPY_ONLY` 保持旧用途，不能改标签作为正式归档。

每次捕获先保存实际 owner PID/.NET 启动 ticks/host、run 目录、源连接唯一名称及固定程序 SHA/九参数意图，再连接源和启动 pg_dump。固定锁等待 30 秒、整个原生导出 300 秒上限；正常监视每 250 ms 复核当前围栏。重试先要求旧控制进程实际终止，按精确程序/参数/PID/启动时间检查并退休自有原生程序及遗留检查助手，再确认准确 PG backend 退出，才清理已登记的 partial。原生进程 close 与 SQL backend 退出分别确认。不会只凭超时假定终止。

认证明文工作区在创建任何明文前持久登记目录身份；控制器中断后，仅在旧 owner 确实终止、目录身份及固定文件集合检查通过时清理。登记前的进程中断最多遗留空私密目录。无法确认身份或出现未知文件时拒绝继续。输出以同卷非覆盖 hardlink 发布；link/unlink 间中断形成的两个已知别名须核对 inode、SHA 和链接数后修复。完成归档重放会认证并复用原密文，不重新导出或覆盖。

`restoreWorkflowArchiveV2` 是隔离恢复内核：只允许新的 `idms_workflowrestore_<tenant>_<12hex>` 数据库和最小 owner 角色，完整认证先于目标操作，按归档上下文建库，恢复后全量事实及两序列比较。schema 选择 dump 会显式创建 public，因此只在刚创建的空 template0 目标删除默认 public。失败会等原生工具真正 close 后清理自有目标。该内核尚不是控制器崩溃后的持久恢复状态机，不能用于原库覆盖或自动业务激活。

阶段证据见 `workflow-formal-archive-progress.md`。原 workflow 9124/4016 尚未切换、未冻结；源旧 jar、serviceToken、原数据库/角色保持。下一阶段仍需恢复侧持久意图/原生程序中断处理、完整来源与权限漂移负例，再规划原服务受控升级和新拓扑基线。精选源码审阅副本不是完整安装包；本阶段不构成跨服务原子灾备或完整商用验收。
