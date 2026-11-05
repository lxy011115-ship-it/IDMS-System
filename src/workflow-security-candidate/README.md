# IDMS工作流开源迁移候选

本目录是用户已批准的工作流安全维护路线A的独立代码目录，由GitHub维护。原`services/workflow`及其运行JAR保持不变。

候选使用Spring Boot 4.1.2、Flowable 8.0.0、Jackson 3.1.8、MyBatis 3.6.0及Logback 1.6.6。统一连接池校验数据库URL、证书文件和登录等待；适配源码的NOTICE与许可证随JAR打包。版本号和编译成功均不等于安全验收完成。

编译测试：在本目录使用JDK21及Maven运行`mvn -B -C verify`。本地构建输出`target/`和依赖缓存不提交。运行候选必须提供隔离配置，不得使用在线企业数据库。

普通启动继续使用校验模式和`databaseSchemaUpdate=false`。显式initialize只接受空结构，已有库必须使用[独立维护工具](maintenance/README.md)。当前系统换版仍受完整平台准入约束。

[新版真实主站联合恢复](../../docs/workflow8-main-joint-recovery-2026-11-05.md)已在另一个隔离场景完成真实登录、建单投递、丢失回执后的351表检查点还原、原命令对账和独立维修终审；原HTTP及引擎回执重放一致。原运行未换版，AI/采集/撤销协调及完整平台验收仍待。

[此前的主站客户端兼容补验](../../docs/main-flowable8-adapter-validation-2026-11-05.md)覆盖实际双企业状态、原工单详情、两套Node客户端的历史命令重放和十二项负例；357张表事实不变。该次后台仅为空队列轮询，其未覆盖的真实登录、新投递及待确认恢复已由上方另一隔离场景补验。

具体范围见[设计](../../docs/superpowers/specs/2026-11-05--workflow-security-maintenance.md)与[实施计划](../../docs/superpowers/plans/2026-11-05--workflow-security-maintenance.md)。已完成实际引擎兼容修复、双企业显式迁移、九类路由、升级后恢复及原JAR档案回退，见[迁移验证记录](../../docs/workflow-security-upgrade-and-recovery-2026-11-05.md)。随后完成[维护者公告与连接防护](../../docs/workflow-maintainer-review-2026-11-05.md)：19项测试在Windows通过18项、1项Linux专项由Linux CI执行，最终包另完成双企业九路由重放及357表对照。一项上游无补丁的pgJDBC问题、完整平台恢复与生产配置继续保留门禁。[首批构建报告](../../docs/workflow-security-candidate-2026-11-05.md)保留历史结果。
