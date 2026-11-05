# IDMS工作流开源迁移候选

本目录是用户已批准的工作流安全维护路线A的独立代码目录，由GitHub维护。原`services/workflow`及其运行JAR保持不变。

候选使用Spring Boot 4.1.2、Flowable 8.0.0、Jackson 3.1.8，并锁定MyBatis 3.6.0以复核其实际内嵌OGNL代码。版本号和编译成功均不等于安全验收完成。

编译测试：在本目录使用JDK21及Maven运行`mvn -B -C verify`。本地构建输出`target/`和依赖缓存不提交。运行候选必须提供隔离配置，不得使用在线企业数据库。

普通启动继续使用校验模式和`databaseSchemaUpdate=false`。数据库升级必须按独立的版本化维护步骤执行；在显式迁移及旧版本实际回退验证完成前，不能把本目录JAR替换到当前系统。

具体范围和验收见[设计](../../docs/superpowers/specs/2026-11-05--workflow-security-maintenance.md)与[实施计划](../../docs/superpowers/plans/2026-11-05--workflow-security-maintenance.md)。当前已完成本机实际构建、打包和6项测试（含配置后的HTTP JSON转换器及21组摘要向量）。完整业务HTTP路由、双企业、撤销、全部依赖及数据库迁移/恢复/回退仍未验收。阶段结果见[构建报告](../../docs/workflow-security-candidate-2026-11-05.md)。
