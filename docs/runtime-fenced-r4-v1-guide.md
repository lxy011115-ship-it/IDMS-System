# R4 全库围栏与持久维护控制

本层将持久写入门接入完整的新自有 R4 拓扑。活动库安装 SQL 门；旧业务源完成既有永久撤权后保持原 public schema，由原 verifier 核验，不补装会破坏旧见证的 schema。身份服务使用另一个 PostgreSQL 集群。

## 新部署安装

显式创建 `RuntimeFenceProvisionV1(adminAccount,authorityRuntime)`，传入新版 `authority-fenced-site-v1-qa.mjs` factory。新版 factory 保留旧 SQL/SDK 和旧 factory 源码，在各 schema 自己的 DDL 见证建立前添加 ALWAYS 表守卫。所有运行角色逐库登记，覆盖不足和角色能力超限会阻止一次性封存。

初始化期间只有可信安装器可在未封存的门上进行受控 bootstrap，不得将这一阶段报告为 READY。`seal()` 正常停止自有工作流，逐活动库关闭和固定 catalog，再核实际签名 ACTIVE 权威开放，最后重启工作流。此 fresh 安装器尚不提供安装中断后的生产接管；失败的测试环境应保留失败记录、精确清理，使用新环境重试。

旧源库使用 `registerLegacy` 记录原永久 ACL 事实：原 APP 不可写表/列、推进序列或执行 public 函数，额外撤销大对象函数 EXECUTE。旧源仍可登录读数据，不能将其描述为 NOLOGIN 或所有连接已退役。维护控制必须将活动门清单与退休源清单一起对照真实数据库 inventory。

## 工作流运行模式

`node scripts/build-workflow-fenced-v1.mjs` 在独立目录复制固定输入并编译运行版本，保留原 `services/workflow` 源码和原 target JAR。新增配置字段位于每租户账户：

```json
{"schemaMode":"RUNTIME"}
```

BOOTSTRAP 只用于新的自有安装，仍执行原建表和流程部署。正常停机后将 APP 所有的对象、数据库和 public schema 转交 NOLOGIN owner，撤 CREATE/所有权，授予既有普通表的必要 DML，安装和封存门。新运行配置使用 RUNTIME：仅核自有表存在，将 Flowable schema update 设为 false，读取既有定义并核 BPMN 与构建资源字节一致，不自动建表或部署流程。未知模式拒绝。

生命周期工具复制配置并固定配置/JAR/agent/目录/PID-start；BOOTSTRAP 和 RUNTIME 使用各自新文件，不能修改已启动实例的私密配置冒充原绑定。此版本不接管旧原站工作流进程。

## 持久关闭意图

`createRuntimeMaintenanceV1(controlDirectory,activeManifest)` 在 PGDATA 外创建独立私有 SQLite WAL/FULL 控制库和 trust。`RuntimeMaintenanceControlV1(adminAccount,trust,activeManifest)` 固定 manifest SHA、各库 system ID/OID、deployment、角色和目录绑定。

1. `prepare({operationId,expectedRevision})` 检查所有活动门的实际 OPEN/封存事实，CAS 提交 DRAINING 意图，并固定每库关闭 operation ID 与期望 revision。不同活动操作互斥。
2. `close({operationId})` 以 SQLite 写事务互斥，按已保存编号逐库调用持久 SQL 关闭。SQL 提交与 SQLite 事务分属不同存储，不能宣称跨库原子事务。
3. 控制进程在部分 SQL 已提交后退出时，SQLite 未完成事务回滚，已提交 DRAINING 意图保留。新进程用同 operation 续接，依据每库原编号识别先前已提交结果，其余库继续排空关闭。
4. 全部关闭后提交 CLOSED 回执。重复调用仍核对实际 SQL 门，回执相同且不增加 store revision；不会仅凭旧文件回执宣布当前库已关闭。

`afterDatabaseClosed` 用于可信测试观察/故障注入，不接受前端提交的脚本。运行站点不持有 SQL 控制密码或此控制库的写权限。

CLOSED 仅证明登记活动门的写事务已排空。它不是“允许捕获/恢复上线”的回执：全局入口、后台组件退役、旧源角色/连接清单、身份退休与当前权威、JWT verifier 宽限和真实 lease expiry、全 PGDATA 关闭及恢复准入仍须组合验证。当前模块不自行开放数据库或重置见证。

## 验证入口

`node scripts/verify-runtime-fenced-r4-v1.mjs` 创建新的业务与身份集群、真实 Keycloak、Flowable、预测服务和 R4 入口，执行完整 fresh schema/bootstrap/一次封存/实际业务动作与停写检查，并注入控制子进程退出。私密配置、失败历史和离线证据在 work 下保留，不提交 Git。最终用户图文/视频资料与原站正式上线另行完成。
