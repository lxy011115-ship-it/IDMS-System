# IDMS 真实身份登录与权限说明

更新：2026-10-15。当前为本机开发集成，不是生产安全验收。

## 访问与启动

- 网站：`http://127.0.0.1:4010/?view=predictive`。
- 双击 `启动IDMS.cmd`，或执行 `npm run platform:start`。
- 平台管理进程确保 PostgreSQL、Keycloak 已就绪，再启动独立预测进程和业务核心。所有服务绑定回环地址。
- Keycloak 26.8.1 位于 `%LOCALAPPDATA%/IDMS/runtime/keycloak-26.8.1`，使用本机 JDK 21 和独立 `idms_identity` 数据库；监听 `127.0.0.1:8081`。
- `infra/keycloak/idms-realm.json`只是无凭据配置蓝图，不能替代初始化程序对管理员专属tenant属性、角色范围和账户的配置，不能单独导入后就对外部署。
- 已比对官方 GitHub Release API 发布的 ZIP SHA-256。未修改系统 PATH、未安装开机服务、未配置公网访问。
- 初次换电脑需安装依赖，运行 `scripts/install-runtime.ps1 -Component java|postgres|keycloak`，再启动平台。私密配置不能复制为标准交付包。

## 初始账户

账户和随机临时密码只保存于 `.local/本机登录账户.txt`，Windows ACL 限制为当前用户。不要复制到聊天、工单、演示包或源代码。

| 用户名 | 角色 | 企业 | 核心职责 |
|---|---|---|---|
| uploader | data-uploader | acme | 上传、分析，不能批准 |
| approver | final-approver | acme | 批准批次/建议、独立关单，不能上传 |
| technician | maintenance-engineer | acme | 领取、执行维修、提交复测，不能终审自己的维修 |
| auditor | auditor | acme | 只读 |
| tenantadmin | tenant-admin | acme | 创建/编辑/提交模板草稿和插件清单，不自动拥有业务终审权 |
| sandbox.auditor | auditor | sandbox | 仅能读沙箱企业 |

首次登录必须自行设置至少12字符的新密码，包含大写、小写及数字。账户文件中的临时密码随后失效。重跑初始化不重置用户密码。企业真实使用时必须为不同人员创建独立账户，禁止多人共用上述开发账号。

Keycloak 管理凭据位于 `.local/keycloak-runtime.json`，仅供本机初始化程序。当前使用开发 bootstrap 管理账户；生产必须更换永久管理员、MFA、独立运维权限和受管密钥。业务应用不使用管理员凭据验证每个请求，也不提供租户管理员跨企业创建用户的业务入口。

## 实际认证链路

1. `/api/v1/auth/login` 生成一次性 state、nonce、PKCE S256，浏览器跳转到 Keycloak。
2. 回调必须匹配有效的服务端请求和 HttpOnly 登录 cookie，验证身份令牌 nonce 及 subject。
3. 访问令牌通过固定 JWKS、RS256、issuer、audience、过期时间、调用客户端和 Bearer 类型校验。
4. `tenant_id` 为管理员维护的属性，普通用户不能修改。角色只读取受信任的 realm role。
5. 浏览器得到随机 HttpOnly、SameSite=Lax 会话 cookie；访问、刷新和身份令牌在PostgreSQL/OIDC模式存于独立加密共享会话库，不写 localStorage/sessionStorage；明确文件Demo保留内存。
6. 浏览器写请求验证固定 Origin 和 CSRF token；业务写接口继续要求幂等键、版本及输入摘要。
7. 令牌临近过期时单次并发刷新；刷新后重新验证身份、企业和角色。角色撤销在刷新后生效，不宣称即时撤销所有已签发JWT。
8. 最终审批仍检查真实用户 subject 与上传人/维修负责人分离。角色叠加也不能越过不可自审规则。
9. 登录和退出以真实subject写入业务审计，不记录令牌和密码。退出持久撤销共享会话，再尝试结束 Keycloak 会话；上游/业务审计失败也不会恢复旧会话。

