# 显式工作流数据库升级

本工具仅覆盖已审阅的 PostgreSQL 16、Flowable `7.2.0.2 → 8.0.0.0` 组合：process/common/eventregistry 存在，IDM 不存在，原 `idmsMaintenanceV1` 定义仍为 V1 且资源摘要相符。其他版本或组件组合会拒绝。它不是通用数据库升级器，也不会停止应用、变更账号权限或自动回退。

先停止并排空自有应用连接，建立升级前冷备，并在另一个目录真正还原，核对完整数据、定义、角色和权限。生产维护还需要独立的排他维护窗口与平台准入；本次证据来自隔离副本。

维护身份必须是非超级用户、非建库/建角色/复制/绕过行权限的专用登录角色，能够显式切换到已绑定 OID 的 NOLOGIN 对象所有者。实例绑定检查需要读取系统标识和数据目录。应用与协调角色必须已 NOLOGIN，目标数据库不能存在其他连接。不要为普通应用账号增加维护权限。

操作入口，在项目根目录使用受保护的配置文件运行：

```text
node src/workflow-security-candidate/maintenance/upgrade.mjs --config <私密配置文件的绝对路径>
```

配置字段如下。配置、密码、档案和解密密钥均不得提交 GitHub。

| 字段 | 含义 |
| --- | --- |
| `format`, `migrationId` | 固定 `1`；本次迁移的 UUID，重试沿用原值 |
| `host`, `port`, `database` | 固定回环地址、明确端口及数据库名 |
| `user`, `password` | 专用维护账号及其现有密码 |
| `systemIdentifier`, `dataDirectory` | 预先验证的集群系统标识及真实绝对数据目录 |
| `databaseOid`, `maintenanceRoleOid` | 精确的数据库和维护角色 OID 字符串 |
| `ownerRole`, `ownerRoleOid` | NOLOGIN 对象所有者及 OID |
| `applicationRoles` | 应用及协调角色的 `{name, oid}` 数组 |
| `backup` | `{file, sha256, backupId, keyFile}`，对应已实际验证的升级前档案 |
| `workDirectory` | 数据目录之外的已存在私密认证暂存目录 |

工具先校验 SQL 文件摘要、整个档案摘要与完整加密认证，再核对数据库身份。四段官方 SQL 和一条持久迁移回执处于同一事务；失败会回滚。相同迁移键与绑定返回原回执，变更绑定会拒绝。工具不输出密码或 SQL 原始错误正文。

迁移后应重新核对所有原始表，仅允许本配方的新历史列、三个版本值及独立迁移回执表发生变化，再恢复原登录状态并使用普通 runtime 模式验证。普通启动不迁移；显式 initialize 只接受空库结构，已有库也必须走本工具。

回退使用升级前档案在新目录实际还原后运行原 JAR，禁止靠改版本号、删列或直接运行旧 JAR降级。升级后新业务属于另一条数据分支，不能自动并入旧备份。资格与边界见[迁移和恢复报告](../../../docs/workflow-security-upgrade-and-recovery-2026-11-05.md)。
