# 恢复维护与页面审批

本入口用于已完成正式归档恢复、处于RESTORING的目标。它不会开启FIELD、应用登录角色、业务写入或激活。已有命令见 `docs/field-recovery-review-guide.md`。

`prepare-maintenance` 现可用于已提交/已批准的目标，以及提交前失败后留有合法review日志的VERIFIED目标。它完整认证实际归档、目标和审批链后生成新的私密reader目录。旧v1能力仍在review开始时失效；v2同时绑定全部review JSON及已知tmp的原始字节指纹。不得手工编辑能力、日志、phase或旧恢复结果以保持页面可用。

独立只读入口仍使用 `node scripts/field-maintenance.mjs --config <reader.json> --expected-sha256 <reader-config-sha>`。它可审阅当前恢复计划和审批记录，不接受审批写请求。备份账号实际为只读；每次查看重新核对35个关系、结构、角色、根、审计和原VERIFIED恢复锚点。

需要页面提交和独立审批时，由恢复管理员在私密目录创建canonical JSON监督配置。固定字段如下，所有路径必须为规范化绝对路径：

```json
{
  "format": "idms-field-maintenance-supervisor-v1",
  "tenantId": "<restored-tenant>",
  "operationId": "<same-restore-operation-uuid>",
  "controlFile": "<same-recovery-control-file>",
  "authorityConfig": "<private-authority-config>",
  "runtimeConfig": "<same-source-runtime-config>",
  "targetRuntimeConfig": "<same-target-runtime-config>",
  "targetMigrationConfig": "<same-target-migration-config>",
  "targetBackupConfig": "<same-target-backup-config>",
  "backupFile": "<same-authenticated-field-archive>",
  "keyFile": "<private-archive-key-file>",
  "externalConfig": "<same-pinned-external-read-config>",
  "authConfig": "<private-maintenance-auth-config>",
  "outputDirectory": "<existing-private-output-directory>"
}
```

用项目的 `canonical()` 序列化此对象，并用 `sourceFreezeSha()` 计算配置SHA。启动：

```powershell
node scripts/field-maintenance-review.mjs --config <supervisor.json> --expected-sha256 <supervisor-config-sha>
```

auth与external配置的公共OIDC字段必须完全一致，企业、登录客户端和外部authority保持原计划固定值。Keycloak登录客户端需准确允许 `<auth.origin>/api/v1/auth/callback`，开启授权码和S256 PKCE。origin限定独立回环HTTP端口，不能占用4010；NODE_ENV=production仍拒绝启动。监督配置和其引用文件只供恢复管理员保管，不得放入交付outputs、页面、命令日志或公开包。

页面显示当前恢复数据、计划作者及贡献者、摘要、期限、精确引用、待启用身份和已记录审批。作者核对后勾选确认并提交；已有计划时按钮明确提交替换计划。独立审批人须不在贡献者集合中。过期计划不能批准，应提交新计划。系统运维身份只能查看；同企业完整范围的final-approver可查看并独立审批。后端每次重新核验当前权限和工作流，不以页面按钮作为授权。

动作完成后旧页面关闭，待替代入口健康后重新登录。HTTP子进程只持reader配置，实际审批由固定目标的监督进程在恢复锁下执行；浏览器没有token导出接口，JWT不写入配置或审批日志。新锚点使用新cookie前缀，不继承旧会话。

“独立审批：已记录”表示已验证的历史提交。页面仍显示“当前外部状态：需重新核对”；后续新注册和激活须再次检查现态。若动作返回状态不确定，应使用同操作 `review-status` 核对实际阶段与唯一审计；不要重造计划、删日志或直接开启角色。未知配置/日志/目标变化关闭入口，需恢复管理员处理。

职责分离不提供同一操作系统账号下的文件系统沙箱。认证HMAC日志也不具备跨重启的外部防回滚锚点。这两点不能作为生产隔离或完整审计验收宣称。


v2注册候选计划的监督配置沿用上文全部字段，将format改为 `idms-field-maintenance-supervisor-v2`，并增加绝对路径 `registrationConfig`，指向同次恢复的单企业私密platform-v2配置。该路径固定于监督进程并检查文件字节，HTTP不能指定。提交、审批、幂等重试及最终SQL检查都会重新验证材料；页面展示完整公开候选、配置摘要、签发公钥标识和逐通道声明，秘钥和材料路径不会进入页面或reader配置。v1监督配置仍可用于旧v1计划；出现v2后不能用缺少registrationConfig的入口提交降级计划。

公开候选绑定平台Ed25519/request/event私密键和公共配置中的证书/传输声明摘要；它不替代实际对端、证书时效、CA吊销或线上握手验证。独立批准目前只记录这一待执行注册意图，实际注册和激活尚待最终事务接入。
