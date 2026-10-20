# v4 认证生命周期审计

本模块为新部署协议，配合治理控制台新增认证入口使用。原 v2 站点和已发布源码保持，不能直接向原认证库安装。完整方案 A 继续开发。

## 生命周期

| 事实 | 事件 | 处理 |
|---|---|---|
| 真实 OIDC 登录成功 | AUTH_LOGIN | SESSION 插入与 outbox 在同一认证库事务提交 |
| 显式退出 | AUTH_LOGOUT | Origin/CSRF 验证后，同事务删除 SESSION 和记账 |
| 新登录替换旧会话 | AUTH_SESSION_REPLACED | 旧 SESSION 删除、替换事实和新登录一起提交 |
| 刷新或身份验证失败撤销 | AUTH_SESSION_REVOKED | 删除原会话并保留固定原因 |
| 绝对期限到期 | AUTH_SESSION_EXPIRED | 用 DB 时间判断，分批删除并记账 |

OIDC 的 JWT/PKCE/nonce、共享会话密文和 CSRF 协议继续使用原实现。只有服务端真实退出路由能设置显式退出作用域，客户端不能指定审计主体或角色。Bearer 验证不是交互登录，不伪造 AUTH_LOGIN。匿名登录失败的集中安全事件尚待后续接线。

新登录先读取当前租户 ACTIVE 状态。认证事务提交后才发会话 Cookie；提交回复丢失时，用新连接核验持久事件与实际会话后置条件。旧 SID 的登录唯一索引阻止已退出会话被同键重建。认证库自身不可用时不承诺全局撤销已确认；业务库维护或不可用时，只要认证库可用，退出可以完成并保留待投递事实。

每 scope+tenant 待确认事件达到 10000 时暂停新登录授予；已有会话退出、撤销和到期仍可记账。此次没有堆满真实 10000 个待确认事件来检验此阈值，不将它作为完整商业背压验收。已有会话限额、登录尝试限额和分批到期清理一起约束当前部署。

## 最小权限与密钥

认证 APP 保留原 public 三表权限，新 schema 的事件/序列/交付/草稿仅由专用函数维护。SESSION I/D 必须消费同事务中预留并密封的生命周期草稿；未消费草稿不能 COMMIT。旧状态实现不能跳过审计授予或删除会话。事件不可变，状态受保护，ALWAYS 触发器在 replica 模式仍生效。完整目录/OID/角色/ACL 绑定与 DDL 共享门、非 MVCC epoch 共同拒绝漂移。

独立投递进程只接收单向 HKDF 派生的 outbox keyring、delivery 角色和业务 APP 凭据，不接收会话 master ring 或认证 APP 配置。派生密钥不能解密原会话；delivery 角色不能 SELECT auth_state 或原事件表。空队列也通过密钥 witness 验证用途。当前本机开发进程仍使用同一 OS 账户，生产服务账户及秘密目录的跨进程隔离仍需部署阶段完成。

审计事实只保留可信 actor、当时角色、固定原因和 HMAC 会话引用，不含用户名、SID、CSRF、access/refresh/id token、密码或任意异常原文。历史角色仅为证据，不能授权新的业务动作。事件 AEAD 绑定部署、源 DB OID、scope、租户、UUID、位置、动作、DB 时间、摘要与源链；不因 APP/delivery 的不同角色 OID 使密文不可互通。

所有源/业务数据库账户先验证显式连接信息与传输，再建立连接。loopback 可用于本机开发；远程账户要求证书验证开启的 TLS。当前旧认证 runtime 不包含 TLS 参数，因此本入口对其认证连接只支持 loopback，不能静默将认证密码发往远程明文连接。

## 投递和恢复

每个 scope+tenant 按下一个未确认序号领取，租约使用真实 DB 时钟 30 秒，独立线程每 10 秒续租。不同租户可以独立推进。业务 UPDATING 时等待；ACTIVE/PAUSED 时只读固定事件回执、源 cursor、租户实体、审计 tip/order，追加旧格式 audit/order/tip、源 cursor 与不可变事件回执于同一个 CAS。它不重构租户全图，也不遍历完整审计历史。

相同事件由固定业务回执保证幂等，每次 CAS 尝试使用独立底层命令 UUID，避免两个投递者各自生成审计内容时发生命令冲突。提交回复丢失先核验真实回执。业务提交成功后才确认源 outbox；两库之间没有分布式事务，进程在两步之间退出时重新投递并验证原业务回执，不重复追加审计。已失效 claim 不能确认源状态，JSON 冒充的完成回执也不能通过 SDK 确认。

业务审计 businessTime 是投递时间，metadata.occurredAt 明确保留认证库捕获时间，同时记录源事件序列和 hash 链。历史事实不因用户当前角色已撤销而丢弃。业务审计查询继续由当前读取权限与原 AUTHENTICATION 主体范围约束；本阶段没有新增控制台审计页或将原 v2 审计页切到新库。

## 入口与配置

`node scripts/governance-console-auth-v4.mjs <private-runtime.json>` 使用此前控制台 HTTP/WORKER 配置，新增必需的 `authAuditBinding`。HTTP 仅持业务 READER+QI，治理 WORKER 持 APP；二者用原加密认证状态及新生命周期协议。HTTP 每 30 秒尝试分批清理到期会话。此入口保留全部六个治理动作和当前授权检查。

`node scripts/auth-audit-worker-v4.mjs <private-runtime.json>` 为独立投递 CLI，配置顶层精确为 `format:1`、`purpose:AUTH_AUDIT_DELIVERY_RUNTIME`、`keyFile`、`source:{account,binding}`、`targets:[{account,binding}]`。keyFile 只能保存派生的 outbox ring；source 只含 delivery 凭据，targets 为已固定的租户业务绑定。启动核验最小权限、数据库相互无 CONNECT、密钥 witness、目录与传输。没有内存认证降级或自动建立数据库/重新绑定行为。

私密父进程 IPC 使用 GOVERNANCE_STOP 排空控制台 HTTP/治理 worker，AUTH_AUDIT_STOP 排空投递进程；退出只停止本进程。所有凭据和配置留在私有目录，私密 JSON 损坏只返回固定错误，不打印输入片段。

安装要求专用新认证 DB 的 auth_state 为空，且配置、目录和 keyring 已显式核验。旧活会话迁移、auth+outbox 完整备份恢复、密钥轮换部署程序及最终原站点切换仍需后续保值流程，不得在原库盲装或重跑旧 one-shot。
