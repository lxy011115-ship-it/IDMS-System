# IDMS工作流开源迁移候选

本目录是用户已批准的工作流安全维护路线A的独立代码目录，由GitHub维护。原`services/workflow`及其运行JAR保持不变。

候选使用Spring Boot 4.1.2、Flowable 8.0.0、Jackson 3.1.8，并锁定MyBatis 3.6.0以复核其实际内嵌OGNL代码。版本号和编译成功均不等于安全验收完成。

编译测试：在本目录使用JDK21及Maven运行`mvn -B -C verify`。本地构建输出`target/`和依赖缓存不提交。运行候选必须提供隔离配置，不得使用在线企业数据库。

普通启动继续使用校验模式和`databaseSchemaUpdate=false`。显式initialize只接受空结构，已有库必须使用[独立维护工具](maintenance/README.md)。当前系统换版仍受完整平台准入约束。

具体范围见[设计](../../docs/superpowers/specs/2026-11-05--workflow-security-maintenance.md)与[实施计划](../../docs/superpowers/plans/2026-11-05--workflow-security-maintenance.md)。已完成11项构建测试、实际引擎兼容修复、双企业显式迁移、九类路由、升级后恢复及原JAR档案回退，详见[最新验证报告](../../docs/workflow-security-upgrade-and-recovery-2026-11-05.md)。全部依赖的维护者公告适用性、完整平台恢复和生产配置仍未验收。[首批构建报告](../../docs/workflow-security-candidate-2026-11-05.md)保留历史结果。
