# 预测与新建工单执行计划

1. 核对旧模型、批准数据/采集回执、业务规则与新根集合/维修关联；保存规格。
2. 新输入冻结、规则服务proof、分析结果规划与原子实体追加；真实服务和PG验证。
3. 持久创建意图、独立复核、真实Flowable回执后原子新建工单与maintenance_link；在既有维修内核完成后续动作，覆盖重放/并发/未知提交/授权修订。
4. 真实会话引用与SQL队列、QI/READER产品HTTP/独立worker及恢复，再接统一站点预测页面；实际PKCE与手机验收。不得用受信回调内核证据代替这一项。
5. 历史保值、原实例只读核验、资源清理、Git管理和记忆；只冻结实际完成的阶段。旧未解决workflow outbox迁移、其余模块/生产容量/恢复/ICP等完整商业目标继续ACTIVE。

## 2026-10-20 内核阶段检查点

第 1–3 项的最终隔离证据为 `8667a1c750c3`，13 组通过；第 4 项仍未实现。当前源码是开发中版本，不冻结，原输入快照保持。第 5 项只保存本阶段 WIP、检查历史保值和清理，不代表商业验收完成。

第 4 项实施时须满足以下依赖顺序：

1. 新独立 SQL namespace/目录绑定、QI 与 APP 最小权限及密文用途/租户/作业/授权 revision 隔离；复用当前实际共享会话解析，不把 SID、Bearer 或服务 token 放进业务计划。补启动密钥 witness 及原密钥轮换待办。
2. 只调度 SQL 领取的具体 SDK 作业，禁止领取 A 后通过 SDK 队首误发送 B。租约需独立线程续租；每次业务 CAS 同事务检查 lease、原人授权 revision 和 deadline。
3. SDK 准备与完成区分：准备持久化计划，完成凭真实 `receipt predictive:<businessKey>`、请求/计划摘要和实际审计把 SQL 作业与业务一起提交。ANALYZE 审计执行者是 RULE，必须另核对 metadata.requestedBy，不能误要求该事件 actorId 等于用户。
4. WAITING_AUTH 不自动从历史 grant 恢复；原人明确重授增加 SQL/SDK revision，旧响应被双重 fence。人工 retry 保留原人及 Flowable 信封，不能替换成审核人身份。
5. 未知接受关闭需持久 tombstone，并与入队竞争验证；真实 Flowable 可能已经创建后不能报告已取消或换新 UUID。外部发送前持久记录发送开始边界，明确可安全取消及必须原命令恢复的状态，覆盖中途崩溃。
6. QI/READER HTTP 不持 APP、Flowable 或预测器材料；公共响应不暴露 SDK 原始计划/授权。随后独立 CLI、真实 Keycloak/共享会话撤权和退出恢复，最后统一站点页面、真实 PKCE、未知接受恢复与三宽度验收。

完整输入重构与候选上限尚在。后续最近测点索引必须覆盖所有写者及迁移闸门，不能用漏掉旧写者的缓存冒充完整事实。容量与整站停写/恢复/原活会话切换另需真实证据。

## SQL 协议基础检查点

第 4 项已推进独立 predictive_jobs_v4 协议、native SDK hook 适配与实际 PG/Flowable 12 组验证（最终 ea0654987fdf），未完成真实身份/HTTP/独立产品 worker/UI。30 秒租约、32 秒主线程阻塞时独立线程续租、native 回执同事务完成及 COMMIT 丢回复恢复通过。当前 SDK 已准备后取消和异人 retry 控制仍需补，不可把受限取消当完整产品功能。详见 docs/predictive-queue-v4-{guide,progress}.md。

同时发现本机 20:15:46 重启；已恢复原 PG 集群并核验原系统及数据库/owner OID，原 4010 尚未恢复。下一步先依据 work/runtime-resume-20261020-r1/NEXT.md 以新版本记录恢复原冻结整站，UI 使用 Cua，不重跑旧成功脚本；再继续本计划第 4 项。完整目标保持。