模板/插件服务也复核后端授权。模板创建、全部编辑贡献者和提交者不能终审本人版本；system-admin仅只读，叠加终审角色也不能取得业务最终批准/发布权限。platform-certifier只建立角色，不自动分配给任何账户。插件认证/激活即使角色允许，仍因制品与执行隔离未验收被阻断。模板操作见`template-governance-guide.md`。

当前平台只接受配置的 Web 客户端用户访问令牌。API 接受 `Authorization: Bearer <access_token>`，不接受 ID token。机器身份与外部连接器的 OAuth 客户端仍待单独设计授权；不允许把服务账号当成人工终审员。

OIDC 模式忽略 `X-Actor-Id`、`X-Actor-Type` 的提权尝试；`X-Tenant-Id` 如与登录企业不同则403。不要再用演示请求头调用实际4010平台。

## 业务使用

上传专员登录并上传 → 独立终审员批准 → 已批准测点进行工程分析 → 终审员批准维护建议 → 维修工程师领取工单、开始维修并提交证据 → 独立终审员关闭或退回。

旧版未执行的 `ASSIGNED / demo.*` 工单允许授权工程师领取，显式记录原负责人和新负责人，避免静默改写历史。已执行工单不会自动改派。

`npm start` / `启动演示.cmd` 仍是明确的文件演示模式；只有该模式保留身份选择器，不得作为正式部署。生产模式继续拒绝启动。

## 验证

```powershell
npm test
npm run build
npm run auth:verify
npm run sessions:verify
npm run demo:verify
npm run maintenance:verify
npm run postgres:verify
npm run predictor:verify
```

`auth:verify` 创建唯一命名的临时测试用户及短令牌客户端，实际使用本机 Keycloak、Chrome 和隔离业务命名空间；采用隔离文件存储，故会话仍在内存、重启失效；验证后仅清理本次创建的身份，不删除客户账户。共享PostgreSQL会话由`sessions:verify`单独验证。覆盖PKCE、首次改密、真实Bearer、签名拒绝、租户隔离、权限、不可自审、CSRF、真实续期、角色撤销、退出与重启失效。签名/issuer/audience/过期等负例还由本地签名测试精确验证。

证据：`outputs/auth-verification.json`、`outputs/live-auth-verification.json`。实际4010验证确认原6批数据、工单及业务摘要未改变；登录/退出正常追加审计。该结果不等于负载、安全渗透或灾备验收。

## 尚未完成的生产要求

- Keycloak `start-dev`、本机HTTP必须换为受管生产模式及TLS；完成AD/SAML/MFA实际联调。
- PostgreSQL/OIDC已实现独立加密共享会话、跨实例续期/撤销及重启保留；见[共享会话指南](shared-sessions-guide.md)。完整key退役、HA/容量、恢复后的撤销保障仍未验收。
- 已实现受信任企业/工厂/产线/设备声明和本人任务范围，跨范围批次整批保护；企业身份治理、权限变更时效和生产安全验收继续。
- 全面限流、异常登录审计告警、密钥保管、安全响应头、权限变更治理及安全测试仍待完成。
- 企业业务与认证库已各自分离owner/migrator/app/backup；主机级秘密隔离、独立不可变归档及跨服务备份恢复仍待验收。
- 插件清单平台可信验签与吊销已实现，制品扫描/完整认证及隔离执行尚未完成，因此认证/激活仍拒绝。Flowable维修BPMN、维修字段模板、本地真实AI网关已完成对应隔离集成验证；AI仍为抽样SHADOW，不代表生产自动审核。其他业务工作流、现场设备、TimescaleDB及商业化交付仍未完成；见`workflow-guide.md`、`ai-gateway-guide.md`及`template-governance-guide.md`。

不能将这一批真实登录集成描述为完整商用认证平台已经验收。
