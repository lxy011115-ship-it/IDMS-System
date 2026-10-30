# 当前状态映射的现场恢复接入核对

本记录延续既有完整恢复与独立审批要求，核对当前代码的接入差异。正式恢复、人工审批与现场激活尚未完成。本轮没有修改既有 SQL 函数、目录见证、运行角色权限基线或云端配置。

## 已确认的差异

| 既有实现 | 当前实现与影响 |
| --- | --- |
| `scripts/field-recovery-review-context.mjs` 以 `public.business_state` 加锁，读取旧实体和完整 SQL 关系事实。 | 当前站点和现场使用 `state_map_v1` 的同一可信根。直接复用旧上下文会批准另一个数据集。 |
| `scripts/field-activation-security.mjs` 恢复旧 public/field 表权限与迁移角色成员关系。 | `scripts/legacy-v4-source.mjs` 要求旧源表、列和序列持续无写权限，`runtime-cold-facts-v1.mjs` 继续核验该事实。旧权限恢复模块不能用于当前根。 |
| `scripts/field-activation-prepare.mjs` 在最终事务登记注册观察和唯一激活审计，再发布原生 ACTIVE 文件。 | 当前根需保留同一提交语义，替换存储适配层；不能从 QA 的 ACTIVE 文件推导正式批准。 |
| `scripts/runtime-cold-portable-control-v1.mjs` 的 `admit` 会先打开注册数据库围栏，再恢复原 LOGIN 和连接上限。 | 正式现场恢复必须在此业务开放之前完成计划、独立批准与最终激活。不能先调用现有 admit 再把旧审批接到已开放平台。 |
| `scripts/state-map-v1.sql` 的 `_assert_current` 以 `session_user` 绑定原 writer/reader，并要求精确角色与目录状态。 | 只用 `SET ROLE`、仅传 bootstrap 连接或仅开放 runtime 写围栏均不足以调用原映射提交接口。不能放宽函数或重定已封闭目录摘要。 |
| `server/field-map-intake-bootstrap-v1.ts` 的空初始化拒绝已有 FIELD_EVENT 历史。 | 必须迁移完整点、回执、审计和历史签名信任。原离线 evidence pack 按 edge 有界，不能凭一份 pack 推断全企业迁移完整性。 |

## 已实测的事务机制

全新隔离 PostgreSQL 集群使用原 state-map 与 runtime-fence SQL 安装，封闭后不增加角色、权限、函数或触发器。bootstrap 在事务内暂存原 LOGIN、数据库连接上限和 OPEN 状态，使用 `SET LOCAL SESSION AUTHORIZATION` 切到既有 writer，调用原 `apply_delta_v1`，再恢复原认证身份。目录见证按原运行配置核验，不接受重新生成的不同基线。

这是维护控制者对原提交路径的使用，不能暴露给普通 HTTP、机器 HMAC 或自报角色输入。PostgreSQL 允许最初认证为 superuser 的会话临时切换 session/current user，并允许该命令用于事务中；`LOCAL` 的效果遵循事务设置规则。见 [PostgreSQL 16 官方说明](https://www.postgresql.org/docs/16/sql-set-session-authorization.html)。角色的默认会话配置不会随此切换自动加载，正式适配器仍需显式固定原会话参数，见 [ALTER ROLE 官方说明](https://www.postgresql.org/docs/16/sql-alterrole.html)。

两轮实际 Windows 机制试验分别检查普通暂存提交，以及维护记录先持久化、业务仍保持封闭的路径。精确结果见 [事务机制证据](validation/field-recovery-map-stage-windows-v1.json)。试验使用明确的 SQL 权威模型和普通 QA 文档，不含真实 OIDC 审批、FIELD 注册、原生 ACTIVE 发布或异常 COMMIT 恢复。成功不授予现场激活。

## 后续适配的完整要求

1. 为当前根定义独立版本的恢复上下文和计划，不把旧 SQL 计划自动升级。绑定原冷恢复 control/归档、实际 system/database/role OID、固定目录、原维护操作、完整业务根与审计前缀、全部贡献者、新恢复身份及准确注册材料。
2. 恢复目标对所有业务身份保持 NOLOGIN 和 CLOSED。读取通过维护者的真实只读快照核验完整根；不启动 SITE/edge 来代替维护读取。源保持冻结和已证明离线。
3. 计划与审批事务调用原映射增量接口，写入对应审计和阶段后，在提交前恢复准确 NOLOGIN/连接上限/CLOSED。持久记录可见而业务仍封闭。关闭/打开操作 ID、revision 和每次维护根均须进入不可变链，不能继续假定初始冷围栏 revision 未变。
4. 作者和独立审批者继续使用当前真实 JWT、实时 Keycloak 权限/会话、当前作者及完整 Flowable 状态；全部贡献者不能自审。当前权限优先于旧幂等结果，外态时效、范围和最终复读约束保持。
5. 最终激活在同一目标 SQL 事务追加精确注册观察、唯一激活审计及阶段，暂存精确运行配置；原生 ACTIVE 发布及材料/授权复查完成后才 COMMIT。其他数据库已打开的 SQL 围栏不能绕过全簇尚未提交的业务 NOLOGIN 屏障；相关操作须逐库可恢复且不开放外部业务。
6. 关闭并证明旧 SQL 连接终态后，才用新连接判断异常 COMMIT 的实际阶段。未提交恢复 RESTORING，已提交允许合法后续业务并只补原回执；不能从文件、异常消息或客户端意图猜测结果。真实进程中断、丢提交回复、材料/权限漂移及同操作重入仍需组合故障验证。
7. 迁移保留原点/回执 ID、原审计和历史公钥；不能把旧 SQL 审计改写为新 map 审计来通过新格式检查。迁移自身须具备源完整性、唯一索引重建、原值与签名核验、当前根成员证明及可恢复分支发布，再验证同一设备/证书/密钥的真实跨恢复新流。

以上是接入差异与下一实现边界。完整当前根恢复协调器、历史迁移和组合验收尚未实现；底层机制试验不代替这些工作。
