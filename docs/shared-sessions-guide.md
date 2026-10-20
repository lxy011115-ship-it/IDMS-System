# 共享加密登录会话

更新：2026-10-16。原本机平台已启用本功能，入口 http://127.0.0.1:4010/?view=data-center 。这是完整商用方案A中的身份状态里程碑，生产发布门禁继续关闭。

## 实际行为

两个核心使用同一公开Origin、OIDC issuer/client/audience及业务部署绑定时，共享登录状态和浏览器会话。登录可以从A开始、由B接收回调；单实例或全部核心重启后，未过期会话仍可使用。反向代理必须保留正确Host，业务写请求仍校验固定Origin及CSRF。

登录state、nonce、PKCE verifier最多保留5分钟，Cookie匹配后一次性消费。浏览器会话固定最多8小时，刷新不延期。访问令牌临近过期时，在共享会话行锁中向身份提供方续期、验证签名/subject/企业/角色/范围并保存轮换后的令牌；其他实例等待这次提交。角色和范围变化在新令牌生效时应用，不宣称即时撤销已签发JWT。

退出先验证Origin/CSRF并持久删除会话，再追加业务审计和尝试上游退出。审计失败返回503并明确告知会话已撤销，不恢复原SID。并发续期不能复活已删除会话。刷新失败会撤销本地共享会话；提供方已轮换但数据库提交未确认时需要重新登录，不承诺跨数据库/身份提供方的分布式原子性。

Cookie只有256位随机ID，HttpOnly、SameSite=Lax；HTTPS配置自动加Secure。数据库按随机ID的SHA-256索引，令牌、PKCE材料、身份与CSRF正文使用AES-256-GCM加密。AAD绑定部署、OIDC/公开Origin作用域、记录类型、索引、版本、绝对过期时间及keyId。浏览器不保存访问/刷新/身份令牌。

随机服务端会话和生命周期设计参考[OWASP会话管理指南](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)；刷新令牌轮换与重放风险参考[OAuth 2.0安全最佳实践RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html)。这些参考不替代生产安全验收。

## 存储与启动

独立认证数据库使用专属NOLOGIN owner、可SET ROLE的migrator、受限app及只读backup。独立schema版本为1；企业业务迁移保持v3，已应用的v1/v2/v3校验和不修改。

三张表：`auth_store_meta`保存部署/密钥验证材料，`auth_schema_migrations`保存版本和身份，`auth_state`保存加密LOGIN/SESSION及过期索引。app只读前两表，对状态表可增删改查；不能DDL、创建对象或连接企业库，backup也不能写入或连接企业库。启动复核所有权、实际表/列权限、默认权限、角色成员关系、迁移校验和、业务连接隔离和密钥验证材料。

```powershell
npm run sessions:setup
npm run platform:start
```

完整启动已包含幂等的会话库配置步骤。直接启动PostgreSQL/OIDC核心前必须先完成setup；缺少配置、错误密钥、权限漂移或不可用数据库会阻断启动。运行中存储中断/状态篡改返回503，不能使用旧内存会话放行。

`.local/auth-session-stores/<业务绑定摘要>/`内的`runtime.json`、`deployment.json`、`keys.json`分别保存运行连接、部署/迁移/备份凭据及加密密钥，均受限保存。核心只加载运行配置及密钥；默认位置由业务库配置派生，`IDMS_AUTH_SESSION_CONFIG`可显式指定匹配绑定的配置。不要分享这些文件或将其复制到outputs。

首次从旧内存实现升级需要重新登录一次。此后符合相同绑定的实例使用共享持久会话。明确的文件Demo及协议单元测试仍使用内存，文件Demo重启失效；健康接口`sessionStorage`区分`MEMORY`与`POSTGRES_ENCRYPTED`。

## 验证与证据

```powershell
npm test
npm run build
npm run sessions:verify
npm run multi:verify
npm run auth:verify
npm run data:live:verify
```

106项单元及61项构建检查通过。`sessions:verify`使用隔离企业库、独立认证库、临时Keycloak域及严格刷新令牌轮换；同一代理后两个独立核心覆盖A发起/停止后B回调、回放、共享Cookie/CSRF、跨实例独立批准、12路并发续期、双实例重启、绝对过期、客户端/Origin隔离、密文篡改、错误/缺失配置、数据库中断、权限漂移、角色/范围刷新、续期/退出竞争、审计故障仍撤销、桌面/320/390手机及原企业摘要不变。测试只清理自己创建的库、角色、身份域和私密文件。

证据见`outputs/shared-sessions-verification.json`。`multi:verify`仍以各自浏览器会话测试业务竞争，其`sharedBrowserSessions:false`表示该脚本没有验证共享Cookie；共享语义由新专项证明。`auth:verify`明确使用文件隔离模式，保留重启失效协议回归。实际4010只读验证确认共享会话模式及原6批/0工单、业务/导入摘要不变，证据见`outputs/live-data-management-verification.json`。

## 尚未完成的边界

- 本机仍为HTTP、Keycloak开发部署、同一主机用户与磁盘；文件ACL不等于进程/主机级秘密隔离。TLS、受管密钥、SSO/MFA、全面限流和安全评估继续。
- 密钥环可以使用新active key写入并保留旧key读取；旧会话及密钥验证材料依赖旧key。尚无完整重加密/旧key退役工具，不能直接删旧key或宣称轮换运维已验收。
- 当前企业业务备份包含29张业务公共表，**不包含独立认证会话库、密钥、Keycloak或Flowable**。认证存储备份、恢复后的强制失效/防撤销回退、跨服务一致性、PITR及RPO/RTO继续。
- 会话行锁证明了并发语义；数据库HA、连接容量、跨节点网络/故障切换、后台worker多实例及规模性能仍需专项验收。原业务v3仍有全企业读取/哈希开销。
- 真实现场OT/TLS、时序/对象/搜索/事件、模型/RUL评测、插件运行、许可/配额/计费和客户验收保留在完整方案A待办中。
