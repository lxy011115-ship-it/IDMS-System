# 工作流持久停写控制

新增显式运维模块 `scripts/workflow-freeze-control.mjs` 和CLI `scripts/workflow-freeze.mjs`。当前只在实际恢复的38表QA库验证，原workflow9124/4016未停止、未冻结、未切换。

控制库单独创建，NOLOGIN owner、无PUBLIC/其他角色CONNECT和无角色成员关系。仅受信任bootstrap运维使用。每个操作绑定实际cluster标识、源数据库/业务角色OID、原权限/成员关系及密码验证器摘要；当前源码只支持明确的QA名和原acme/sandbox工作流库名，拒绝业务库、错误cluster、未知配置键和未拥有的冻结状态。

阶段为PREPARED→FENCED→DRAINED→RELEASED。FENCED在同一个PostgreSQL事务内提交业务角色NOLOGIN、DB连接上限0和控制行；既有连接仍可能执行，必须按准确pid/backend_start/datID/roleID退休并确认不存在，才记录DRAINED。重试使用相同operation UUID，不覆盖原属性；DRAINED重试保留原证明时刻。释放原子还原原LOGIN和connlimit，ACL/密码/数据不改；已释放操作不能重新冻结。

控制动作持有源DB对应的session advisory lock，未知会话、属性/权限/OID漂移、共享源角色、准备事务、订阅等拒绝，不自动修复。应用角色与普通用户被阻断，superuser运维仍在信任边界内；不能宣称抵御管理员或OS账户。

`pg_stat_activity`可在事务内缓存旧会话信息，因此每次关键会话检查主动调用pg_stat_clear_snapshot，并在DRAINED提交后再复核。实际QA复现了“连接已退出但旧快照仍可见”，刷新后才消失。[PostgreSQL 16说明](https://www.postgresql.org/docs/16/monitoring-stats.html)。

显式CLI接受三个参数，配置必须为绝对路径受限JSON文件：

```text
node scripts/workflow-freeze.mjs --config <absolute-private-json> --operation <uuid> --action prepare
node scripts/workflow-freeze.mjs --config <absolute-private-json> --operation <same-uuid> --action freeze
node scripts/workflow-freeze.mjs --config <absolute-private-json> --operation <same-uuid> --action status
node scripts/workflow-freeze.mjs --config <absolute-private-json> --operation <same-uuid> --action release
```

配置由受信任的升级协调器准备，包含format=idms-workflow-freeze-config-v1、authority（host/port/bootstrapPassword/controlDatabase/systemIdentifier）、source（scope/tenantId/database/user），不公开、不传给HTTP或浏览器。当前没有为原库生成或执行此配置。CLI不提供故障参数，QA进程barrier只在fixture中。

最终控制模块在三轮独立QA目标通过8个真实控制进程中断点；另实际测试公开CLI和幂等重放。旧写事务被退休回滚，已消耗非MVCC序列值不回退，释放后写和nextval恢复；未知会话/权限和catalog漂移、同名新OID均拒绝。自有进程/数据库/角色/私密凭据清理，原配置/两个旧jar/38表和两序列保持。

本阶段没有正式工作流归档。下一步需把归档的受控只读管理连接和原生dump准确绑定当前围栏、校验中断和序列静默，再受控切换原Java。先前LIVE_REVIEW_COPY_ONLY副本仍无恢复激活资格，不得改标签冒充正式档案。完整方案A和跨服务灾备/HA/生产安全等继续。
