# 取消建单对账的持久作业接口

本阶段在已有领域对账 SDK 之上增加显式队列、可信执行器及独立 HTTP 适配器。统一站点配置、网页入口、正式安装与浏览器验收仍待接入。原站点和云端运行环境未切换。

## 进程职责

HTTP 适配器 `PredictiveCancelJobHttpV1` 使用 QI、READER、现有实时 OIDC 验证器、加密会话和作业加密材料；不接收 APP 或外部流程凭据。`PredictiveCancelJobWorkerV1` 使用 APP、当前共享会话验证能力及专属外部流程配置，在独立线程持续更新数据库租约。

HTTP 持久受理与领域业务提交是两个状态。`ACCEPTED` 表示已保存请求；`RUNNING` 表示正在执行；`WAITING_AUTH` 需要当前用户重新授权；`RETRY` 表示按原编号恢复；`FAILED` 保存明确错误；只有 `COMMITTED` 表示该动作的领域结果与作业完成已在同一事务提交。

动作的 caseId、operationId、类型、请求摘要与部署均不可重绑。原作业取消记录、原计划和取消回执不会改为已提交；另存独立对账及审计。独立复核的加密会话引用与该复核结果在同一事务保存，后续确认必须使用同一复核对应的当前有效会话，客户端不能提供他人的身份或角色。

## HTTP 协议

所有接口使用当前会话，检查租户头与设备范围。写接口同时执行既有 Origin/CSRF 检查。JSON 正文上限 8192 字节，不接受多余字段。

| 请求 | 用途 |
| --- | --- |
| GET `/api/v4/reconciliation/candidates/{commandId}` | 原操作人读取原取消作业及计划摘要 |
| GET `/api/v4/reconciliation/cases/{caseId}` | 范围内审批者读取对账及证据 |
| POST `/api/v4/reconciliation/actions` | 持久受理一个固定编号动作，返回 202 和作业 |
| GET `/api/v4/reconciliation/cases/{caseId}/actions/{operationId}` | 操作人查询自己的原动作 |
| POST `.../actions/{operationId}/close` | 关闭未知受理编号，拒绝之后到来的迟到受理 |
| POST `.../actions/{operationId}/authorize` | 使用固定授权编号更新待处理动作的当前会话 |

受理正文为 `{action, caseId, request}`。action 为 `OPEN`、`OBSERVE`、`REVIEW`、`CONFIRM`、`SETTLE`，request 使用领域协议的严格字段。OPEN 的 id 必须等于 caseId；其余动作使用明确的 operationId 和 expectedRevision。REVIEW 与 CONFIRM 还需固定 evidenceDigest 和说明。

关闭未知受理时发送同一原始动作正文。若尚未受理，持久围栏阻止迟到请求；若已受理，返回原作业并设置 `recoveryRequired`，不能当作业务操作已经撤销。

重新授权正文为 `{authorizationId, expectedGrantRevision}`，均须在发出请求前保留。相同授权编号、会话和预期代数可安全恢复，不重复推进代数；换会话或换请求沿用该编号会冲突。新授权的业务意图仍是原 case/action，不生成新的业务动作。授权提交丢回执时沿用同一控制编号重新核对，不能只依据“目前代数相同”推定原授权已提交。

网页后续接入时只保存恢复所需的编号与版本元数据，不在浏览器存储授权材料、会话原文或业务正文。

## 释放的授权边界

业务关联后处于 `RELEASE_PENDING`，外部 hold 仍有效。释放意图开始之前，原操作人与独立复核人的当前权限、会话和证据均需有效；撤权时保留 hold 和待办，可重新复核及再次确认。新复核会使旧的待授权确认/释放动作明确变为 `RECON_QUEUE_REVIEW_SUPERSEDED`。

SETTLE 在当前 case 租约内持久记录固定 case 快照、发布回执摘要与双方授权见证，此时才是“释放已开始”。之后不接纳新的复核、观察或确认；已排队的后续复核在释放完成后明确失败，不悬挂为可执行的旧批准。

释放已开始后，退出登录、网络断开或租约到期不能撤回可能已送出的外部动作。新执行器仅按原意图、原流程信封与固定发布摘要恢复实际外部释放结果，再记录 `SYSTEM` 恢复审计。它不能重新发布业务工单或覆盖维修状态，也不冒用已退出用户的当前权限。释放开始前撤权与开始后恢复有不同的授权语义，网页必须清晰展示。

## 安装、验证与后续

`predictiveCancelJobsSchemaSqlV1` 仅用于受控的新部署安装。新命名空间 `reconciliation_jobs_v1` 的 QI 只能受理、查询本人动作、编号关闭和授权；不能读表、读取领域状态、领取、释放或发布。可信执行器的发布桥接核租约、有效期、领域 CAS 回执和审计，将领域状态与队列完成一同提交。新业务作业、围栏、授权和释放意图表的直接写入、删除和清空受守卫限制，私有事务上下文表不给运行账号表权限，目录与 DDL 代数不符即拒绝运行，不在运行时重定基线。

SQL 协议验证：`node scripts/verify-predictive-cancel-queue-v1.mjs`。它使用单独命名空间的一库四角色，测试事务、权限、租约、围栏与恢复；其中授权材料是明确标记的 SQL 协议夹具，不能替代实际 OIDC 和业务证明。

真实会话/HTTP/流程验证：`node scripts/verify-predictive-cancel-jobs-v1.mjs <隔离流程构建verification.json>`。它使用已批准测量数据、原生取消、真实 Keycloak、加密会话、HTTP、两个租户的实际 Flowable 引擎及新的任务执行器。登录由后端 direct grant 测试夹具产生，不等同于浏览器 PKCE。保值清单已版本化，无须读取旧私密验证报告来取得源码摘要。

清理核验：`node scripts/verify-predictive-cancel-jobs-cleanup-v1.mjs`。该命令只读检查本测试家族的精确名称/OID、清理记录、私密运行文件与 realm，不删除资源或终止连接。

正式部署仍需新统一站点版本及严格运行配置准入、归档恢复兼容、旧流程权限收敛、实际浏览器全程验证和原总目标的部署检查。最终用户图文手册与实际演示视频按同一整体验收版本另行交付。
