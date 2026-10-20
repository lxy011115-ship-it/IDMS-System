# IDMS 角色权限配置说明

## 导入

2026-10-15实际运行说明：`role-permissions.json`是产品目标权限种子，不表示全部已实现。当前OIDC后端实际授权来自 `server/access.ts`，Keycloak角色由本机初始化程序配置。`GET /roles`同时返回`runtimeRolePermissions`、`runtimeAuthMode`与数据范围提示；界面将两者分开展示。当前执行租户级隔离，工厂/产线/设备细粒度范围仍待实现。详见 `authentication-guide.md`。不要直接导入目标权限包就宣称相应业务已上线。

`docs/role-permissions.json` 是权限种子文件。实施时建议将 `roles[].key` 映射为 Keycloak Realm Role，将 `permissionCatalog[].code` 映射为应用权限声明，并在业务服务中同时校验角色权限和数据范围。

## 必须遵守的边界

- AI 不是业务角色，不能获得 `alarm:final-approve`、`quality:release`、`template:publish`、`plugin:activate` 等最终责任权限。
- 设备接入只允许写入遥测，不允许 `plc:write`、`opcua:write`、`mqtt:command`。
- 所有写操作都必须产生审计事件，并携带 `tenant_id`、`actor_id`、`correlation_id` 和 `Idempotency-Key`。
- 数据范围不能由前端决定，必须在 API/数据库查询层强制注入。
- 终审角色建议与日常维修、配置角色分离，避免同一用户既修改规则又批准结果。

## 角色分配建议

### 当前运行时模板/插件权限（v1.2.0）

- tenant-admin：read、template:edit、template:submit、plugin:submit；无模板发布、插件认证/激活权限。
- final-approver：包含template:publish、plugin:activate；不可批准自己创建、编辑或提交的模板，插件激活仍因未完成安全流水线而拒绝。
- platform-certifier：read、plugin:certify；角色初始化不自动授予账户，制品认证流水线未完成时仍拒绝认证。
- system-admin：read；即使叠加其他角色，业务终审、模板发布、插件认证/激活也被过滤。
- auditor：read；网页无编辑、提交或审批入口。

目标权限包中的完整业务/数据范围不是当前运行时已实现范围。维修模板和插件实际边界见`template-governance-guide.md`。在途工单冻结模板字段与摘要，权限/模板更新不能改写旧审批证据。

每个企业至少配置 1 名租户管理员、1 名设备管理员、1 名质量工程师、1 名维修负责人、1 名业务终审员和 1 名审计员。生产主管、操作员和备件管理员按工厂/产线数据范围分配。

## 变更流程

目标要求：角色或权限变更必须提交变更单，经过安全审批后发布；权限包版本化，历史审批记录保存变更前后差异。当前角色撤销在令牌刷新后生效，不声称已签发JWT即时失效；即时撤销和权限变更审批仍需后续实现。历史审计保留，但读取仍受当前授权限制。

## 初期手动上传补充（v1.1.0）

新增 `data-uploader`（数据上传专员）及 `data-import:*` 五项权限。终审员具有 `data-import:approve`，审计员仅查看批次；AI 和接口身份禁止批次终审，上传人与终审人必须不同。角色目录是配置资产，当前 Demo 的请求头身份不等于已实现生产 RBAC；正式上线需在后端执行权限、令牌租户和行级数据范围校验。

上传与审批权限还需绑定 `DEVICE / PRODUCTION / STATE_INTERVAL / MAINTENANCE / QUALITY` 数据类型授权；不能用通用上传权限写入任意业务。企业管理员通过受审批的授权配置完成分配，上传文件不能修改角色、批准标志或审计字段。方案及API契约参见 `manual-upload-idms-plan.md` 与 `api/data-upload.openapi.json`。

