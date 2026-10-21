# 旧预测根读取迁移（WIP）

本工具处理旧 SDK 原生根缺读取标记和索引的问题。输入必须是明确的旧五字段 predictive 标记，且模型、来源和两项服务绑定与旧部署摘要完全一致；已是新版本、不同配置或已有迁移中的根均拒绝重新准备。不会修改运行库 DDL，也不会自动接管旧作业。

私密配置精确包含 `format:1`、`purpose:PREDICTIVE_READ_MIGRATION`、`account`、`binding`、`predictorBinding`、`workflowBinding`、`sources`。account 为该目标的行政迁移写账号，binding 为实际数据库/角色/目录绑定；sources 仅传公开来源描述，不包含签名或服务密钥。使用前停下该目标的旧预测写者并核对未确认的外部请求。UPDATING 阻止领域发布，但不能撤销已经发往外部服务的网络请求。

使用以下顺序，所有路径由操作者明确指定：

```
node scripts/predictive-read-migration-v4.mjs plan <private-config> <new-private-plan>
node scripts/predictive-read-migration-v4.mjs apply <private-config> <same-private-plan>
node scripts/predictive-read-migration-v4.mjs status <private-config> <same-private-plan>
```

`plan` 只读核对全量业务、历史审计和原队列每个位置，写独占创建的私密计划，不改业务根。配置文件上限 2 MiB，计划文件上限 64 MiB。SDK 也可单独调用 `begin` 和 `step`；CLI `step` 仅推进已经开始的迁移。每批至多 60 个数据操作、6 MiB，加一个同事务检查点，遵守底层 64 操作/8 MiB 限额。

`apply` 首次重新生成并核对计划全文，以原根 CAS 置 UPDATING 并增加 epoch。每个批次核对实际 SQL 收据与当前根、前修订和精确批次进度；中断后沿原计划继续，已提交但回复丢失时按原命令收据恢复。出现旁路写入会拒绝继续并保持停写，需要人工核对，不能通过重算计划摘要跳过冲突。完成后按原计划一次发布读取版本、来源摘要、旧根基线、系统迁移审计和回执，再恢复原控制阶段。完成后原计划重放不重复迁移，也不改后来业务写入。

设备任务索引保留所有原生作业，分析快照关联指向原 predictive_result 证明的初始完成者；后续复用分析不会替换原申请人。旧 episode 只有在原生分析、建议实体和关联关系核对后才补 recommendationId。没有原生 episode 的历史告警仍显示历史待对账，不能自动复核。

没有 SQL host 的作业仅新增 `authority:NONE` 的待对账元数据；原身份、UUID、状态、计划和 Flowable 信封保持。所有待建单作业都保守标记外部创建可能已开始，后续必须以原执行者重新授权和原命令恢复，不能直接换 UUID 或补造成功/取消。**宿主作业接管及 workflow outbox 迁移仍待后续阶段。** 不应运行裸 SDK 队首 worker 来执行这些历史作业。

验证夹具附带五个字节不变的旧 SDK 模块及来源 SHA 清单，避免依赖未纳管的历史 work 源文件。真实 QA 仍要求本机既有私密 PostgreSQL 配置和既有只读原件夹具；所有新库/角色使用独立随机命名。源码快照仅用于验证，不是生产入口。当前活动站点没有执行本迁移；本阶段不代表整站切换、容量或商业验收。
