# 原工作流升级的隔离准备与范围

2026-10-19，原workflow仍是旧jar/PID9124/4016，两个原租户各38表、0流程、0命令，恢复读取路由仍404。本轮只做隔离准备，没有启用原恢复读取凭据或停止原服务。

从R2冻结的六项Java/POM/资源做离线隔离构建，输出 `work/workflow-runtime-upgrade-20261018/build-output/idms-workflow-0.1.0.jar`；原target下两个旧jar保持。新jar全部100项编译类、资源及内嵌库与先前验证的恢复jar相同，整体SHA为 `115b0e132795e783f156365722d5518ed5a5ed4640f1999fff59c444f12a31d7`。这是本次隔离构建结果，不是完整安装包。

原两个workflow库实际只读导出MVCC快照，38表全行/列/索引/约束/视图/函数/触发器和两日志序列全量比较，在唯一QA库/最小新角色实际恢复。测试副本用独立key/AES-256-GCM，完整认证及dumpSHA通过后才连接恢复目标，篡改/错误key/跨租户拒绝。没有原地恢复或往原库写合成流程。

**这些活库副本仅用于隔离测试，不是正式恢复备份。** 两条SQL序列 `act_evt_log_log_nr__seq`、`act_hi_tsk_log_id__seq` 不受MVCC保护；双读观察一致不能证明持久停写。档案明确 `purpose=LIVE_REVIEW_COPY_ONLY`、`persistentWriterQuiescenceProven=false`、`eligibleForRecoveryActivation=false`，当前restore函数也仅允许唯一QA目的。后续正式备份必须有持久写入围栏、原生连接真实退役和准确恢复准入，不能修改这些旧副本的标签来冒充已证明静默。

本次新二进制在两个实际恢复库启动，全部历史行/结构保持，next.dbid增量实际为0；业务和reader凭据双向拒绝、跨企业读取拒绝、额外查询参数拒绝。QA创建4种状态、3活动/1关闭流程、15个已提交命令；自审拒绝、独立终审、退回修复、精确幂等重放/冲突拒绝，以及真实进程重启后的完整非空恢复快照一致通过。QA Java/库/角色实际关闭删除，临时凭据文件移除；受限加密副本及独立key保留，不公开。

下一阶段先在隔离库验证持久停写/中断恢复/权限还原，再对原旧服务做受控退休和正式归档。原业务serviceToken、core客户端地址、BPMN及原配置文件应保持；新独立私密配置只增加每租户reader和authority。必须另立新拓扑verifier；当前edge verifier仍要求原workflow9124，原服务切换后不能静默改该历史基线。主核心和当前采集不随之重启，原两长期协调器继续运行。

本轮不构成原workflow部署、跨服务原子恢复或商用验收。原完整方案A继续包括现场材料/commissioning、跨服务灾备/HA、安全/OS隔离/Linux、容量、RUL/SaaS商业化。
