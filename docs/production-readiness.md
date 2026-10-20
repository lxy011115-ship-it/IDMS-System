# IDMS 商用生产落地基线

2026-10-15更新：本机平台已连接企业独立PostgreSQL、真实Keycloak/OIDC/PKCE、只读模拟OPC UA/MQTT和Flowable维修BPMN。角色/租户/职责分离、幂等outbox、重启与事务故障已测试。以下早期替换清单中，这些项目已完成开发集成，但仍需生产化，不能按“已列出/已安装”认定生产完成。以 `scheme-a-development-status.md`、`authentication-guide.md`、`workflow-guide.md` 和 `telemetry-guide.md` 为准；production门禁继续锁定。

当前系统已具备可演示的领域规则、版本化 API、多租户上下文、AI 中间审核、人工终审和审计链。商用部署必须完成以下替换和验证：

## 必须替换

- 将 `server/store.ts` 替换为 PostgreSQL 控制库、每租户业务库和 TimescaleDB 遥测库。
- 将演示请求头替换为 Keycloak OIDC/JWT；网关必须验证 issuer、audience、签名、过期时间和租户声明。
- 将内存幂等表替换为数据库唯一约束与事务写入。
- 将内存审计事件写入追加式 `audit_events`，使用数据库事务和密钥托管签名。
- 首期实现 `api/data-upload.openapi.json` 中的文件/JSON上传契约，接入原文件归档、规则校验、暂存、人工终审和事务入库；按 `manual-upload-idms-plan.md` 验收。
- 接入真实 AI 网关；模型不可用时转人工复核。Flowable 在复杂流程阶段接入；EMQX/MQTT、OPC UA 和高频 TimescaleDB 接入安排在后续设备采集阶段。

## 生产门禁

- 不得使用 `.env.example` 的默认密码；所有正式密钥从 Vault/KMS 注入。
- 不得给 IDMS 设备连接账号授予 PLC 写权限。
- 所有插件必须签名、扫描、声明权限并通过认证流水线。
- AI 低置信度、证据不足、模型不可用和提示注入必须转人工。
- 报警关单、质量放行、模板/插件发布和外部关键回写必须人工审批。
- 备份恢复、跨租户访问、断网补传、重复消息、审计链和灾备必须演练。

## 建议上线顺序

1. 先部署并联调 PostgreSQL、对象存储和 Keycloak。现有 Compose 是配置骨架，需按首期模式调整并验证；TimescaleDB/EMQX 不作为手动上传前提。
2. 导入 Realm、创建测试用户和角色，验证 JWT 到租户/数据范围映射。
3. 上传五类模板样本，验证逐行错误、去重、越权、版本冻结、禁止自审、终审和原文件追溯。
4. 验证持久化批次状态机、AI中间节点和人工终审门；复杂流程再部署 Flowable。
5. 接入企业 AI 网关和脱敏知识库，先影子运行，再按流程逐步启用自动审核。
6. 完成性能、安全、备份恢复和 UAT 后推广手动上传试点；后续再用 OPC UA 模拟器和 MQTT 测试消息验证点表、断线缓存、质量标记与补传。
