# 已取消预测建单的领域对账

本阶段提供可信服务端 SDK 和显式安装的流程锁定扩展，供后续持久作业与网页接入。原运行环境尚未安装本扩展。本文是开发与部署说明，最终用户图文手册和演示视频仍按 `idms-user-delivery-plan.md` 在整体验收后制作。

## 处理方式

原预测复核作业已取消时，外部流程仍可能在取消前创建成功。对账保留原作业、计划、取消回执和审计，另外记录事实和处理结果。

1. 原操作人用当前加密 OIDC 会话打开对账，固定原取消证据，并为原告警持有独立意图，阻止新复核抢先建单。
2. 服务端向外部流程申请持久核对和锁定。`BLOCKED` 表示原创建已被持久阻止；`HELD` 表示原初始流程已锁定；`ADVANCED` 表示流程已进入后续状态，必须人工处理。
3. 另一位当前有批准权限、且在设备范围内的用户复核固定证据。原操作人在该复核后重新登录，明确确认。
4. `BLOCKED` 单独记为已解决，无新业务工单。`HELD` 且当前业务证据一致时，原子关联原计划工单、告警、建议、维修索引和双方审计，进入 `RELEASE_PENDING`。
5. 使用原业务发布回执摘要释放外部锁，再记录 `RESOLVED_LINKED`。该操作不重写维修工单，避免覆盖期间已经排队的领单或维修命令。

原业务发生变化、已有其他意图或外部流程已推进时，记录 `NEEDS_ATTENTION` 并保留事实。不得删除这些异常记录来表示已完成。

## 接口与授权

`PredictiveCancelReconciliationV1` 提供 `activate`、`candidate`、`open`、`read`、`observe`、`review`、`confirm`、`settle`。除显式部署激活外，业务操作都需要 `PredictiveReconciliationAuthV1` 产生的会话授权。身份、角色、设备范围和有效期来自实时验证器及 PostgreSQL 加密会话存储。客户端不能通过请求中的角色、人员编号或旧访问上下文代替当前授权。

每个写动作使用固定动作编号、预期版本和请求摘要。未知成功回复必须按原编号恢复；换编号不能用来绕过冲突。新的观察或复核会使旧确认失效。独立复核人的原会话失效后，需要重新复核，随后原操作人再次以新会话确认。

`hooks.commit` 仅供后续可信作业执行器桥接原子提交。当前没有业务 HTTP 路由、持久队列受理或网页入口；HTTP 进程不应取得领域 APP 或外部流程凭据。

## 外部流程扩展

新增 `CancelReservationControllerV1`、`idms_workflow_reservation_v1` 的一张持久表、六个函数及三个触发器。扩展依赖上一层取消核对协议。安装时使用既有 schema helper，在受控迁移事务内显式运行；服务启动不自动执行 DDL。

只有设置 `IDMS_WORKFLOW_CANCEL_RESERVATION_CONFIG` 才启用。配置必须与 `IDMS_WORKFLOW_CANCEL_CONFIG` 的同租户 JDBC、用户、专属凭据、authority 和实际目录身份一致，且与原正常流程服务的用户和 token 区分。额外的目录摘要涵盖锁定触发器、函数定义、权限、索引、约束和表结构。每次操作前后检查目录；守卫被禁用时拒绝继续。

预留、正常流程命令与释放使用同一实体事务锁。持有期间原控制器的领取、维修及审核更新触发 SQL 拒绝，并回滚整个 Flowable 事务。原维修执行器可能收到 HTTP 500 并保留重试，不能据此认定外部变更成功。

新增接口为 POST `/v1/cancel-reservations/{controlId}/reserve`、POST `.../release` 和 GET `/v1/cancel-reservations/{controlId}`。释放需要固定 `domainReceiptDigest`，重复相同摘要可恢复，改变摘要会冲突。GET 404 不构成安全取消证明。

## 构建和验证

`node scripts/build-workflow-cancel-reservation-v1.mjs` 在新的隔离工作目录构建十二项 Java/POM/SQL 输入，保留原服务 target jar。不要用旧 workflow setup 覆盖仍在运行的构件。

`node scripts/verify-predictive-cancel-v1.mjs <隔离构建的verification.json>` 创建自有业务库、领域库、加密会话库、两租户流程库和 Keycloak realm，使用真实已批准测量、真实流程引擎及当前会话。测试使用后端 direct grant 创建会话，不等同于浏览器 PKCE 登录验证。保值源码清单已版本化为 `scripts/fixtures/predictive-cancel-preserved-v1.json`。

`node scripts/verify-predictive-cancel-cleanup-v1.mjs` 只读检查本测试家族的精确名称和 OID、清理证明、私密运行文件及 realm。它不终止连接或进程，也不会删除资源。

正式部署仍需兼容新增表的归档、恢复与目录准入，收敛既有流程角色和数据库所有权，并完成持久业务作业、CSRF、部署绑定、统一网页及浏览器异常测试。主站切换、域名公网开放和最终用户交付仍按原总计划推进。
