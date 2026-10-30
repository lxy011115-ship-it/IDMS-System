# 工作流持久停写围栏：隔离验证完成

新增显式控制模块和CLI。独立控制库、NOLOGIN owner和受限权限，准确绑定cluster/数据库/角色OID及原属性。一个事务提交应用角色NOLOGIN、DB连接上限0和FENCED记录；原有连接继续存在时不宣称停写完成，必须按pid/backend_start/datID/roleID真实退休后确认DRAINED。释放原子还原原LOGIN和连接上限，ACL/密码/数据保持，拒绝漂移和已释放操作重开。

最终控制模块在三轮独立的38表实际恢复QA目标通过，每轮8个真实控制子进程中断点，确认对应PG后台连接实际消失后fresh同ID继续。提交前后catalog和控制行原子性、旧长事务回滚、已消费的非MVCC序列值不回退、新普通连接拒绝、精确释放后写/nextval恢复均通过。并发控制锁、未知会话、权限和catalog漂移拒绝；末轮还实际删除并同名重建QA库，旧OID操作被拒绝。公开CLI的prepare/freeze/status/release及重放、错误参数实际通过。

实际复现事务内活动视图的旧快照问题，已主动pg_stat_clear_snapshot，并在DRAINED提交后再次核对；最终三轮均通过。中间测试曾超时/遇到保守会话拒绝，未放宽身份门槛来通过。未注入网络COMMIT回复丢失，不将真实进程退出替代该覆盖声明。

所有自有控制进程、QA数据库/角色/临时私密凭据已清理。原workflow9124/4016仍未部署、未冻结；两个原38表全量行/结构/两序列、原OID/LOGIN/connlimit、配置/serviceToken及两旧jar保持，原资料/imports/五迁移/角色和66契约/旧十轮/R1/R2通过。268构件/全脚本/类型检查通过，业务单元源码未变，本轮没有冒称重跑509单元。

指南见[workflow-persistent-fence-guide.md](workflow-persistent-fence-guide.md)。9项源码及公开证据双份SHA一致，仅审阅副本，不是完整安装包。围栏限制应用写入，superuser运维仍属信任边界。

本阶段没有正式工作流归档。下一步将受控只读管理会话、原生dump和两条非MVCC序列准确绑定当前持久围栏，验证中断/恢复及真实隔离还原，再原Java受控升级。先前LIVE_REVIEW_COPY_ONLY不具恢复激活资格，不改旧标签。完整方案A、采集排空/容量和其他商业范围继续ACTIVE。
