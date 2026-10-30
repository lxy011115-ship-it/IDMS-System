# 恢复激活提交前权限与原生文件恢复进度

完整方案A现场恢复第6项继续。新增事务内权限准备模块：实际bootstrap主体和已开启事务、完整FROZEN策略先核对，再恢复精确编译RUNTIME表/序列权限、应用/迁移LOGIN及迁移对owner的显式SET权限。复用基础与FIELD安全校验器；owner保持NOLOGIN，backup只读，不自行COMMIT。

新增不可变publication文件记录，绑定同宿主/集群/路径的真实原恢复操作、独立批准阶段/plan、配置和注册SHA及确定的RESTORING/ACTIVE正文。Windows原生WRITE_THROUGH辅助进程在原authority锁和所有者身份围栏下CAS发布ACTIVE，再移动精确原标记至同attempt的released记录。原恢复意图和已保存restore/review结果不改。

独立真实PostgreSQL权限QA验证：未提交时新应用/迁移连接实际拒绝，已有连接的UPDATE/序列/SET ROLE仍拒绝，观察者仍见FROZEN；显式回滚和真实终止控制进程均恢复原策略。另一真实COMMIT故意不发成功应答，提交后新账号才可连接并通过原编译安全校验，backup仍只读，全部业务/现场表与审计序列保持。该COMMIT仅用于隔离权限探针，没有正式注册和激活审计。

正式归档/源不可连接/新目标恢复、非空4工单15条真实outbox、Keycloak和独立Flowable、CLI及Chrome审批组合通过。publication使用实际已批准plan-v2和完整恢复祖先链；文件ACTIVE且marker确已释放时，普通加载器可读取新身份，但真实应用/迁移连接仍拒绝，其他连接仍见APPROVED和FROZEN，表/root/audit/seq不变。控制者被真实终止且SQL后端确认关闭后，再取原authority锁，实际核对仍为原APPROVED和FROZEN，原生重装本attempt原标记并CAS恢复RESTORING；完整归档、祖先链和所有事实再次匹配。

未知activation文件、损坏publication记录均拒绝且保留。实测原生替换前控制竞争变化导致CAS拒绝、不覆盖异常，已装回marker保持关闭；仅QA显式还原自有注入后，同attempt继续恢复。普通resume对未知ACTIVE的拒绝保持。完整组合之后真实浏览器独立审批仍通过，实际外部工作流推进后新恢复计划提交继续拒绝且目标不变。

489单元（新增2个publication schema/路径安全测试）、262运行构件和脚本语法/类型通过；原恢复控制及原8个真实COMMIT/原生文件窗口故障场景回归通过，全部自有进程/原生辅助进程和资源终态确认。39个此前跟踪构件保持，文件helper/清单/QA及设计计划5个明确扩展。原431旧运行源码/两原jar、原业务/imports/5迁移/审计前缀、角色和无FIELD、新运行基线、66契约与十轮双份冻结保持。

本阶段完成底层提交准备和提交前窗口验证。正式新FIELD_REGISTRY_OBSERVED、唯一激活审计/root/ACTIVATED同COMMIT、最终当前身份/流程/策略/实际TLS材料核验、提交后结果恢复以及真实新流全链尚未接入；没有正式activate命令，FIELD未部署。文件rearm原语本身不判断SQL提交状态，未来正式协调器必须先证明原APPROVED/FROZEN；ACTIVATED后不得回退。独立权限COMMIT测试和原生文件测试不能冒称完整激活验收。

见[底层接口与限制](field-activation-publication-guide.md)和2026-10-18恢复激活设计/计划。跨服务引擎数据库灾备、大库、跨宿主/Linux/TLS、认证日志外部防回滚和操作系统隔离等商用工作继续。完整目标ACTIVE，无新最终冻结快照。公开本文/JSON双份相同，不含私密配置、token、密钥、备份、SQL或原始日志。
