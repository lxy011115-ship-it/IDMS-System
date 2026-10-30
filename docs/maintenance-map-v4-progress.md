# 工单维修 v4 阶段进展（2026-10-20）

已新增有限依赖的维修写入内核、维护关系初始化、Flowable 可信传输和持久队列 worker。完成已迁移工单本地与引擎两条路径；当前是内核交付，真实 OIDC/HTTP/工单界面与新建工单仍待接线。完整方案A目标保持 ACTIVE。

## 最终证据

| 组别 | 当前源匹配的正式证据 |
| --- | --- |
| 真实 PG + 独立 Flowable，12项 | work/maintenance-map-v4-20261020/3138ddddf4e7/verification.json |
| 已封存 SQL 历史孤儿 HUMAN_REVIEW 拒绝 | work/maintenance-map-v4-20261020/522f64023c09/verification.json |
| 39单位/268构件/类型、保值与清理 | work/maintenance-map-v4-20261020/release/ |

两组正式工具2042、54822实际 exit0，静态73088 exit0，资源全部清理。输入在运行前复制并在结束逐 SHA 验证；Java jar 执行前后 SHA 单独固定，未重新构建或改写原 jar。QA 用真实 PG/Flowable，当前授权是显式受信回调，不是真实 Keycloak 或共享会话集成。

本地完整领取→开始→模板必填/数值范围→提交→拒绝自审/错误证据→退回→重新提交→独立关闭，关闭结果与原 changeWorkOrder 在同业务时间下逐字段一致，告警 RESOLVED/建议 EXECUTED 与审计、回执一起发布。两个实例同 UUID 同内容返回同一结果；两个用户竞争领取只有一个胜者。当前范围、本人任务、租户、维护、主体与角色拒绝均无业务变更。

实际在 PG apply_delta 的最后一个操作注入 expected 哈希冲突，前面工单/审计等变更整体回滚；同业务 UUID 随后可恢复。代理观察实际 apply_delta SQL 后，丢弃成功 COMMIT 回复，再通过新连接的原写回执恢复；另一个 service 实例同键返回一致结果。

Flowable 以独立数据库/进程执行4个明确合成的初始流程和后续6个命令，共10个持久引擎命令。引擎提交后丢 HTTP 回复，原命令重放而不重复引擎或业务审计；发送前和收到真实响应后两处撤权均阻止下一步。响应后实际 SQL 应用回滚保持相同命令、网络失败数0，新实例重放恢复。双 worker 最终只一条业务确认审计与一次引擎终审。7次实际断连接进入 HUMAN_REVIEW，另一审核人重试保留原执行者信封；真实引擎响应被改为错误 commandId 时不推进业务，显式人工重试后原命令恢复。普通用户动作样本最多18逻辑键/9539值字节，非所有 worker 阶段或生产 SLA。

历史检查既拒绝订单标记 PENDING，也对照已封存 legacy SQL 的 workflow_outbox 全行与摘要。独立负例保留8个可用本地工单及1个没有工单的历史 HUMAN_REVIEW，新增初始化拒绝且目标整个 head 不变、maintenance 标记未暴露。PENDING 源本身已被旧迁移门禁拒绝；没有为测试放松门禁。

## 历史与清理

- a1a66a9fbbfc：早期12项全部通过，但还未加入原 SQL 孤儿检查与模板必填扩展，保留作历史，不用于最终源证明。
- f8d8f53bb5d1：模板夹具使用其它 templateKey，原 bindMaintenanceTemplate 只认 maintenance-form，必填负例未触发；修正夹具名称，产品规则不放宽。
- cf886f682fb1：试图迁移 PENDING 孤儿被既有 CORE_GATE_PENDING_WORK 更早拒绝；改为原门禁允许的历史 HUMAN_REVIEW 后，实际验证新增拒绝。

5个自有环境23数据库、83角色按名称/OID/owner/零 backend 精确回收，只读库存0。三个已知独立 QA 引擎退出，私密引擎配置删除；无 FORCE、未知 PG 后台强制终止或递归删除。客户原件、私密配置、引擎原始日志与失败栈不进入发布包。

15:58北京时间原 core28472/owner10320 九服务/原集群与913源保持。观测 ACK69798/pending0/seq69798；同次只读逐条证明恢复后累计11160个新 ACK。pending0是该时刻快照，不代表持续零积压；不声称预中断会话连续性。13个旧发布/保值 checker 全通过。

## 交付与后续

本阶段源码、两组脱敏证明、静态日志及保值证据双份归档到 outputs/maintenance-map-v4-20261020 及当前 chat 的同名 outputs。选定源和根对应文件发布后冻结，record-progress.py 成功后严禁重跑；capture-static.py/capture-preservation.py 会改已归档证据，也不再执行。复核用 check-progress.py 和只读 scripts/verify-maintenance-map-cleanup-v4.mjs。

下一步将当前授权解析器接入既有加密共享会话，并实现工单 HTTP、持久任务调度/退避与界面；补预测/工单创建、新关联原子维护和历史未解决流程待办安全迁移，再与治理/采集/AI/审计整站联调。队列顺序阻塞、跨服务备份恢复、全局资源、历史保留及全站迁移仍未完成。原站点未部署本内核，全部商业目标不按本阶段标完成。
