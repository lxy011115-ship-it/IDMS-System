# 预测控制台后台接线

预测 HTTP 和 worker 使用独立私密配置，通过 `node scripts/predictive-console-auth-v4.mjs <config-file>` 启动。此入口仍为开发中模块，不替换当前运行的原站点。

`mode=HTTP` 仅持排队 QI、业务 READER 和真实 OIDC/加密共享会话配置；拒绝 APP 写权限、预测器和 Flowable 材料。`mode=WORKER` 使用 APP、固定预测器与 Flowable 以及公开来源策略。启动核验数据库/角色 OID、目录摘要、角色执行权限、独立认证库和认证审计绑定。失败输出固定错误码，不输出私密配置。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/v4/predictive/context` | 当前企业、维护阶段、权限 |
| POST | `/api/v4/predictive/jobs` | 提交 `{commandId,command}`，command 为 ANALYZE 或 REVIEW |
| GET | `/api/v4/predictive/commands/:commandId` | 本人原 UUID 的接受/执行状态 |
| GET | `/api/v4/predictive/jobs/:id` | 本人任务及原生回执证明的完成结果 |
| POST | `/api/v4/predictive/jobs/:id/authorize` | 本人当前会话明确重授，正文 `{}` |

请求使用当前身份匹配的 `X-Tenant-Id`，可附加同人 `X-IDMS-Actor-Id`。会话写请求继续要求既有 Origin 和 CSRF 校验。请求头不能授予身份或角色。每次入队、读取和重授重新核对当前企业与设备范围。服务端读取根有 256 键/16MiB 证明预算；普通分析的完整图重构和候选上限仍存在，不能把此接线当成容量优化完成。

同一原人和 UUID 的同内容请求复用原作业；变更内容冲突。未确认接受时查询原 UUID，不能凭客户端超时改新 UUID。HTTP 返回的 `acceptance` 区分 NOT_ENQUEUED、UNKNOWN 和已知 ACCEPTED；目前尚未接产品层的持久接受关闭入口。

worker 仅执行 SQL 实际领取的指定作业，不调用 SDK 队首选择。独立线程续租；每次写入重新解析真实共享会话、核对期限与 SQL lease/fence。`predictive_host` 随 SDK 事务保存该 SQL 作业/原人/UUID/授权修订，不保存 SID。旧宿主没有该绑定的 SDK 作业不自动接管，迁移流程仍待实现。

外部调用前、实际响应后和最终提交前检查当前授权。创建流程在发送前落 `external_started`，保持原不可变 Flowable 信封。正常完成通过同一事务写业务、原生 SDK 回执、审计和 SQL COMMITTED；HTTP 再独立核对回执及审计后展示结果。ANALYZE 的 RULE 审计通过 `metadata.requestedBy` 核验原申请人。

WAITING_AUTH 不凭恢复角色自动复活；原人必须重授。新 SQL 修订会推动 SDK 新修订并拒绝迟到旧 writer。SDK 尚未准备时的输入/状态错误通过 Worker 专用 `reject_unprepared_v4` 持久拒绝；SQL 独立禁止将已有 SDK 或外部发送事实的作业当成未准备拒绝。

后续仍需 SDK 已准备后的安全取消、独立人工 retry 控制、真正丢接受回复/关闭竞态的完整产品入口、设备/告警/证据列表与详情、统一站点页面和实际浏览器 PKCE/手机验收。队列密钥启动 witness/完整轮换和商业容量/恢复待办继续。本阶段使用真实 Keycloak token 与共享会话的隔离验证夹具，不能冒充浏览器回调或现场设备预测有效性。

后续任务控制已推进，准备后的取消、独立人工 retry 与持久关闭详见 [控制接口说明](predictive-controls-v4-guide.md) 和 [当前验证进度](predictive-controls-v4-progress.md)。原有本阶段局限应按此后续阶段更新读取；预测界面/浏览器验收仍待完成。
