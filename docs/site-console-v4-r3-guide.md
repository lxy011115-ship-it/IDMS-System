# 统一工作台 r3（WIP）

r3 将原人接管页面接入统一主站的预测模块，保留同源的数据与审计、预测与复核、维修工单及工作台首页。已验收 r2 源文件不改。新入口为 `node scripts/site-console-v4-r3.mjs <explicit-private-runtime.json>`。

入口配置使用 `format:3`、`purpose:SITE_CONSOLE_HTTP_R3`，只允许 `baseSiteRuntimeFile` 和 `predictiveRuntimeFiles`。基站继续提供回环监听和已注册租户的治理、维修运行配置；每个租户恰好一个预测 HTTP 成员，业务 READER 及认证配置、审计绑定、部署摘要、实际认证运行文件必须与对应治理成员一致。

预测成员不能包含 worker 模式、APP 权限或规则/工作流服务材料。加载器核对 QI/READER 数据库边界后，额外探测接管扩展：QI 应能读取和接收接管决定，不能 claim 或 prepare。缺少扩展、权限不符或成员不完整，均在 HTTP READY 前拒绝。使用 fresh predictiveJobsSchemaSqlV4R2 目标，不在线修改原活动库。

长期运行的认证状态、provider 和会话清扫器由基站持有；预测成员的临时认证实例验证后关闭。三个模块及接管端点复用同一当前服务端身份。路由先核对 tenant/actor 头，再选择已注册的租户成员，接管后台继续执行本人、范围、CSRF、原生结果与控制编号规则。

预测页面沿用已验证的接管 r2 UI。worker 单独使用 `scripts/predictive-console-adoption-ui-v4-r2.mjs` 的 WORKER 配置，其 APP/规则/Flowable 材料不进入统一 HTTP。没有为旧任务启动裸 SDK 队首 worker。人工重试仍需独立审核，再由原操作人明确重新授权。

本修订不自动切换原站点或云端，也不完成旧 workflow outbox 迁移、外部创建不明且已取消任务的人工对账、密钥轮换及其他商业待办。实际验收结果应以后续 validation 和进展记录为准。面向终端用户的最终图文说明与演示视频按 idms-user-delivery-plan.md 后置制作。
