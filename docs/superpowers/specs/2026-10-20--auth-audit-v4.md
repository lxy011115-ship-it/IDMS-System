# 认证生命周期持久审计

完整方案 A 继续。上一阶段控制台是已验证进展，原913源v2保持；所有已发布源及对应根文件冻结。本阶段新增模块和新控制台认证入口，禁止改旧原件或在线安装到原认证/业务库。

## 选择与边界

直接同步写业务审计会让登录/退出受治理维护锁和业务库故障影响；仅用现有record回调入队，退出在删除会话与回调之间仍有崩溃缺口。采用认证库同事务的受保护 outbox，独立投递到业务增量审计链。原 createAuth 的验证/PKCE/CSRF、共享会话密文和 cursor 协议复用；新持久状态实现自动捕获生命周期，退出由明确请求作用域标记，不能从客户端声明审计身份。

登录仅在受信JWT及当前租户ACTIVE检查通过后创建会话；SESSION插入与AUTH_LOGIN outbox同事务。旧会话替换、显式退出、刷新/校验失败撤销、绝对到期分别记录明确原因。显式退出的CSRF须在删除和审计之前验证。过期清理分批、无效尝试不产生可信用户事件。Bearer验证本身不是交互登录，不伪造AUTH_LOGIN；匿名失败的集中安全事件属于后续工作，不宣称已覆盖。

## 认证库

新schema auth_audit_v4，保留public原三表及原会话AEAD。APP不得直接变更outbox/head/cursor/delivery/context；NOLOGIN owner、ALWAYS写/截断触发器、专用SECURITY DEFINER函数、DDL共享门与非MVCC epoch、全目录/OID/角色/ACL绑定。原SESSION I/D在新schema由触发器要求已分配并密封的生命周期上下文；旧状态SDK不能绕过。上下文必须在事务结束前被消费，禁止留下已分配序号而无会话事件。

每(scope,tenant)事务序列和前hash链，DB时钟捕获occurredAt。事件包含可信actor、当时角色及固定原因，不含用户名、SID、CSRF、JWT、refresh/id token或任意异常原文。公开sessionRef为用途独立HMAC。事件AEAD用途独立，绑定部署、数据库OID、scope、租户、事件UUID、序号、动作、时间、digest/源链；APP与独立投递角色之间不以角色OID绑定同一密文。独立投递进程只持从会话master ring单向HKDF派生的outbox keyring，不能读取认证APP凭据或使用会话master keys；新schema的密钥witness在空队列时也验证此用途。角色快照仅作历史证据，不授予执行业务权限。

会话变更COMMIT回复丢失，新连接核验持久事件和实际会话后置条件；不能把不确定提交当成确定失败或成功。已使用SID不得重建以复活已退出会话。新状态实现不回退内存，生产入口必须验证新协议和隔离角色。

## 投递与业务根

独立最小角色仅能领取/续租/确认outbox，不读auth_state。30秒真实DB租约、fence、独立心跳，按scope+tenant的下一个未确认序号执行；不同租户可独立推进。内容不可变，交付状态受函数保护。错误保留可重试，不能删除或跳过历史。每scope+tenant待确认事件达到10000时暂停新登录授予；既有会话退出/撤销/到期仍持久记账，不以积压理由恢复会话。

业务写者只读租户实体、control、源cursor、审计tip/order、固定事件回执及局部审计，不能重构TenantPayload或扫描全历史。ACTIVE/PAUSED可追加，UPDATING等待以保持维护branch base。历史认证事实投递不依赖用户当前角色仍有效；租户绑定必须存在，登录准入则独立要求ACTIVE。新旧审计格式保持；businessTime为投递时刻，metadata显式保留DB捕获的occurredAt和源事件链。

同一业务CAS追加旧格式audit/order/tip、源cursor和不可变事件回执；同事件同digest重试返回已验证回执，错body/跨租户/跳序拒绝。最终业务COMMIT确认后才能确认outbox。跨库中断通过固定事件键重放，不宣称分布式事务；崩溃于业务提交与源确认之间不会重复审计。

## 验证

新单元验证事件白名单、密文/AAD/用途/篡改、序列链；自有真实PG验证会话+outbox原子回滚/原协议拒绝/ALWAYS/目录epoch、实际COMMIT回复丢失、两个投递者/真实租约接管、业务提交后退出未确认后重放、业务维护/故障时退出持久化、当前身份/CSRF/角色及凭据不入审计。真实Keycloak/Chrome检验登录/退出/替换与新控制台入口，独立CLI排空；全旧交付/原站点及ACK保持。QA按实际OID/owner/0连接精确清理，无FORCE或backend终止。测试和部署事实分开，完整商用目标保持ACTIVE。
