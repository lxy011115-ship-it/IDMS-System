# 企业业务库备份与隔离恢复

更新日期：2026-10-30。当前工具用于PostgreSQL 16本地实例的数据保护与隔离恢复演练，不是生产灾备或自动业务切换。

## 覆盖范围

备份完整企业业务数据库的架构、公共表及idms_spares各表和分区，包含上传原文件/快照、批准记录、模板/插件记录、幂等请求、工单投影、SQL审计账本、备件采购/库存/更换/票款及回执、存在时的AI/工作流outbox与遥测表。使用pg_export_snapshot和pg_dump的同一MVCC快照，让逐表校验与导出对应同一提交视图，避免一边写入一边导出造成数据和校验摘要不同。

恢复校验包括全部公共表及idms_spares表的列定义、行数、按规范顺序的逐行SHA-256、原文件摘要、租户归属、追加式审计哈希链及SQL账本列/事件/业务快照的一致性。触发器和索引由pg_dump/pg_restore恢复；隔离QA还验证了审计不可更新触发器。

新备份清单format=2增加备件版本、实体/事件/回执数量、首末序号、GENESIS及首尾事件哈希，恢复时在同一RR只读快照中重算全部事实和锚。正文加密封装仍为IDMSBKP1，旧format=1清单仍可读取和完整恢复；旧清单缺少锚不等于备件为空。新格式逐表摘要固定UTC/ISO/hex等文本设置，旧格式保持原会话文本语义。详见[备件完整归档验证](spares-archive-recovery-guide.md)。

明确不覆盖：独立Flowable流程库、Keycloak身份库、本地AI网关回执文件、边缘SQLite缓存、模型和部署凭据。因此结果固定标记`ISOLATED_BUSINESS_ONLY`，不能将此备份单独挂回当前平台运行，不能宣称跨服务一致性恢复或完整灾备。企业业务库已增加独立只读backup账号；部署超级用户和独立服务仍存在生产权限与保管缺口，见[数据库权限分离](database-role-separation-guide.md)。

## 加密与保存

- 独立32字节随机密钥、每份备份独立随机nonce，AES-256-GCM认证加密。租户、清单和压缩dump均加密；备份中不携带解密密钥。
- 不生成明文dump文件；压缩dump与解密结果在有界内存中处理。目前压缩dump上限128 MiB、清单上限256 KiB，命令上限120秒。超过预算明确拒绝，不截断、不自动扩大门槛；更大的备份需先扩展流式/分块及存储方案。
- 文件独占创建并同步落盘，禁止覆盖已有密钥、备份和恢复凭据。Windows限制为当前账户ACL；工具不输出密钥、数据库密码、原始文件内容或SQL错误正文。
- `.local/backups/`保存加密备份，`.local/backup-keys/tenant-business-v1.json`保存本机独立密钥，两者均不进入演示包或公开outputs。但同机分目录不是异地灾备，也不是独立保管。生产须使用异地备份和离线密钥/KMS。
- 密钥丢失无法解密；密钥泄露须轮换并保留旧备份所需密钥。不得把凭据或密钥发给客户或写入聊天。

## 命令

本机PostgreSQL必须运行，工具调用现有`%LOCALAPPDATA%/IDMS/runtime/pgsql/bin`中的pg_dump/pg_restore，不需重新安装。备份默认使用`.local/postgres-backup.json`中的独立只读账号；拒绝BUSINESS_RUNTIME/BUSINESS_MIGRATION配置。恢复仍使用部署配置`.local/postgres-runtime.json`创建隔离库；可用`--config`指定另一受控配置。升级前尚无独立backup文件时，可显式指定旧部署配置做保护性备份；已生成角色布局的部署配置也优先选用独立backup，不使用app。

首次设置独立新密钥（已有同名文件会拒绝覆盖）：

```powershell
npm run backup:create -- --generate-key .local/backup-keys/tenant-business-v1.json
```

为企业生成新备份：

```powershell
npm run backup:create -- --tenant acme --key-file .local/backup-keys/tenant-business-v1.json
```

命令返回随机命名的`.idmsbackup`路径、备份ID和校验摘要，不返回数据正文。`--output-dir`可指定专用备份目录。不要把密钥放进输出目录。

隔离恢复需明确指定企业、对应备份和密钥，以及全新目标和全新凭据文件；目标必须匹配`idms_restore_<企业名>_<12位随机十六进制>`，总长不超过PostgreSQL标识符上限63。企业名中的短横线在目标名称中改为下划线。目标数据库或角色已存在时一律拒绝，不提供覆盖/clean选项。

```powershell
# 将示例备份ID和目标随机后缀替换为本次真实值；不要复用已存在目标。
npm run backup:restore -- --tenant acme --key-file .local/backup-keys/tenant-business-v1.json --backup-file .local/backups/acme-实际备份ID.idmsbackup --target-database idms_restore_acme_012345abcdef --credential-file .local/recovery-check/restore.json
```

恢复前完整认证加密文件，失败时不连接数据库、不执行SQL。通过后创建新的非超级用户和独立数据库，以单事务执行恢复并重算校验。不改变网站配置、现有企业库或身份；恢复目标只用于受控检查，不会自动开放业务连接。恢复凭据仅落本机受限文件。

恢复失败会保留隔离目标与恢复凭据，便于运维检查；不会自动删除可能有价值的数据。人工恢复不自动清理目标，需核对确切名称、访问范围和审批后处置。自动QA脚本只删除自己本次随机命名的测试资源，不涉及原企业数据库。

## 本机证据

2026-10-30新证据：`node scripts/verify-spares-archive.mjs`，47张完整业务表实际加密导出/隔离恢复，恢复10013实体、20015备件事件、14回执，验证采购、库存、历史和原键重读、并发快照、旧格式、篡改/跨企业/错误锚/目标防覆盖/超体积拒绝。两个实际企业也已使用既有只读备份角色和原密钥生成并认证新格式档案，版本、实体、事件和回执数量不变。证据`work/spares-archive-20261030`；真实企业本轮只做备份，恢复业务验证在合成隔离库完成。

下列为2026-10-15历史验证入口和记录，不代表2026-10-30的实际企业状态：

```powershell
npm run backup:verify
npm run backup:live:verify
```

隔离QA创建合成设备上传并独立批准，在导出时并发更新额外SQL表，再真实恢复验证；覆盖密钥/文件篡改/租户绑定、认证前不连接数据库、已有目标拒绝和非超级用户。临时库/账号清理后才结束脚本。证据见`outputs/backup-restore-verification.json`。

实际企业验证只读备份acme，恢复至新建隔离数据库并逐表验证；结束删除该临时恢复库/角色/凭据，保留正式加密备份和密钥。比较原基线确认acme6批/0工单和所有原imports/business摘要未变。证据见`outputs/live-backup-verification.json`；证据文件只记录路径、状态与摘要，不包含备份内容或密钥。

单次本机恢复耗时不是RTO承诺，也没有证明RPO 15分钟/RTO 4小时。正式生产交付还需跨服务恢复目标、Flowable/身份/网关/边缘备份策略、自动调度/保留/告警、异地加密与密钥保管及实际故障演练。备件完整归档不会删除热库历史，也不等于已完成冷热数据分层。
