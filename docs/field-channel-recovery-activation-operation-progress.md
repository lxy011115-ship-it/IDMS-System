# 恢复正式激活与中断恢复进度

新增正式独立命令 `node scripts/field-activate.mjs --action activate|recover`，强制完整私密配置、确切操作/attempt/plan、实际材料检查和attempt-v2。激活另需当前APPROVED事实摘要。当前独立批准者的OIDC身份/角色/完整范围、当前作者和完整Flowable在写publication前复查，SQL准备和原生发布后再次检查。使用方式见[操作说明](field-activation-operation-guide.md)。

新authorize、resolution和coordinator模块分别负责当前授权、真实提交状态解析和唯一提交顺序。专用只读resolution上下文重认证整个GCM归档、原操作/恢复/审批、实际数据库及四角色OID，识别实际APPROVED/FROZEN或ACTIVATED/RUNTIME。旧committed-only读取仍严格ACTIVE/released，普通resume仍拒绝未知ACTIVE。源PS原子助手未改。

提交前异常先关闭并等待原SQL连接，再在新上下文核验实际状态。只有精确原APPROVED/FROZEN、完整事实和审批祖先、当前授权及无未知连接时才同attempt重装原marker并CAS RESTORING；旧材料能力和immutable attempt不续期覆盖，明确要求下一次激活用新UUID。实际ACTIVATED/RUNTIME仅验证或补写固定回执，不重复注册/审计/根，不回退RESTORING；当前授权和当前业务对应的完整Flowable检查在返回旧回执前执行。

最终隔离运行包含完整非空归档/源库不可连/新目标恢复、4种工单和15真实outbox命令、真实OIDC/Flowable及UA/双角色mTLS。正式CLI拒绝作者/外企业主体和错误facts，publication之前不写新意图；无效材料导致实际准备失败后自动确认FROZEN并保留RESTORING。实际控制者在原生ACTIVE发布后、最终COMMIT之前被终止，确认PG backend终态和全部表/根/审计/sequence回滚。作者撤权时recover拒绝且保留ACTIVE/FROZEN窗口；恢复权限后核验完整事实/祖先再重装围栏，重复不写SQL。

随后新attempt通过正式命令激活，QA网络代理实际匹配启动身份及激活COMMIT请求，收到服务器真正COMMIT CommandComplete后不转发并截断连接。生产协调器没有测试hook，以新连接验证实际已提交状态，补写并返回回执。唯一注册观察/激活审计/root/seq/角色/ACTIVATED共同提交，32其他关系及非空点/回执保持。实际新app连接执行正常领域模板命令后，当前授权recover仍返回初始固定回执，不重复审计或根写入。实际旧v1降级拒绝；作者撤权优先于损坏幂等回执，恢复权限后损坏回执仍保留拒绝；重复activate返回同一结果；外部Flowable真实推进后recover拒绝，SQL和ACTIVE文件保持。

496单元测试、262运行构件/全脚本语法/类型通过。最初全套中一个旧租约测试的准备耗时超过100毫秒预留，触发正确生产时间检查；两个相关测试改为在同一固定模拟时钟下建立策略/注册和请求，保留边界断言及生产代码，定向和完整回归通过。原控制与8个原生/COMMIT故障顺序回归通过，所有自有资源终态确认；68个此前跟踪构件保持，6个明确扩展。原系统运行/数据/角色、431旧源码、66契约和十轮双份冻结复核通过。

本轮验证正式CLI和真实线缆COMMIT丢回复，不含浏览器操作激活。此前浏览器独立审批/外态漂移证据保留。真实激活后UA/mTLS/SQLite/PG新流与旧check/lease/event/ACK失效、离线CLI/冻结证据及受控部署仍待完成，原正式FIELD未部署，无新最终快照。这不是生产commissioning；跨服务引擎灾备、大库、跨宿主/Linux、OS隔离/认证外部防回滚等完整商业范围继续，目标ACTIVE。

公开本文和JSON在项目与聊天outputs保持相同副本，不含私密配置、token、密钥、备份、SQL或原始日志。
