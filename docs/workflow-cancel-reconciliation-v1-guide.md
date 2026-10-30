# 取消建单的流程服务对账边界 v1

这是人工对账的流程服务基础协议，尚未接入终端用户网页，不是完整的人工业务审批。原生 CANCELLED 不证明外部从未创建。CREATED 仅证明原信封已在外部创建，不能据此修改原取消历史；BLOCKED 仅由持久阻断事务产生，普通查询 404 不等于安全取消。

## 使用顺序与配置

先在已安排维护和备份的目标明确安装 `scripts/workflow-cancel-schema-v1.mjs` 生成的 SQL，再用专属 reconciler 角色读取 `workflowCancelCatalogV1` 的数据库 OID、角色 OID和目录摘要。所有者为独立 NOLOGIN 角色，reconciler 仅有 schema USAGE 和两个函数 EXECUTE，不可直接操作账本或原流程表。

通过 `scripts/build-workflow-cancel-v1.mjs` 将九项源/POM/资源复制到独立 work 构建目录并离线构建。旧 `services/workflow/target` jar 不被覆盖。新 jar 只有显式设置 `IDMS_WORKFLOW_CANCEL_CONFIG` 才开启路由；未设置时无额外数据库迁移或对账连接，路由返回 404。现有 `IDMS_WORKFLOW_CONFIG` 和旧命令服务 token 不变。

私密配置为 format 1、tenants 映射，每个租户包含 jdbcUrl、user、password、token、authorityId、databaseOid、roleOid、catalogHash。token 必须与常规流程服务 token 分开配置，角色也必须独立；配置的 JDBC 目标必须与原工作流同租户目标一致，启动时会拒绝不一致或复用凭据。配置及凭据不提交 Git。控制器启动时验证实际目录和租户 authority，操作前后再次核对。目录包括类型/长度/默认值、约束、权限、函数、安全属性、触发器启用状态、重写规则、索引和 RLS 策略。

本次只在隔离数据库安装协议，没有在原流程库新增表、触发器或角色。原流程服务的既有数据库所有权尚未在本协议中收敛，正式启用仍需受控升级、运行权限和备份恢复方案；原有固定表数的归档验证也需适配新增两个协议表，不能套用旧证明直接上线。

## 请求及证明

- `POST /v1/cancel-reconciliations`：严格 JSON `{controlId,envelope}`，envelope 为原 create 信封，保留原 commandId、entityId、actor、correlationId 和 requestDigest；不生成替代创建命令。
- `GET /v1/cancel-reconciliations/{controlId}`：恢复同一已持久决定。未找到时仅表示没有该控制决定，不能判定外部未创建。
- 两路由均要求专属 Bearer token 与 `X-IDMS-Tenant`，拒绝重复身份头、查询参数和非法信封。POST 拒绝重复 JSON key、未知字段及无效原摘要。
- 使用 `WorkflowCancelTransportV1` 发出实际受认证请求并获得 `WorkflowCancelProofV1`。普通 JSON、其他配置绑定、其他控制号或请求中途改过的信封不能替代证明。响应丢失时保留原 controlId 查询，不据此重新建单。

服务与原创建共用实体事务锁。已存在同一摘要的原命令回执时，返回 CREATED 和原创建回执；若实体已进入后续维修，回执仍保留初始版本，不能冒充当前状态。领域层关联工单前还必须核对当前外部流程及当前业务证据。回执、实体或摘要冲突时拒绝。

回执和实体均不存在时，事务记录 BLOCKED 并设置原命令和计划实体的永久阻断。旧创建接口即使随后收到原请求，或将其中一个编号替换，也会在同一 Flowable/业务事务中失败并回滚，不留下孤立流程。账本和阻断不能更新、删除或截断。相同控制号同信封返回原决定，不同信封冲突；另一个控制号也不能逆转阻断。

## 验证及继续工作

运行 `node scripts/verify-workflow-cancel-v1.mjs <独立构建 verification.json>` 只创建随机命名的测试数据库、角色和自有 Java 进程。它验证实际 Flowable 的两个锁竞争顺序、迟到及编号替换、真实截断回复、重启、跨租户、目录篡改和最小权限。`node scripts/verify-workflow-cancel-cleanup-v1.mjs` 只读复核已登记目标的名称/OID 无遗留。

下一层继续实现原生取消证明、领域对账状态与审计、另一人的当前授权复核、原操作人重新确认、过期/冲突处理及持久 HTTP 作业，再接入统一主站的网页操作。旧取消任务接管仍会拒绝可能外部已创建的情况，不能移除其拒绝以冒充完整对账。完整商业目标和最终图文/实际视频交付仍未完成。
