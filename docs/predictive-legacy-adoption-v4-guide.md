# 旧预测作业原人授权接管（WIP）

本入口接续读取迁移 A。原 SDK 作业必须具有原生计划、完成迁移回执和 `authority:NONE` 对账记录。原执行者使用当前 OIDC 登录会话提出明确接管；历史 context 只作为原始证据保存，不提供授权。新命令仍使用普通预测入口。

部署使用新建目标的 `predictiveJobsSchemaSqlV4R2`，其加入不可变接管台账和受限函数，并在 DDL witnesses 生效前安装。不能在当前活动库直接执行新 SQL；旧 schema 与旧 worker 文件保持原样。新入口会检查扩展权限，缺失扩展的配置不能 READY。迁移 A、接管 B 和原 workflow outbox 的迁移 C 是不同阶段。

私密 CLI：

```
node scripts/predictive-console-adoption-v4.mjs <explicit-private-runtime.json>
```

配置沿用预测认证工作台的严格字段和角色分离。HTTP 使用 QI 队列账号、READER 业务账号和共享认证配置，不接收规则服务、Flowable 或 APP 材料。WORKER 使用目标 APP、实际服务配置和同一部署的加密授权密钥。HTTP 只监听明确的 loopback 地址；共享会话和认证审计沿用现有持久实现。

API 每次检查当前身份、租户与设备范围，要求 `x-tenant-id` 和 `x-idms-actor-id` 与当前身份一致；会话 POST 必须通过现有 Origin/CSRF 检查。

| 方法与路径 | 内容 |
| --- | --- |
| GET `/api/v4/predictive/legacy/commands/:originalCommandUUID` | 本人候选摘要、原状态、设备、nativeHash、外部创建可能性和宿主是否已绑定 |
| POST `/api/v4/predictive/legacy/commands/:originalCommandUUID/adopt` | 精确 JSON：`adoptionId`（新的控制 UUID）、`expectedNativeHash`、`recoverClosedAcceptance`（布尔值） |
| GET `/api/v4/predictive/legacy/adoptions/:adoptionUUID` | 本人接受/执行状态；完成和取消须核原生回执与审计，较旧已被替代的控制返回 409 |

接收成功表示 SQL 已保存明确接管请求与加密的当前授权引用，尚未表示宿主已绑定或业务已完成。同一控制 UUID 重放不刷新授权；内容变化冲突。接受关闭的原命令必须显式设置 `recoverClosedAcceptance:true`，原关闭围栏仍保留。调用者不能提交新 actor、context、计划、信封或历史会话。

worker 只处理自己领取的具体 SQL 作业，在独立线程续租下重新解析实际当前身份和范围。它再次核原 SDK hash、grant revision、计划摘要、迁移与 NONE 记录，然后把宿主、接管审计、原生回执、必要的 SDK 新授权修订及 SQL 结果状态放在同一事务。无效操作全回滚；新请求 fence 旧租约；状态变化后不能按旧候选盲目覆盖。实际 COMMIT 回复丢失按原命令原生收据恢复。

| 原生状态 | 接管行为 |
| --- | --- |
| COMMITTED | 保持 SDK 作业逐值不变，验证完成证明并恢复 SQL 历史结果，不调用外部服务 |
| CANCELLED，且不存在潜在外部创建 | 验证原取消证明后恢复历史状态 |
| PENDING / WAITING_AUTH | 原人当前授权使 SDK grant revision 增加，保留原 context、命令、请求、计划、信封和尝试次数，再交现有 worker 执行 |
| HUMAN_REVIEW | 保持人工状态和原错误；后续仍需另一位当前审核人的独立 retry，再由原人明确重授 |
| 已取消且带创建信封的 REVIEW | 拒绝假定安全，要求外部人工对账 |

旧创建计划一律保守标记 `external_started`，不会把“本地未完成”推断成“外部未创建”。恢复使用原 Flowable entity、command、requestDigest 和 actor 信封；网络可能重放，本地仅凭真实回执发布。接管不是一次新的建单，也不授予审核人代替原执行者的权限。

当前提供独立后端入口，尚未增加浏览器接管控件或切换原统一站点。现有预测页面仍用于普通查询与控制。原运行系统、云端、域名 DNS 与公开 HTTPS 均未因本阶段自动切换；idms.xin 仍按备案前服务器准备范围处理。
