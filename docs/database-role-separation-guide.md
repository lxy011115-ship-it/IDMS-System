# 企业业务数据库角色分离

更新日期：2026-10-15。用户已确认设计。代码与隔离测试已完成；实际平台升级结果以 `outputs/live-database-roles-verification.json` 为准，不以本文作为验收证据。

## 角色与配置

| 角色 | 能力 | 配置（均为受限本机文件，不得分发） |
|---|---|---|
| 部署管理员 | 首次建立角色、转移已知对象所有权、数据库恢复 | `.local/postgres-runtime.json` |
| 每企业 owner | NOLOGIN，拥有本企业数据库、public schema、表、序列、触发器函数 | 部署配置内角色绑定 |
| 每企业 migrator | NOINHERIT，唯一允许显式 SET ROLE 本企业 owner 的迁移账号 | `.local/postgres-migration.json` |
| 每企业 app | 无角色成员关系、DDL、CREATE/TEMP、授权转授；仅业务必需读写 | `.local/postgres-business.json` |
| 每企业 backup | 独立只读登录，无成员关系和写权限 | `.local/postgres-backup.json` |

业务配置严格白名单，不接受bootstrap密码、控制面/工作流账号、迁移/备份密码或连接选项注入。业务进程只指定BUSINESS_RUNTIME文件；环境和文件仍由同一个Windows用户管理，**不构成操作系统级秘密隔离**。生产需要独立服务身份、文件权限/秘密管理与部署边界。

审计、已批准原事实/更正、输入行、文件和回执只允许SELECT/INSERT，禁止应用UPDATE/DELETE/TRUNCATE。v3的runtime_state计算视图及migration_snapshot_v2归档只读；实体、批次、business_state、outbox和工单按需UPDATE。应用仅有审计序列USAGE，不能setval。backup只可读表及序列，不能调用public函数或创建临时表。跨企业CONNECT和SET ROLE均拒绝。

## 迁移操作

1. 为acme与sandbox各做新加密备份并保存业务/上传摘要。核实拥有的进程，停止平台，确认企业app连接归零。
2. 独立执行 `npm run postgres:migrate -- --telemetry-tenants sandbox`，或通过 `npm run platform:start` 的部署前置步骤执行。不得以业务运行进程或BUSINESS_RUNTIME配置执行迁移。
3. 迁移在管理端advisory锁和迁移事务锁下运行，只接管已知旧app拥有的对象；未知对象/角色关系、版本或checksum不一致一律停止。新库种子、旧数据校验/投影回填、迁移记录及权限授予在本企业迁移事务内完成。首次所有权设置是独立事务，多个企业和配置文件不是跨库原子事务。
4. 部署生成独立配置；四个输出路径不得重复。失败时保留原数据、备份及配置，停止处理；不自动回退为高权限app，也不覆盖恢复企业库。
5. 启动时在数据库事务与企业共享锁内核对迁移版本/模块/角色绑定、对象所有权、有效权限与默认授权、追加保护触发器及函数正文、审计链及领域投影。没有迁移表、缺表或漂移则拒绝启动，业务不再运行DDL或补造投影。
6. 使用真实登录复查上传、数据查询、Flowable、AI影子网关和sandbox采集，比较原acme六批/零工单与原摘要；只读backup再次做真实隔离恢复。

已发布的version 1/2 checksum绑定DDL、模块和权限契约；更改契约必须增加显式迁移版本，不能改库记录绕过校验。模块切换也不能靠修改配置静默启用。迁移重复执行核对原版本，不自动修复损坏授权或未知变更。

## 验证

`npm run postgres:roles:verify` 使用本轮随机QA数据库，覆盖旧库/空库、并发重复迁移、真实CLI配置分离、路径冲突、正常事务/重启/幂等、应用DDL/篡改/跨企业拒绝、checksum/默认权限/backup列写权限/审计函数漂移阻断，以及只读pg_dump和v3的29表隔离恢复。证据为 `outputs/database-roles-verification.json`。破坏性故障注入只针对本轮自有QA对象，禁止在客户库运行。

## 仍未完成

仅分离企业业务数据库；Keycloak身份库和Flowable引擎库尚未采用相同分离机制。数据库所有者、部署超级用户和Windows账户仍可改变数据库/读取本机秘密，哈希链不代表独立不可抵赖保管。v3领域实体分表和双核心事务已验证，仍需专项字段/SQL、工作区加载/容量、高可用、外部审计保管、TLS、共享加密会话、细粒度设备范围、跨服务恢复、TimescaleDB和真实企业容量验收。`NODE_ENV=production`仍拒绝启动；本批不是完整商用交付。
