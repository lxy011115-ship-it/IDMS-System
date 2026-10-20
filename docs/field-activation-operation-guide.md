# 恢复激活与中断恢复命令

入口为 `node scripts/field-activate.mjs`，支持 `--action activate` 和 `--action recover`。适用于既有完整备份恢复、独立 plan-v2 批准后的确切操作及新目标；原正式系统本阶段仍不部署 FIELD。命令不启动采集进程。

两种操作均要求以下参数，每个参数只能出现一次：

```text
--authority-config C:/private/authority.json
--runtime-config C:/private/source-runtime.json
--target-runtime-config C:/private/target-runtime.json
--target-migration-config C:/private/target-migration.json
--target-backup-config C:/private/target-backup.json
--backup-file C:/private/archive.idmsflb
--key-file C:/private/archive-key.json
--control-file C:/private/recovery.json
--operation-id <原恢复操作UUID>
--attempt-id <本次激活尝试UUID>
--plan-id <实际已批准plan-v2的UUID>
--tenant <企业标识>
--registration-config C:/private/platform.json
--material-configuration C:/private/activation-materials.json
--external-config C:/private/recovery-external.json
--access-token-file C:/private/current-reviewer-token.txt
```

`activate` 另需 `--expected-facts-sha256 <当前APPROVED事实摘要>`。这些是路径与格式示例，不能替代真实恢复生成的配置。凭据仅从私密文件读取，参数和公开结果不接受密码、token或调用方自报材料检查证据。材料清单格式见[材料校验说明](field-activation-material-guide.md)。命令固定并重读配置字节；本次调用期间变化即拒绝。

首次激活在 authority 锁下重认证完整归档与恢复/审批祖先链、当前实际目标、当前 OIDC 独立批准者及作者、完整当前 Flowable 和准入策略，核对指定 plan 与事实后才写入本 attempt 的原生 publication 意图。实际材料检查由内部创建的短期能力执行，必须生成 attempt-v2；不能利用内部旧 v1 分支跳过。随后注册观察、激活审计/root/sequence/ACTIVATED 及运行权限在同一 SQL 事务准备，原生发布 ACTIVE/释放原标记后再次核对材料/外态，最后 COMMIT。

命令异常会先关闭并等待旧 SQL 连接，再用独立上下文认证完整归档、目标数据库/四角色 OID、原操作与确切 publication，判定实际提交状态：

- 实际仍是原 APPROVED 且权限精确 FROZEN：核对全部事实、完整审批祖先和未知连接；当前批准者/作者权限及当前流程仍有效时，才重装原标记并 CAS 恢复 RESTORING。返回 `newAttemptIdRequired: true`，下一次激活必须使用新 attempt UUID。原 attempt 的材料 MAC、时间和记录不可重写。重复恢复不改 SQL。
- 实际是本 attempt 的 ACTIVATED 且权限精确 RUNTIME：验证受保护审计/阶段、原始物理审计前缀、完整历史审批和当前根/注册历史，校验或补写固定回执。正常业务可已推进，不要求当前实体等于激活前值，也不重复注册、审计或根写入，绝不回退 RESTORING。
- 其他状态、错操作/目标/角色/文件、未知变更或损坏记录：保留并拒绝，不推断提交结果或自动修复。

原生publication意图已持久记录后、提交前强制终止进程，可用同一 operation/attempt/plan 调用 `recover`。相同 `activate` 的重复调用若已存在本 attempt 的 publication，也先走实际状态解析；它不能重新使用旧材料能力。普通旧 `resume` 继续拒绝未知 ACTIVE。若publication尚未持久记录就中断，recover拒绝缺失意图；确认仍为原RESTORING/APPROVED后使用新attempt发起激活，旧暂存文件保留，不猜测或覆盖其内容。

返回已提交回执之前也必须有当前有效 token、同一独立批准者的当前角色/完整范围、当前作者权限及当前业务对应的完整 Flowable 状态。检查使用当前目标工单，不把历史 plan 的 workflow 摘要强加于合法后续业务。历史材料过期不会把已提交事务重新激活，回执恢复不再次连接设备或发放 lease；后续新流和旧许可/ACK失效需另行验证。当前撤权优先于旧回执或损坏回执错误，异常内容保留。

线缆层故障验证使用仅限自有本机隔离库的 QA 代理，实际匹配 PostgreSQL 启动包和激活 COMMIT 请求，截断服务器真正的 COMMIT CommandComplete，再由正式命令读取实际数据库状态。该代理及提交前暂停包装器不进入生产命令，不修改生产事务逻辑。
