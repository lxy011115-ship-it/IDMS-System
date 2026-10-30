# 原工作流服务受控升级

继续完整方案A中原workflow恢复读取接口启用、跨服务恢复和部署待办。原服务为旧jar/4016/PID9124，两个租户各独立38张物理表，当前case/command/execution/history全0；原主核心、身份和采集保持。恢复读取能力先前仅在隔离QA，原服务当前recovery-state实际404。

选择原核心客户端地址/业务serviceToken不变，新建独立私密runtime配置，为两个原租户分别加独立recoveryReadToken和authority UUID；读凭据与业务令牌双向不通用。保留原runtime/client文件和两旧jar不改，原BPMN字节、Flowable7.2.0和业务协议保持。用R2冻结的六项Java/POM/资源离线隔离构建，输出在新work目录，编译类/资源/全部内嵌库与此前验证的恢复jar逐项比较，再测试本次新二进制。

先从原两个workflow库实际只读RR导出快照，38表全行/列/索引/约束/视图/函数/触发器核对。盘点发现act_evt_log_log_nr__seq和act_hi_tsk_log_id__seq两条非MVCC日志序列（当前未调用、cache1）；act_ge_property是另外的引擎ID预留。活库捕获明确标为LIVE_REVIEW_COPY_ONLY：SQL行同导出MVCC快照，序列仅双读观察一致，不能证明持久静默，不具恢复激活资格。正式恢复级备份必须先持久停止所有写入/退役连接，再另立有充分证明的归档版本，不得把双读序列等同完整一致性。

当前隔离测试档案IDMSWFU1明确标为WHOLE_WORKFLOW_DATABASE和LIVE_REVIEW_COPY_ONLY，AES256-GCM/独立key，完整认证和dumpSHA后才允许唯一隔离QA库/最小新角色恢复，恢复全量facts含两序列必须相等，篡改/错key/跨租户拒绝。不冒用旧business-only归档范围；当前restore函数只接收QA目的，不能用于原库回灌或恢复激活。

先在实际恢复的两个QA库启动新jar，比较只读启动造成的所有变化，除已核对的next.dbid预留外不能改变历史定义/业务/资料/列/约束。测试业务身份/恢复身份/跨企业/空清单、正确只读RR、准确模型SHA和定义ID；只在QA库创建4种非空流程，验证原命令幂等、自审拒绝、退回/复测/独立终审和进程重启后的完整快照。原库保持不写合成流程。

隔离验证后，fresh核对原java身份、4016/PG后端和core业务outbox。精确退休旧java、实际连接/后端终态，旧服务退出后再次备份两个静止workflow库并实际隔离恢复。主核心仍可持久接纳业务outbox，服务缺席时按已有命令ID重试，不能丢弃/重新生成命令。新jar用原4016单启动，逐租户核对原业务服务身份、恢复读取、定义/表事实和core/其他依赖保持；新运行后再做两库全量备份恢复。

新父协调器/源配置/二进制/拓扑另行记录和repeatable verifier，旧edge/core verifier要求旧workflowPID，从实际切换后不再适用，不改历史基线。不自动回退或原地恢复旧库覆盖新命令。初始原流程0是真实现状，不能把QA4流程冒称原租户非空恢复；跨服务原子停写/灾备、HA/Linux/OS隔离、容量和完整商业验收继续。
