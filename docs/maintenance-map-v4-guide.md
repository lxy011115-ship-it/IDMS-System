# 工单维修增量内核 v4

本阶段提供已迁移工单的按键写入内核、Flowable 持久待发命令与恢复 worker。它尚未挂接现有 OIDC/共享会话、HTTP、工单页面或原运行站点。当前功能必须由受信宿主调用，禁止将 generic map API 或未经认证的 context 接到公网。

## 初始化与普通命令

在已经完整迁移、旧源持久停写并激活采集/读目录的目标上，由受信维护代码调用 `activateMaintenanceMapV4(account,binding)`。初始化器核对迁移 seal/原 SQL workflow_outbox 行摘要及所有工单，拒绝未解决的历史 PENDING/HUMAN_REVIEW，包括没有工单的孤儿待办。原迁移门禁也会提前拒绝仍 PENDING 或活租约；新检查补足历史人工处理状态。

初始化完整验证企业 payload，安装工单→告警/原规则第一个维护建议的稳定关联，逐项读回并重新重构核对后才暴露标记。这是维护操作；普通动作只读当前工单、当前资产范围、固定相关实体和审计尾。未来新增预测/工单写者必须原子维护关联；当前尚未实现新工单创建及旧待办迁移。

`MaintenanceMapV4.execute({id,action,input},idempotencyUuid,currentContext)` 支持 claim/start/submit/approval/workflow/retry；`get(id,currentContext)` 按当前范围读取单工单。仅真实 OIDC 用户和角色派生权限，范围从受信 context 传入；请求不能注入身份、流程状态或其它字段。领取/版本/负责人、维修分钟及字段、冻结模板与证据摘要、退回后重新提交、独立终审全部复用旧 changeWorkOrder。

本地历史工单继续本地状态机。状态、版本、冻结证据、关联告警与建议、旧格式审计和业务幂等回执在同 CAS 发布；并发冲突重取根，未知 COMMIT 按原底层命令证明恢复。同一用户 UUID 不能换内容；重放仍先检查当前租户/范围/权限，再返回原回执。当前维护围栏和挂起租户均阻止写入。

## Flowable 工单

为 map 配置固定 `workflowBinding`，并用相同固定私密配置构造 `MaintenanceWorkflowTransportV4`。Flowable 工单无服务配置或未同步时禁止本地推进。入队只把 workflow 标为 PENDING，业务版本/状态不前进；提议业务内容、beforeDigest、原角色/范围证据、commandId/requestDigest 和持久队列序号同 CAS 保存。服务 token 不入映射。

worker 必须提供 `resolveCurrent(job)`：由当前认证/身份源重新解析原执行者。job.context 只作历史证据，不能作为当前授权的回退值。本阶段 QA 是可信上下文回调，尚未证明真实 OIDC/共享会话撤销接线。worker 在发送前检查当前权限、范围、租户和围栏，收到回执后重新取得当前授权并再次核对，再原子发布业务状态、关联关闭、确认审计和 job SYNCED。

传输配置不接受请求指定目标；远程要求 HTTPS，loopback 可 HTTP，禁止 URL 凭据/查询参数/重定向。8秒单次网络超时和256000字节响应限额沿用既有边界。回执绑定整个不可变信封、配置指纹、版本/状态/实体和流程身份；内存品牌不能由 JSON 伪造。引擎与本地均幂等，多个 worker 可以重发同一命令，**不声称网络恰好一次或数据库租约**。

7次实际网络/临时服务失败进入 HUMAN_REVIEW；明确拒绝或错误回执直接人工处理。有效响应后的本地存储错误保持 PENDING，不消耗网络失败次数。人工重试由当前有审核权限的人发起，保留原 commandId、信封和执行者，重置失败预算，追加队列位置并审计。原执行者仍须当前授权，重试不替换其责任身份。

队列按持久序号处理，一条暂时失败可能阻塞后续。宿主仍需接入持久调度/退避、全局资源限制与完整服务生命周期；本内核不提供生产 CLI。PENDING 入队、SYNCED 应用与队列 ACK 分离，后两步中断后可由新实例读状态继续，不重复业务推进。

## 验证与限制

正式验证使用独立 PostgreSQL、真实独立 Flowable 进程及真实 HTTP/SQL 丢回复。模板必填/范围、独立审核、同键/并发、当前撤权、SQL中途回滚、7次断连接、人工重试、错误回执、两个 worker 及完整重构/审计链通过。当前最多18键/9539值字节是这些**用户动作调用**的单次观测，不包含全初始化或所有 worker 阶段，也不是吞吐或 SLA。

当前只实现已迁移工单的内核。HTTP/界面、会话持久授权解析、新建工单/预测分析、历史未解决 outbox 转移、完整跨库恢复、全站切换及全部商业验收继续。已发布冻结源不改，原913源与原服务保持。精确证据见 maintenance-map-v4-progress.md。
