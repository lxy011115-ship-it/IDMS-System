# 恢复后的只读维护核对

当前入口用于开发阶段本机恢复核对：目标已完成正式 `restore-target`，恢复状态仍为 `RESTORING`。本HTTP入口的普通业务、FIELD、审批和激活写入口均关闭。独立终审CLI见[恢复计划命令](field-recovery-review-guide.md)；审批开始后旧v1维护清单关闭；新v2锚点和独立监督审批页面见[维护审批指南](field-maintenance-review-guide.md)。商业部署尚未验收。

先在身份服务中配置独立 OIDC 客户端，使用 PKCE S256、标准授权码流程，回调精确指向选定 loopback origin 的 `/api/v1/auth/callback`。issuer、audience、角色和企业声明遵循现有 IDMS 认证规则。不能复用 `idms-web`；维护端口不能使用原核心 4010。当前企业的 `system-admin`、`platform-certifier`、`tenant-admin`、`auditor` 企业范围身份，以及三个范围均显式为 `*` 的 `final-approver` 可核对。

私密认证配置的示例结构如下；按实际受控环境填写：

```json
{"mode":"oidc","issuer":"http://127.0.0.1:8081/realms/idms","audience":"idms-api","clientId":"idms-recovery-maintenance","origin":"http://127.0.0.1:4110"}
```

由持有原恢复操作权限的操作者执行准备命令。参数沿用该次恢复的真实配置和 operation ID；输出目录必须已存在，且位于控制文件的 `.operations` 目录之外。

```powershell
node scripts/field-recovery.mjs --action prepare-maintenance --authority-config <authority.json> --runtime-config <source-runtime.json> --tenant <tenant> --control-file <control.json> --operation-id <operation-uuid> --target-runtime-config <target-runtime.json> --target-migration-config <target-migration.json> --target-backup-config <target-backup.json> --backup-file <authenticated-backup> --key-file <archive-key> --auth-config <maintenance-auth.json> --output-directory <private-existing-directory>
```

准备会重新认证归档并核对已恢复目标，创建新的私密维护目录。保存返回的 `configFile` 和 `configSha256`，启动独立读取进程：

```powershell
node scripts/field-maintenance.mjs --config <returned-reader.json> --expected-sha256 <returned-configSha256>
```

此进程只接收目标只读 backup 凭据和维护认证配置，不传入 authority、迁移配置或归档密钥。打开返回的 origin 登录并核对；页面显示完整关系计数、摘要及恢复出的历史发布引用，新v2锚点还显示当前计划及已记录的独立审批；当前外部状态仍需重新核对，不能凭历史记录激活。页面提交和独立审批见 docs/field-maintenance-review-guide.md。

维护清单最长有效 30 分钟。配置、控制围栏、角色、阶段、结构或数据核对异常时拒绝结果；配置或控制文件改变会关闭入口。异常文件保留供调查，不自动修复。到期后须重新准备并使用新返回的摘要启动。按 Ctrl+C 关闭进程；会话仅在本进程内有效，重启后需要重新登录。

维护目录内的认证日志记录登录、退出和成功核对，必须私密保留；缺失或无效日志拒绝启动。它不修改目标库，也不替代后续独立终审所需的权威审计。`NODE_ENV=production` 当前直接拒绝启动。原核心切换、服务账号隔离、TLS 和部署验收仍属后续门槛。
