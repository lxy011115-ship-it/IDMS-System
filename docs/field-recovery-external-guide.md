# 恢复终审的外部现态读取

当前外态适配器已接入[恢复计划提交与独立审批CLI](field-recovery-review-guide.md)，输入工单由协调器从完整核对的恢复目标读取。适配器自身不授予批准或激活，不能把任意JSON或观察结果当作批准；维护审批页面已接入，见 docs/field-maintenance-review-guide.md；正式激活仍待完成。原4010和4016仍使用旧功能代码，当前进程身份以外部中断后的新恢复基线为准。

Keycloak配置专用 confidential client，开启 service account/client_credentials，授予当前 realm-management 的 view-users、query-users、view-realm、view-clients，只用于读取；不得使用个人admin密码。人工登录另用维护专用PKCE客户端，绑定其真实内部client UUID。当前适配器要求同企业完整范围，作者具备template:submit，审批人具备template:publish且不同主体；system-admin不作为业务终审身份。签名校验后还会实际读取当前账号、有效角色、管理范围、realm/client失效时间与活跃会话。用户和sid按有界opaque标识处理，并与真实服务记录精确匹配，不假定sid为UUID。接口依据见 [Keycloak 26.8.1 官方REST API](https://www.keycloak.org/docs-api/26.8.1/rest-api/index.html)。

工作流新服务每企业的私密Account支持可选 `recoveryReadToken` 与 `recoveryAuthorityId`，必须成对配置，读取token与原serviceToken不同，authority ID为受控稳定UUID。原serviceToken仍只用于原业务路由；读取token仅能使用新GET `/v1/recovery-state`，不能使用业务命令。未配置读取身份时新端点不接受原writer回退。老配置和原命令保持兼容。

观察配置格式为：

```json
{
  "format":"idms-field-recovery-external-config-v1",
  "tenantId":"acme",
  "auth":{"mode":"oidc","issuer":"http://127.0.0.1:8081/realms/idms","audience":"idms-api","clientId":"idms-recovery-maintenance","origin":"http://127.0.0.1:4110"},
  "identityReader":{"clientId":"idms-recovery-identity-reader","clientSecret":"REPLACE_WITH_PRIVATE_READER_CLIENT_SECRET","loginClientUuid":"REPLACE_WITH_LOGIN_CLIENT_INTERNAL_UUID"},
  "workflow":{"baseUrl":"http://127.0.0.1:4016","recoveryReadToken":"REPLACE_WITH_PRIVATE_WORKFLOW_READ_TOKEN","authorityId":"REPLACE_WITH_CONTROLLED_WORKFLOW_AUTHORITY_UUID","definitionSha256":"847ed336a71628dd4b1ff67ad0a670935ee0bc86d0343b9f69dad3beeb93ccc3"}
}
```

生产配置与令牌不得进入公开成果。上述4016是配置结构示例，原服务尚无新端点，不能把当前失败改成跳过检查；新服务需后续受控切换。当前维护origin仍受开发阶段loopback约束，TLS/服务账号部署门槛继续完整计划。

内核调用 `captureRecoveryExternalState(config, accessToken, restoredOrders, {purpose:'AUTHOR'})`；审批观察使用 `{purpose:'REVIEWER',otherActorId:planAuthorId}`。它做前后两次当前身份/完整工作流读取，限制30秒窗口，输出短期观察摘要并明确approvalGranted/activationGranted均为false。不缓存成功观察用于将来批准；最终审批必须重新现查和提交权威审计。

工作流读取在实际READ ONLY REPEATABLE READ事务内核对case/历史与活动流程精确对应、最新定义及固定v1 BPMN内容、任务与最后命令回执、证据/提交人、编译变量与全部命令摘要。变量只读取编译v1使用的短字符串/布尔原始列，拒绝未知变量/附件类型，不反序列化任意引擎数据。恢复工单必须SYNCED且完整对应，额外、缺失或已推进均拒绝。

当前限制512 case、16384历史任务、8192命令、16MiB命令扫描、3MiB响应。超限拒绝，合成越界测试不等于容量验收。真实服务测试入口为 `node scripts/verify-field-recovery-external.mjs`，使用独立QA数据、端口和新构建目录；需要先将源码构建到 `work/field-channel-20261017/workflow-recovery-build`。Maven参数 `-Didms.build.directory=<absolute-new-build-directory>` 可隔离构建，原默认target下两个旧jar保持不变。测试结束等待真实进程/代理关闭后才清理自有资源。
