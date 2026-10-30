# 可移植身份服务生命周期

新增的 identity-lifecycle-portable 工具显式接收 Java 21、PostgreSQL 16 与 Keycloak 26.8.1 的路径。旧 Windows 工具和原身份服务保持原版；新入口只启动独立的自有 JVM，不接受原进程 PID 作为接管输入。

构建时固定 java/javac/jar 和关键 Attach/JVM 本地库的实际 SHA，编译原有的三份 Java 身份绑定与正常关闭源码，并固定生成的 class 与 agent JAR。Windows 使用对应 DLL，Linux 使用对应 SO；清除已有 Keycloak、Quarkus 和 Java 注入选项，使用明确的 Java 路径。

发行包下载器使用官方 Keycloak 发布资产的固定 SHA-256 和大小，校验完成后仅解压到全新目录，拒绝链接、特殊文件及越界路径。随后只复制 lib/bin/providers/themes 和公开根文件到另一份私有目录，不复制源 conf 或 data，不修改原发行目录。在副本中构建 PostgreSQL 运行配置后，再由启动器生成新的私有数据库和管理员配置。

每个新 JVM 绑定 owner、部署摘要、完整运行文件摘要、agent SHA、目录、PID 和实际启动时刻。停止操作沿用既有 Quarkus blockingExit 协议，核目标内部身份、停止回执、控制方释放、正常退出码 0、空 signal、停止日志及 JDBC 连接归零。重复停止等待同一操作，不增加 Attach 次数，不发送退出信号。

`verify-identity-normal-stop-portable-v1.mjs <PG16-bin> <JDK21-home> <Keycloak-source>` 使用独立临时 PG，验证真实 realm/user/access/refresh 创建、四类外部绑定错配、agent 内部身份拒绝、已存在回执不覆盖、正常停止和重启后原 UUID/refresh 保持。清理核精确数据库/owner/角色 OID，保留私密构建与审计材料。所有测试用户和数据均为新建合成资料。

GitHub 的 identity-portable-verification 工作流在 Ubuntu 24.04 执行上述检查，使用只读仓库权限，不使用云部署秘密、不上传私密配置、令牌或发行包副本。它不执行原身份数据库迁移、业务冷恢复准入、Flowable 或整站浏览器验收，不能代替这些完整部署步骤。

官方来源：[Keycloak 26.8.1 发布记录](https://github.com/keycloak/keycloak/releases/tag/26.8.1)。下载的原始公共发行包和后续私有 PostgreSQL 构建是两个阶段；原包 SHA 不被用来冒充修改后运行目录的摘要。
