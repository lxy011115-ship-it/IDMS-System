# 增量状态存储基础：使用与边界

2026-10-19。本模块为版本4领域存储准备持久基础，尚未接入当前业务事务。运行中的913源v2核心、原租户五迁移和旧全文摘要格式保持。禁止在原业务库执行本QA安装SQL。

## 文件与接口

- `server/state-map-v1.ts`：明确的二进制协议、严格JSON、根/回执摘要、成员和缺失证明，以及仅供测试/迁移审计的全量参考树。
- `scripts/state-map-v1.sql`、`state-map-schema-v1.mjs`：全新独立数据库的QA建表、最小角色、SECURITY DEFINER事务与DDL监测。不是版本3到4迁移器。
- `server/state-map-sql-v1.ts`：每次重新连接、校验外部固定的数据库/角色OID与目录摘要，执行CAS事务、提交后才返回、未知提交结果查询回执。没有权威进程缓存。
- `scripts/verify-state-map-postgres.mjs`：每次生成新nonce、两个测试库/六个角色，固定OID后精确清理，保留输入源码与报告。
- `scripts/cleanup-state-map-qa.mjs`：仅清理指定nonce、未标记清理成功且名称/OID/owner一致的中断QA资源。不列举删除其他库，不终止连接，不使用FORCE。

`PostgresStateMapV1`要求从受控安装/完整重验取得`StateMapBinding`。目录变化时不能调用inspect后自动接受新摘要；需要明确重验与重新授权。应用角色不能创建schema、直接DML、伪造私密写上下文或调用内部建树函数；只读角色不能执行delta。`state-map-v1.sql`不含实际密码。

写入先取得head，再构造`StateCommand`：租户、全局唯一commandId、预期revision/rootHash及1至64个不同namespace/key操作。每个操作携带旧值摘要或null（预期不存在），新值是严格JSON文本或null（删除）。JSON值null必须传文本`"null"`；不能和删除混淆。普通调用用`stateValueText`生成canonical文本；低层SQL提交的合法唯一键JSON保留原文，空白和数字表示差异会产生不同摘要。单值1MiB、整请求值文本8MiB、深度128。PostgreSQL自身的JSON数值范围仍可能拒绝某些极端原文，普通canonical有限数不受这一差异影响。

`apply`等待真实COMMIT成功才返回回执。失败操作全部回滚，预期根/旧值冲突需要调用方重新读取并重算领域命令。相同commandId和完全相同请求返回原回执，不增加revision；不同请求冲突。`StateMapCommitUnknownError`表示连接未确认COMMIT，不能立即发业务ACK，也不能随意换新commandId；重新连接并用原命令`resolve`，存在时核验原回执，不存在时再按同一幂等协议处理。SQL函数直接返回的行尚未代表外层事务提交。

`proof(namespace,key,trustedRoot)`核验调用方已信任的根，返回成员/缺失结论。历史根仍可查询，因为内容寻址节点和值不可更新。证明中的自报根不能代替可信根，也不能证明外部时间顺序、防超级用户协调回滚或跨服务灾备。

## 结构变更与完整性

受保护事务取得数据库内固定advisory事务共享锁。三个ALWAYS事件触发器在DDL开始取同键独占锁，在受保护schema变更/删除后增加非MVCC epoch。因此DDL等待受保护事务提交；回滚DDL仍使epoch变化，必须关闭并重验，不自动重新封存。ACCESS SHARE辅助阻止DROP；它本身不能阻止禁用普通触发器，最初假设已由实际测试否定并修正。

每次在查旧回执前检查当前租户/角色、权限、格式、目录和epoch；head同时绑定当前节点根及最新回执摘要。节点、值、回执有ALWAYS不可变触发器，复制模式也不能普通改写。对可以停用事件监测、伪造私密上下文、重写根/epoch/源代码的协调超级用户不声称外部真实性。本机角色保护与已有原库全图/文件验证不能被混同。

## 继续开发

下一阶段需在隔离库完成旧canonical/审计/六份原件的全量核验锚、原子迁移与旧/新写者互斥，再实现领域授权和有界依赖闭包。采集点、事件回执和审计必须同事务提交，原ACK和HTTP/工作流/AI/导入审批语义必须回归。当前通用namespace写接口没有完成这些业务约束，不能直接暴露给HTTP或现场设备。

旧节点和值继续保留；当前尚无归档/保留删除。物理节点访问计数仅是存储原语测量，不能当成整平台吞吐或SLA。跨服务灾备、真实FIELD、模型/RUL、安全与商业许可等完整商用范围继续。
