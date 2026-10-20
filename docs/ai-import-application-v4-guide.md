# AI 导入发布与结果应用 v4

本模块把已验证的传输层接入实际导入治理。有效批次经原解析、映射、设备类型和更正规则后进入 `AI_PENDING`；完成影子审阅或人工回退后进入 `HUMAN_REVIEW`。只有独立人工审核人携带当前权限、版本、快照和复核依据才能批准并入库。模型结果不授予批准权限。

## 两段原子事务

治理准备在完整候选根中生成批次、gateway 元数据、`IMPORT_AI_QUEUED` 旧格式审计、原生冻结 intent 和全部治理/读/控制台投影。`publish_ai_console_v4` 先运行原受保护发布，再核对该新根 intent 与队列 header、版本和快照；最后在同一事务入队。任一校验失败会一起回滚业务根和治理 COMMITTED。旧 console prepare/publish 和独立原生 AI enqueue 的 APP 执行权限均撤销。

模型调用发生在维护围栏外。传输结果保存时，新 `record_import_result_v4` 同事务创建应用任务；旧 `result_v4` 直调权限撤销。传输终态 `RESULT_READY` 表示结果已保存，应用任务 `APPLIED` 才表示业务根已采用或已记录人工冲突。控制台创建作业 COMMITTED 仅表示创建操作完成，不能当成 AI 或人工批准完成。

结果应用有独立租约和分段恢复。受信证明由当前数据库 claim、密文、原 HMAC/模型清单及原生 intent 验证产生，JSON、原型对象或用户声明 SYSTEM 都不能从公开入口调用 `AI_IMPORT_APPLY`。内部请求采用固定 SYSTEM actor 命名空间，和 USER 六动作回执分离。发布时核对内部回执、branch/publication、原请求及 outcome digest，并把新业务根和 SQL APPLIED 一起提交。未知 COMMIT 查持久结果，不生成第二条业务审计。

该应用仍使用完整 payload 重建、不可变操作分组和 branch 独立核验。没有声称这次消除了全图线性成本、完成所有普通写者的有界依赖，或建立生产 SLA。

## 输入冲突与失败

结果应用再次核对当前租户 ACTIVE、当前原生 AI policy、批次状态/版本/快照、重新计算的输入摘要和原请求 ID。版本冲突时不采用模型输出：仍在 AI_PENDING 的批次转人工，追加 `IMPORT_AI_INPUT_CONFLICT`；已批准的批次不被回写。处理结果本身记录 APPLIED，表示冲突已明确落账。

本地网关签名的 POLICY 回退保留其来源。连续三次网络失败导致的本地回退单独标记 `LOCAL_HUMAN_REQUIRED`，生成 `IMPORT_AI_HUMAN_REQUIRED`，不伪造网关签名或声称模型运行成功。无效和疑似指令材料沿用原规则/人工路径，不建立 AI outbox。

当前租户挂起或 policy 改变会延后传输/应用。已保存回执不会丢弃，恢复后仍处理同一冻结请求。policy 变更不会把历史签名重新绑定到新模型或新密钥；正式轮换/迁移协议和管理员人工解除机制仍需后续完成。测试中的租户/policy/版本变化是受控自有数据夹具注入，不是新实现的租户管理写接口。

## 运行入口与权限

- `scripts/ai-import-application-schema-v4.mjs`：仅创建新隔离部署。两套队列扩展必须在 DDL epoch 触发器启用前完成，不能反复安装到已有 schema 或直接刷新目录 hash。
- `scripts/governance-ai-auth-v4.mjs <私密运行配置>`：HTTP 或治理 WORKER，复用原真实 JWT/PKCE/CSRF、加密 PG SESSION 和认证 outbox。HTTP 只持 QI、READER、作业密钥与所需认证配置，不允许携带 `aiRuntimeFile`，无 AI 根材料或网关 service token。WORKER 通过私密 `aiRuntimeFile` 加载绑定 AI 服务配置。
- `scripts/ai-import-worker-v4.mjs <私密运行配置>`：独立 AI 传输与应用进程，只拿业务 APP、AI 根材料/网关 token 和公共来源注册表，不需要 SESSION master ring 或认证 APP。先应用已有结果，再派发下一请求。父 IPC `AI_IMPORT_STOP` 会等待当前任务和独立续租线程结束。

AI 配置格式为 `format:1, mode:AI_WORKER`，包含 source.account、AI binding、stateBinding、keyFile、固定 gateway，以及 sources。密钥文件格式为 `format:1, purpose:AI_IMPORT_TRANSPORT_V4_1`，key 是规范 base64url 编码的 32 字节材料。数据库/角色 OID、目录、policy 和 key witness 都必须与部署匹配。数据库连接须显式配置，远程必须验证 TLS；模型网关继承当前仅本机固定地址/模型协议。

每条应用任务使用数据库时间的 30 秒租约、10 秒独立线程续租及递增 fence。调用者停止续租不等于取消业务计划；新 worker 取得过期任务后可从同一 FENCED/PLANNED 与已 stage 分组继续。过期 lease 无法再准备或发布。主线程进行全图验证时，独立线程继续续租。

服务账号仍是绑定业务 APP，因为原状态映射按 session_user OID 限定 APP/READER。新模块不声称额外 AI LOGIN 角色能靠 GRANT 直接复用该写接口，也不声称可以防御已控制业务 APP 的任意恶意服务代码。服务拆分、跨 OS 身份、密钥轮换和完整备份恢复仍另续。

## 控制台与核验

新控制台使用 `public/governance-ai-v4.*` 与原 CSS。批次详情会把 AI_PENDING 自动刷新到人工复核，展示固定模型清单、抽样范围和证据。重新读取结果时保留身份 epoch、当前角色/范围验证；不把原件、token、回执或业务结果写入浏览器恢复存储。公共输入仍只有原六动作，不接受客户端 aiMode 或内部 apply。

隔离验证器：`verify-ai-import-application-v4.mjs` 检验实际导入/模型/批准与发布丢回复、实际子进程 stage 后退出/接管/续租；`verify-ai-import-guards-v4.mjs` 检验当前租户/policy、版本冲突、规则路径和网关离线人工回退；`verify-ai-import-keycloak-v4.mjs` 检验真实 Keycloak/Chrome/产品 CLI 与控制台；`verify-ai-import-cli-negative-v4.mjs` 仅运行拒绝启动路径，检查不输出已知私密值。

所有验证使用独立 DB/角色、独立 realm、独立网关 token/SQLite 与合成数据。原 acme 六份文件只作只读克隆校核。清理按自有精确 OID、owner、零 backend 执行，无 FORCE 或后端终止。只读 `verify-ai-import-cleanup-v4.mjs` 可以复核残留，不能用于删除。

原运行站点没有部署这些模块。完整商业目标中的其他写者、保留/配额、全图性能、统一审计、原站点升级、现场/HA/PITR/TLS-MFA/RUL/许可等仍继续，不因 AI 子系统完成而标记整项目完成。
