# AI 审核持久传输 v4

新增模块提供持久请求、独立续租 worker 和只写一次回执。当前终态 `RESULT_READY` 的含义是**回执已保存，尚未应用到导入批次**。本阶段没有新增公开 HTTP 路由或替换现有控制台，也没有切换原业务库。

## 使用边界

`scripts/ai-review-transport-schema-v4.mjs` 只安装到新建隔离部署，使用 NOLOGIN owner 和现有业务 APP。不能把它当作对原库可重复执行的升级脚本。目录、角色/数据库 OID、ALWAYS 触发器和非 MVCC DDL epoch 都属于绑定；DDL 后必须走独立迁移验证，不能直接更新期望 hash。

`buildAiReviewRequestV4` 从解析后的批次生成冻结请求。最多均匀抽样 12 行，保留物理行号，长摘要按 UTF-8 码点截断并计算实际字节摘要。`fullContentReviewed` 始终为 false。网关配置只允许显式本机 `127.0.0.1` 端口、qwen3:4b 和固定 sha256 清单；配置指纹覆盖 token 摘要、提示和政策版本。该限制继承当前本地网关协议，不支持远端明文或动态模型选择。

`AiReviewCryptoV4` 使用独立 32 字节私密根材料派生 AES-256-GCM 密钥。请求、结果和密钥见证采用不同 AAD。部署/数据库/租户/请求/批次/快照/版本/配置变化会拒绝解密或验收。此材料及网关 service token 均不得放在浏览器、公共输出或业务审计中；同 OS 用户仍可读取其私密进程文件，不声称跨 OS 身份隔离。

`AiReviewSourceV4.enqueueInTransaction(client, request, batchVersion)` 要求调用者已 BEGIN，SAVEPOINT 会拒绝 autocommit。SDK 入队先按 state-map 1 → governance 2 → AI 4 取共享锁；SQL 原生入队也先取 1/2。调用者负责将最终业务根和 outbox 放入同一事务，并负责提交后的组合业务证明。独立 `enqueue` 适用于已证明的来源或隔离验证，**不能代替导入发布的原子接线**。任何能够调用此 API 的进程都必须是受信服务；API 不把任意 UUID 当成批次存在证明。

源 SDK 每次操作新建连接，检查 OID、目录和 key witness；同 UUID 的 header 冲突被拒绝。密文随机化不影响同请求重放，原密文保持。入队和结果未知 COMMIT 会用新连接查持久事实；回滚状态或不同结果不能伪装成成功。

## Worker 和结果

`AiReviewWorkerV4` 必须传入 `admit(header)`：从当前受信业务状态读取租户 ACTIVE 和当前配置指纹，不接受历史提交人的角色代替这一步。当前模块没有内置生产准入适配器；验证夹具的常量 admit 仅用于合成 QA。

领取使用数据库时间的 30 秒租约、递增 fence/随机 owner/token。独立 worker thread 每 10 秒续租，模型请求 130 秒超时；过期 fence 不能续租、计数、延后或保存结果。当前线程停止前会结束续租。

dispatch 次数与网络失败计数分开。429/500/502/503/504、连接失败或请求超时计为网络失败，三次后保存 `LOCAL_HUMAN_REQUIRED/NETWORK_ATTEMPTS_EXHAUSTED`。领取、准入延后、保存中断不消耗该预算。单次 fence 的 dispatch 与网络失败计数都幂等。多次已收到回执但未保存的进程中断可能产生超过三次 HTTP 请求；同请求由网关 SQLite 重放，不能宣传推理恰好一次。

永久 HTTP 拒绝保存 `GATEWAY_REJECTED`；回执 JSON/HMAC/证据/模型名/清单不符合要求保存 `GATEWAY_RECEIPT_INVALID`。本地回退不是网关签名回执，不能伪称已成功运行模型。网关自己的 POLICY 回退保留其签名和来源。SQL/保存异常单独延后并保留冻结请求，不转换成模型成功或新的推理失败。

所有结果要求人工审核；即使签名内容是 SHADOW_REVIEWED/NO_OBJECTION，也不具备批准或实际入库权限。结果业务应用器尚待接线：必须核对当前批次版本/快照，维护治理、读和控制台投影，追加旧格式业务审计并记录唯一应用回执。不能只修改批次字段后宣称 v4 根完整。

## 验证与运维

单位测试：`node --test server/ai-review-transport-v4.test.ts`。

实际隔离验证器：`scripts/verify-ai-review-transport-v4.mjs`，每次分配新 nonce/资源并先保存源字节 SHA。已成功的验证不应为观察超时而重新启动；先看终态、verification 和 cleanup。验证读取本机 PostgreSQL 管理配置，仅创建自己的 DB/角色，并通过自己网关连接已运行的本地 Ollama `11435`，不启动或停止原模型服务。合成材料和独立 SQLite 不使用客户原件。

清理只按本轮精确 DB/角色 OID、owner 和零 backend 执行，无 FORCE/后端终止。私密配置只精确 unlink，不递归删除 work 目录。只读清理复核器可重复运行；它不删除残留。

未完成：导入发布原子接线、结果业务发布/审计/控制台、独立产品 CLI/真实 OIDC 场景、完整备份恢复与密钥轮换、历史队列迁移及保留策略。当前每库 10000 条未完成传输背压阈值未进行满量实测；RESULT_READY 不再占用该计数，但会持续占用存储。没有生产 SLA、总内存/磁盘配额或商业验收结论。
