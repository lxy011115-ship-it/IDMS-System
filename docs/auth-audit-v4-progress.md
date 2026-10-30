# 认证生命周期审计进展

本阶段完成了同认证库的会话/outbox 协议、有界业务审计写者、独立投递 worker 和控制台认证新入口。原913源 v2 站点继续运行，新增模块未切换原租户，完整商用目标保持 ACTIVE。

认证事件包含登录、退出、替换、失败撤销和绝对到期。SESSION 插入/删除由 ALWAYS 触发器要求消费密封草稿，同事务追加逐租户源序列/hash 链；不可变事件、交付状态、最小权限、完整目录/OID/ACL 与非 MVCC DDL epoch 已接线。投递端只持派生 outbox keyring，不持会话 master ring 或认证 APP 凭据。业务写者通过固定事件回执、独立 CAS 尝试 UUID 保证幂等，按当前 control 延后维护中的投递。

当前 PG 正式证据为 `work/auth-audit-pg-v4-20261020/944216058867/verification.json`。实际验证 SESSION/outbox、五类生命周期、未消费草稿不能 COMMIT、原 SDK 跳过审计失败、事件在 replica 下 I/U/D/TRUNCATE 仍拒绝、投递角色不能读会话或原事件表、会话/业务/ACK 三处真实 COMMIT 回复丢失后恢复、双 claim/双 CAS 只产生一次审计、JSON 假回执拒绝、维护中退出持久、实际独立 Node 在业务提交后 exit0 未 ACK、真实 31 秒接管及旧 claim 拒绝、主线程实际阻塞 32 秒的独立续租、回滚 public 会话触发器 DDL 后 epoch 拒绝。

额外 256 条认证事实逐条写入/确认，64/256 阶段每次普通写者均读 9 个逻辑键，末次 2238 个值字节。数据是本机可信 session fixture，不冒称真实 OIDC；Keycloak/Chrome 由单独 UI 检验覆盖。数字是请求逻辑依赖与本机观测，不是平台吞吐或生产 SLA，未声称完整全局 CPU/内存配额已完成。

当前真实 Keycloak/Chrome 正式证据为 `work/auth-audit-keycloak-v4-20261020/9f7233370563/verification.json`。三个独立产品 CLI（HTTP、治理 WORKER、认证审计投递）及六动作、独立审核、CSV 下载、丢回复恢复、撤权/重新授权、身份切换、1440/390/320/CSP/XSS 均通过。三个真实主体登录和一次退出首先形成四条认证审计；业务 APP/READER 两角色按自有 OID 核验后 NOLOGIN，真实 UI logout 仍 200、SESSION 消失、outbox PENDING；精确恢复角色后只投递一次。挂起租户时，有效 Keycloak 身份无法新建 SESSION 或登录事件，恢复 ACTIVE 后实际登录成功并额外投递一条登录审计。真实令牌/会话/CSRF/密码值均未出现在认证业务审计。

独立只读 CLI 负例 `work/auth-audit-cli-negative-v4-20261020/9f7233370563/verification.json` 的 7 项通过：错误派生 key、错误地提供会话 master ring、错误 DB OID、错误角色、远程业务明文配置、两个入口损坏的私密 JSON。所有子进程实际 exit1、未 READY，捕获输出没有实际私密值，临时配置已删。早期 b220/b38 成功只作历史保留，当前 sourcePins 只认 944 与上述 fresh UI/CLI 证据。

运行中复现并修正：SQL CASE 条件括号；无 public USAGE 的投递角色目录解析；FK 在 TRUNCATE 触发器前拒绝，需要同时指定 events/delivery 才能验证 ALWAYS；并发投递复用底层命令 UUID 导致不同随机审计内容冲突，改为每 CAS 独立 UUID、固定业务回执。进入检验阶段的失败输入快照与全部精确清理记录保留。首个安装语法探针在输入快照前失败，仅保留资源及错误说明，不当精确执行源证据。

4 项新增单元与原认证/会话相关共 14 项通过，原268构件/server类型通过。原全业务总套件未重跑。全部旧交付、66整文件约束、十轮双份快照及原913源站点复核通过。10:18 CST 原核心28472/owner10320/PG32152九服务和原集群保持，恢复后额外8006个ACK逐条PG点/回执/审计核验通过；观测ACK66644、pending1。全部10次自有QA共50DB/210角色即时库存0残留，无FORCE或backend终止；临时realm及私密配置删除。最终三证据目录ACL仅当前用户且关闭继承。

后续仍包括 AI outbox、其他领域写者、100 批次演示限制与商业保留策略、普通治理维护全图性能/全局资源、统一审计 UI/HTTP 网关、旧活会话迁移和全站保值切换。匿名失败的集中安全事件、auth+outbox 完整备份恢复、跨 OS 服务账号隔离、密钥轮换/TLS/MFA、现场接入/HA-PITR/模型 RUL/SaaS 私有化许可及完整商业验收尚未完成。未以真实 10000 积压填满新登录背压阈值，不声称该商业容量边界已整体验收。
