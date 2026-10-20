# 旧库到增量映射的迁移锚

当前仅完成隔离迁移边界。验证脚本创建自有QA源库和目标库，原运行acme只做只读快照获取六份原件；没有对原租户撤权、停写、DDL或切换格式。913源v2仍负责实际业务。

## 数据范围

源必须是五迁移、schema_version=3的标准独立租户库。先用现有BusinessMaintenanceGate排空写入和后台lease，锁根与所有基表；现有readEntities/validateBusinessDatabase核验全文摘要、完整审计、文件SHA与管理投影。然后扫描全部31/33基表，包含实体、文件/input rows、审计、SQL投影、registry、两outbox、迁移表、遥测表。序列值作为非MVCC锚单独核验，runtime_state视图通过完整payload验证，不当成另一个可写副本。

原始SQL行使用PostgreSQL `to_jsonb(t)::text`，按C序排序，保留全文字节；没有经JS JSON.parse转换SQL大整数或高精度数值。每表摘要与原backup-support的databaseFacts独立扫描比对。固定UTC/ISO/hex/float会话设置保证重读一致。超过256KiB的行分块存入不可变blob，描述绑定每块及全文SHA、字节数、scope/key，单文本上限64MiB；超限拒绝，不截断。

TenantPayload另按全部业务/导入集合、audit和idempotency的顺序项保存。重构后必须与旧canonicalDigest一致，并通过旧验证器，不以单个整租户blob作为未来写入快路。SQL行与payload两者都保留，不能只验证其中之一。

## 持久停写与封存

临时维护门会因进程退出释放，不能充当版本写者围栏。`commitLegacyV3Fence`在同一个排空事务中撤销源APP全部基表、列的DML及序列USAGE/UPDATE与函数执行权，检查当前权限和源事实，再实际COMMIT。旧APP读取仍可用，后续DML不能继续；数据库owner/受控迁移管理员不属于运行写者。

验证包括门前已经等待根锁的真实旧事务。即使其第一条SELECT已通过权限检查，后续UPDATE仍被撤权拒绝；序列nextval也被拒绝。迁移子进程退出后，用新连接核对相同cluster/库/角色OID、原root/所有表/序列、角色与结构绑定。只排除这次已明确计划的表/函数ACL字段，其他源结构必须与捕获锚一致，不能通过重新读取目录自动接受结构漂移。

目标`LegacyV4MapBuilder`每批最多32项且值文本不超过4MiB，用基础模块的CAS提交，每批独立重建全部已导入映射根。`verifyLegacyV4Map`在只读快照中逐项读取成员证明，重构全部SQL原文和完整payload，重建根并确认没有未访问的额外键。部分导入没有seal，不能激活业务。

只有源持久停写经新连接核对、目标完整核验后，才以同一操作ID提交`receipt/legacy_v3_seal:<operationId>`。seal绑定旧业务摘要、源身份/清单、目标导入根和验证摘要，使用不可变命名空间。重放返回同一回执，修改/删除seal拒绝。客户端未知提交结果仍须按原命令resolve，不能换ID发第二条。封存完成也不代表已经启用v4业务格式。

## 复核与继续

已有发布材料只读核对：`python work/legacy-v4-migration-20261019/check-progress.py`。两个真实库迁移的最终执行源固定于`work/legacy-v4-migration-20261019/cf746eb6e123/input-source`，成功阶段不可重复执行。QA验证器再次调用会创建全新nonce和独立资源；没有原部署参数。成功或失败的自有资源按记录OID/owner核验、等待自己连接关闭后清理，不终止其他后台，不FORCE删库。child私密配置含管理凭据，清理后删除，不能放入公开输出。

下一阶段仍需构建领域直接索引、来源治理与批准记录的有界依赖闭包，原子追加测点/回执/审计，接入当前服务API、HTTP/审批/工作流/AI及完整回归。当前map的通用namespace权限不代替业务授权。保留期、生产部署与跨服务灾备继续，不能从本迁移验证推断已完成整系统升级。
