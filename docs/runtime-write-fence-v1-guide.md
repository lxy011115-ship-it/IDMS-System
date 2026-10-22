# 数据库持久写入门 V1

本层用于新部署的维护停写和冷恢复准备。状态保存在 PostgreSQL 中，控制连接断开不会自动开放。只保护已登记的普通持久表；目前没有安装到原运行站点，也没有完成跨数据库维护控制器。

## 安装顺序

1. 在全新受控数据库安装 `runtimeWriteFenceSchemaSqlV1`。数据库/表由 NOLOGIN owner 持有，控制登录与运行登录分离；初始状态为 CLOSED。
2. 每个新 schema 在其原 DDL 见证触发器建立之前插入 `runtimeWriteFenceAttachSqlV1`，可使用 `wrapFreshRuntimeWriteFenceSqlV1`。附加 BEFORE STATEMENT、ENABLE ALWAYS 触发器覆盖 INSERT/UPDATE/DELETE/TRUNCATE，包括旧 SECURITY DEFINER API 操作的内部表。
3. 登记所有运行角色并限制序列、大对象写入等绕过能力。`restrictRuntimeWriteFenceActorsV1` 会撤销本数据库相关 `pg_catalog` 大对象函数的 PUBLIC/运行角色 EXECUTE；使用大对象的应用需另行设计，不能直接套用本安装器。
4. `finalizeRuntimeWriteFenceV1` 只允许一次 CLOSED 封存。它检查实际表覆盖、ALWAYS 触发器、事件触发器、角色能力及权限，返回需独立保管的目录/数据库绑定；拒绝再次封存，不提供接受漂移的新基线功能。
5. 由可信维护控制登录创建 `RuntimeWriteFenceControlV1(account,binding)`。调用 `open({expectedRevision,operationId,authority})` 前准备真实签名 ACTIVE 权威和 view-realm 只读服务账号；`close({expectedRevision,operationId})` 不依赖身份服务可用。

这些接口供受控安装器调用，不接收任意网站访客提交的 SQL 连接信息。不要把 bootstrap 密码、writer key、私密绑定文件或备份密钥发给运行站点。

## 事务行为

写触发器以非阻塞方式获取共享事务 advisory lock，并对门状态行 FOR SHARE。锁持续到 COMMIT/ROLLBACK。关闭操作取得同一键的排他事务锁，等待在途写事务结束，再提交 CLOSED。

当关闭操作已排队，后来的首次写入立即报 `RUNTIME_FENCE_DRAINING`。这也处理“先持有业务行锁、后首次写入”的锁顺序：拒绝后来写事务，让它回滚释放行锁，使原写事务完成。已取共享锁的事务可以完成其原事务；调用方收到 CLOSED 回执时这些事务已经结束。

REPEATABLE READ 的旧 OPEN 快照不能授权关闭后的写入，实际验证得到 SQLSTATE 40001。调用方需回滚事务，不得以缓存状态重试绕过。纯读操作保持可用。

OPEN 在 SQLite `BEGIN IMMEDIATE` 期间核签名链、实际当前 realm marker，并提交 SQL 门状态，排除权威 writer 在这个开放窗口追加 DRAINING。它同时核数据库 system ID/OID、角色和目录绑定。此互斥不等于在未来身份变更时自动关闭所有数据库：全局控制器仍必须先记录维护意图、逐库排空、停止后台，再迁移/捕获。

## 支持边界

- PostgreSQL 16，自有普通表；分区表、外部表、物化视图作为持久写对象拒绝封存。准备事务要求禁用且无已准备事务。
- 运行角色不拥有持久关系，不具备 CREATE、角色成员关系、超级用户、复制、CREATEROLE/CREATEDB/BYPASSRLS、SET session_replication_role、序列 USAGE/UPDATE 或大对象操作权限。已审核的 owner 函数定义随目录固定；本层不是任意第三方 SECURITY DEFINER 代码的审计器。
- 运行角色能力/成员关系在每次触发时重查。数据库 DDL 推进非事务序列；即使 DDL 回滚，仍拒绝继续写入和重新开放。未知表使覆盖检查失败。
- 控制角色和超级用户是受信任维护身份。直接调用底层 SQL 状态函数是其权限；触发器仍检查封存 epoch。不能宣称防范恶意超级用户或整体控制材料回滚。
- 原 Flowable APP 所有权、各后台角色和跨库顺序仍待迁移。本层的附加触发器不得直接补装到已接受外部目录指纹的旧站点；必须安排正式新部署/迁移。
- 实测为 Windows 自有 PostgreSQL/Keycloak。Linux、全部工作流/队列写路径、控制器崩溃重入/回复丢失、跨库原子维护与生产准入尚未验收。

## 验证

`node scripts/verify-runtime-write-fence-v1.mjs` 只创建新的隔离集群、数据库、角色和身份服务。验证实际旧 SDK、直接 SQL、并发排空/业务行锁反序、RR 旧快照、权限绕过、当前权威、CAS、DDL 回滚和整个 PGDATA 加密冷恢复。

每次运行使用新的 nonce，私密证据留在 `work/runtime-write-fence-v1-20261022/<nonce>/`，不提交仓库。结束后使用 `node scripts/verify-runtime-write-fence-cleanup-v1.mjs <nonce>` 只读核验 PostgreSQL 关闭、JVM 正常退出及清理回执。失败报告应保留，不能用后续成功结果覆盖。

机制依据：[PostgreSQL 16 锁](https://www.postgresql.org/docs/16/explicit-locking.html)、[advisory lock](https://www.postgresql.org/docs/16/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS)、[事件触发器](https://www.postgresql.org/docs/16/event-trigger-definition.html)。
