# 可移植的整站 R4 受控冷恢复

新入口将已验证的跨平台 PostgreSQL、Keycloak、Java 生命周期和 Maven 构建接到既有持久冷恢复协议。旧入口、原进程和原程序包保持原样。新路径显式接收安装目录，只创建独立测试集群、私有构建和新的进程，不接受既有 PID 作为所有权证明。

工作流使用新的 `build-workflow-fenced-portable-v1.mjs`。它保留原构建的六处精确转换和 `WorkflowRuntimeSchemaV1.java`：BOOTSTRAP 阶段安装结构；RUNTIME 阶段只验证既有表和唯一流程定义，禁止 Flowable 自动更新数据库结构和重新部署 BPMN。补丁边界必须唯一，十三个输入、生成的 Controller、原程序包和新程序包均有摘要记录。构建通过明确的 Java/Maven 入口在新目录进行，支持原程序包初始不存在的 Linux checkout。

冷控制器仍核原数据库目录、系统标识、角色与数据库完整清单、结构和门状态，沿用原加密镜像格式。仅切换到显式跨平台 PG 工具；Linux 路径比较保留大小写。所有实际动态网站、工作进程和工作流调用都使用同一新控制器路径。

执行：

```text
node scripts/verify-runtime-controlled-cold-portable-r4-v1.mjs <PG16-bin> <JDK21-home> <Maven39-home> <Keycloak-source> <source-bundle> <source-sha256> [offline-local-repository]
node scripts/verify-runtime-controlled-cold-portable-cleanup-v1.mjs <QA-nonce>
```

数据快照与预期 SHA-256 必须显式传入，不读取本机默认数据库配置，也不回退到演示数据。读取器核租户边界、审计链、载荷摘要、逐份原始文件摘要和字节数；摘要不匹配时在创建测试集群前拒绝。私有原件与公开样例使用不同的明确 profile，报告记录 profile 和实际文件数，不能相互冒充。

`export-controlled-cold-source-private-v1.mjs <business-config> <new-private-bundle>` 仅在原业务库的可重复读只读事务中捕获 acme 资料，核既有数据库安全绑定，再将六份、14513 字节的原件连同业务状态和证据写到新的私有文件。文件不含数据库密码，仍包含业务资料，应保留在私有位置。这一 profile 的原件保持验收必须继续在用户授权的环境进行。

公开 CI 通过 `create-controlled-cold-public-source-v1-qa.mjs` 从仓库中八份公开 CSV 模板产生独立测试快照，经过实际导入和合成的独立审核，覆盖七类数据。CI 不读取或上传本机原始业务资料。公开样例的 Linux 验证用于检查整套协议和平台行为，不能代替真实原件在 Linux 目标主机上的迁移验收。

整套检查保留实际四模块 HTTP、原生预测审批、撤销任务与对账任务、共享鉴权、独立身份权威和真实工作流引擎。测试先封存完整业务集群，关闭写入和登录，正常停止工作流及 PG，再捕获、认证和恢复整个加密 PGDATA。恢复的新集群必须保持原结构、角色 OID 和封存状态，等待实际 JWT、验证容差和租约窗口届满，并核当前签名身份权威及实时 realm 标记，之后才能轮换登记的 SQL 凭据、生成新配置并开放写入。

捕获的旧登录会话、重复或编码 cookie、旧回调和旧 SQL 凭据须被拒绝。新登录须保留镜像之外的角色撤销，新的显式授权才能让恢复后的实际对账工作进程提交。独立清理检查再读取正常退出回执、连接池关闭和 JDBC 归零证据，核测试数据库目录移除与源/目标 PG 干净离线。保留的冻结源、镜像、配置和审计材料均为私有测试证据。

GitHub 工作流使用 Ubuntu 24.04、JDK 21、固定 SHA 的官方 actions，以及已固定摘要的 Maven 3.9.11 和 Keycloak 26.8.1。只读仓库权限，不使用云部署秘密，不上传私有配置或镜像，不执行公网发布。

这条路径仍需在实际目标主机完成资源预检和安装，并完成原站进程的可信移交、身份外置迁移和生产组件登记。全浏览器 PKCE、所有控制器崩溃/回执丢失/部分目录恢复情形、全部服务令牌轮换、HA/PITR 和生产验收仍属于后续工作。真实测试集群通过不能代替用户服务器或公网网站的验收。
