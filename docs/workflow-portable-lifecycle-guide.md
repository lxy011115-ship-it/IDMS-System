# 可移植工作流构建与正常关闭

新增入口显式接收 PostgreSQL 16、JDK 21、Maven 3.9 安装目录，在全新私有源目录构建既有工作流服务。它通过固定的 Java/Classworlds 入口调用 Maven，不依赖 PowerShell、cmd、mvn.cmd 或全局环境变量。JDK 本地库、Maven 启动与库 JAR、构建源码、最终程序包均记录实际 SHA-256；构建后复核原件保持一致。

构建只复制既有 `workflowReservationBuildInputsV1` 清单，不复制用户配置、令牌或目标程序包。原 `services/workflow/target/idms-workflow-0.1.0.jar` 存在时须保持原 SHA；初始不存在时须持续不存在。两种状态都有明确证据。Windows 可以显式使用已有仓库离线构建，Linux CI 使用新建依赖目录及空白私有 Maven 设置，不读取用户的 Maven 设置或云部署秘密。

生命周期沿用原 Java Attach 与 Spring 上下文正常关闭协议，绑定 owner、部署摘要、程序包 SHA、目录、agent SHA、PID 和实际启动时间，只能启动新的自有 JVM。外部预检与 agent 内部均验证身份。重复停止等待同一操作和回执；不发送目标退出信号，不操作既有原站进程。

执行：

```text
node scripts/verify-workflow-normal-stop-portable-v1.mjs <PG16-bin> <JDK21-home> <Maven39-home> [offline-local-repository]
```

检查使用独立 PG 和两租户合成数据库，覆盖真实 Flowable 引擎、请求与 HELD 预留的重启保持、外部绑定与内部 owner 错配、已有回执不覆盖、SQL 锁阻塞请求在正常关闭时排空、同一停止操作不重复 Attach。四次新 JVM 生命周期须全部正常退出，每次 Spring 上下文回执、Web 排空日志、预期连接池关闭日志和实际 JDBC 连接归零均通过；最后按精确 OID/数据库 owner 清理测试库和角色，并正常关闭独立 PG。

GitHub 的 `workflow-portable-verification.yml` 在 Ubuntu 24.04 执行同一检查，只读仓库权限，官方 action 固定 SHA，无云部署凭据、依赖缓存或私密材料上传。此检查尚不代表持久 R4 控制器、冻结后的运行 schema、身份外置迁移、原站接管、浏览器和完整网站部署已通过；后续仍须将这些实际流程接入验证。
