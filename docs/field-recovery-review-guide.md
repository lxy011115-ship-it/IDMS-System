# 恢复计划与独立审批命令

这些命令仅用于已有正式恢复结果、仍处于RESTORING的目标。它们通过原恢复authority操作锁运行，应用/迁移/owner保持NOLOGIN，backup保持只读。审批记录不会启用FIELD或普通业务，也不替代重新注册和激活。

额外会话按服务器真实backend_type/leader_pid识别：只认可autovacuum维护、本连接派生的并行worker和受核对的backup读角色；未知普通连接仍拒绝，不能用application_name伪装。字段含义见[PostgreSQL 16官方统计视图](https://www.postgresql.org/docs/16/monitoring-stats.html)。

以下 `<restore-arguments>` 表示同一次恢复的 --authority-config、--runtime-config、--tenant、--control-file、--operation-id、--target-runtime-config、--target-migration-config、--target-backup-config、--backup-file、--key-file。沿用该次真实文件，不另造目标或旧角色映射。

先执行 `node scripts/field-recovery.mjs --action review-status <restore-arguments>`。它完整认证归档与实际目标，返回当前stage、factsSha256、revision和planId；提交后recoveryPlan中可直接审阅作者/贡献者、计划摘要和期限、全部策略引用、备份/目标/激活身份及工作流摘要。审批前应核对这些具体内容。此命令需要恢复管理员配置，不是普通业务读接口。

作者事先生成唯一plan UUID，传入刚核对的facts SHA、受控外态配置与当前作者JWT私密文件：

```powershell
node scripts/field-recovery.mjs --action submit-review <restore-arguments> --plan-id <new-plan-uuid> --expected-facts-sha256 <current-facts-sha> --external-config <private-external-config.json> --access-token-file <private-current-author-token>
```

计划由实际目标的同快照数据生成，绑定数据库/备份/新激活身份、完整事实和精确已发布引用。传统模板缺少声明摘要时，明确使用完整正文摘要并标记LEGACY_BODY_SHA256，不能将它当作新现场许可。外态配置在同操作的所有计划间固定，不能静默更换issuer、客户端或外部authority。作者必须是当前同企业完整范围的业务提交角色。

独立审批人核对已提交计划后，使用其当前JWT和SUBMITTED阶段facts SHA：

```powershell
node scripts/field-recovery.mjs --action approve-review <restore-arguments> --plan-id <submitted-plan-uuid> --expected-facts-sha256 <submitted-facts-sha> --external-config <same-private-external-config.json> --access-token-file <private-current-reviewer-token>
```

审批者不能是任何贡献者；必须具备当前业务发布权限。提交作者的已认证记录也会重新查询当前账号/角色/企业范围/会话，不存储或伪造作者新JWT。外部工作流须仍与计划匹配，提交前再次现查。系统运维身份不能通过叠加角色自审。当前计划最长30分钟，过期或外态改变应重新提交。

JWT文件须由受控OIDC授权码/PKCE流程取得，私密存放，不能使用cookie、个人admin密码、服务账号令牌或自报身份头代替。需要在页面登录、提交和审批时，使用 docs/field-maintenance-review-guide.md 的独立监督入口；页面不会导出会话token。

替换已有计划时使用新UUID，并显式增加 `--supersedes-plan-id <current-plan-uuid>`；原贡献者会保留，不能换作者后让旧作者自审。替换也会使旧APPROVED记录失去当前阶段地位。不同计划、旧事实或其他审批者的回执不能悄悄重用。

每次执行记录独立attempt，审计、根revision和数据库review阶段同事务提交；结果文件在提交后全量核验才发布。回复丢失时先review-status，再以原plan UUID和相同输入重试：当前权限仍会先查，已提交事务不重复追加。异常元数据、缺失的已提交计划或冲突结果不自动修复；保留异常材料供调查。不要手工删除不认识的operations文件。

开始生成review日志后，旧只读维护清单会关闭。正式restore-target的原证明和结果不改写，也不能用旧restore重复命令覆盖审批后的根。新的v2维护锚点和独立监督审批页面见 docs/field-maintenance-review-guide.md；也可继续使用review-status核对。APPROVED表示审批已记录，状态仍RESTORING、activationEnabled仍false。


恢复新注册使用v2计划：提交和批准两端均增加 `--registration-config <same-private-platform-v2.json>`。配置必须是单企业、完整v2通道，引用同次RESTORING控制文件和原操作标记；根层实际加载Ed25519/request/event键并核对公共profile及当前审批。计划返回registration候选、配置SHA和新目标恢复身份，独立审批人须核对；材料变化不能沿用原计划，需新UUID和显式替换。已有v2计划后不能降级为省略注册的v1计划。旧v1记录仍可审阅与核验。

此候选检查不是实际FIELD_REGISTRY_OBSERVED或激活。当前目标仍RESTORING，应用/迁移角色仍不可登录；最终注册观察、激活事务、当前实际TLS材料/对端、新流与旧ACK失效将按 `docs/superpowers/specs/2026-10-18--field-recovery-activation.md` 继续完成。
