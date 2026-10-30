# AI 导入发布与结果应用进展

本阶段在隔离 v4 部署接通了实际导入发布、持久 AI 任务、真实本地模型、结果业务应用和控制台。有效导入进入 AI_PENDING；签名影子结果或显式人工回退经独立应用租约转为 HUMAN_REVIEW，最终仍由独立人工批准。原站点尚未切换，完整商业目标保持 ACTIVE。

## 当前正式证据

- PostgreSQL 与故障恢复：`work/ai-import-application-pg-v4-20261020/67296610673b/verification.json`，11 项检查。
- 当前准入/配置/冲突与人工回退：`work/ai-import-guards-v4-20261020/88c40205bd59/verification.json`，11 项检查，与上一组共享 7 项基本路径。
- 真实 Keycloak/Chrome/产品 CLI：`work/ai-import-keycloak-v4-20261020/bc172ee17c8b/verification.json`。
- 10 个真实只读启动负例：同目录 `cli-negative-verification.json`，源文件运行前/结束后相同，实际 exit1、无 READY、无已知私密值输出。

所有上述进程/工具句柄均已终态。不得因历史句柄找不到而重启成功的同名验证。

## 已完成与实测范围

导入批次、冻结原生 AI intent、旧格式 IMPORT_AI_QUEUED 审计、完整候选投影、治理 COMMITTED 与 SQL 入队同 COMMIT。测试实际让 SQL 发布后入队校验失败，确认新根/治理完成/待办全部回滚，然后以同一 branch 成功发布。原 console prepare/publish 和独立 AI enqueue/result 权限已撤销，旧 SDK 不能绕过新协议。

结果保存与应用任务同事务；应用发布与 APPLIED 同事务。实际丢弃治理发布及应用发布 COMMIT 回复，并以新连接恢复根、队列和单条审计。专用代理只在观察目标发布 SQL 后截断回复，不能把只读核验 COMMIT 当作写入恢复证明。应用 worker 独立续租经过主线程 Atomics 阻塞 32 秒验证；真实子进程在第一个 stage 后 exit0，31 秒后新 worker 继续同一计划、旧 fence 拒绝且只产生一条业务审计。应用表在 replica 下的 UPDATE/DELETE/TRUNCATE ALWAYS 守卫通过。

实际本地模型使用原运行 Ollama `11435`，每组建立自己的网关、token、SQLite 与纯合成材料，固定 qwen3:4b 清单 `sha256:359d7dd4bcdab3d86b87d73ac27966f4dbb9f5efdfcc75d34a8764a09474fae7`。结果先保存而批次仍 AI_PENDING，应用后完整治理/读/console 投影与旧审计一致；原件字节/SHA 保持。AI_PENDING 不能批准，上传者不能自审，独立人工复核后只入库一条记录。JSON、原型伪造和公开六动作入口不能调用内部 AI_IMPORT_APPLY。

受控自有夹具实际改变当前租户/policy，验证零 dispatch 延后、恢复后同请求继续；结果已保存但租户挂起时不写业务。实际批次 version 冲突不采用有效签名输出，只转人工并追加冲突审计。无效/疑似指令材料不建立 outbox；停止自有网关后真实网络失败三次，显式 LOCAL_HUMAN_REQUIRED 回退也经原子应用进入人工审核。上述租户/policy/version 变化是测试夹具注入，未冒称新增了管理员写接口。

真实 Keycloak/Chrome 通过 HTTP、治理 WORKER、独立 AI WORKER、独立认证审计投递四产品入口走完原六动作、AI_PENDING 自动刷新 HUMAN_REVIEW、独立批准、CSV 原件下载 SHA、丢接受回复/刷新恢复、未知接受关闭、撤权/重授及身份切换防迟到文件。CSP/XSS、旧原件/会话隔离保持；含模型清单和证据详情的 1440/390/320 页面已核对无横向溢出，截图已视觉查看。HTTP 私密运行配置不含 AI key/service token/aiRuntimeFile。真实业务 APP/READER NOLOGIN 时退出仍 200，SESSION/outbox 原子，恢复后补一次退出审计；挂起租户有效 OIDC 不创建新 SESSION，恢复后可登录。

新 4 单位、冻结 AI 传输 4 单位及旧模板/导入/输入解析 18 单位共 26 项通过；268 原构件检查及 server/predictor 类型通过。11 个旧保持 checker 通过，包括 66 整文件契约、十轮双份/887/909、原 913 源和全部既有 v4 发布。原 core28472/owner10320/PG32152 与九服务保持；14:10 的只读 PG 点/回执/审计核对证明恢复后累计 9219 个新 ACK 逐条守恒，当前 ACK67857/pending3/seq67860 是同一次观测，不声称全队列已空。

7 轮自有环境共 30 DB/122 角色，均核对精确名称/OID/owner/零 backend 后清理，实际库存 0 残留，无 FORCE/后端终止。临时 realm、父 IPC 子进程及私密运行配置清理；正式证明目录 ACL 关闭继承、仅当前用户。未公开客户原件、私密日志、配置、密钥或 SQLite。

## 失败历史与限制

ec4b4a9cc958 首次基本路径通过至应用，最终人工批准因夹具漏传必填 comment 被原规则正确拒绝；补齐后验证继续。ae8ee85d4650 已通过人工批准，新增原子性夹具误取 branch inspection.proof.result，改为 value.result。6a721ab957cc 的首 COMMIT 代理截断了只读 branch inspection，不能当组合写入恢复证据；已新增只在目标写函数后截断的代理，最终 67296610673b 通过。

首轮 UI 9bb972822a7a 通过至真实撤权/重授，随后 locator.click 超时；当时只保存短摘要，未还原具体点击根因。新增阶段定位与私密详细栈后，当前 bc172ee17c8b 全程通过，产品代码没有为该超时放宽检查。不能宣称该次超时根因已经修复或生产 UI 稳定性已充分量测。该失败环境和配置也已清理。

CLI 负例初次临时文件名称冲突，未启动相应产品，finally 已删除自有文件；改用独立 material 名后，两次 10 负例均过，只采用与最终 UI 同目录的当前证据。

仍有完整 payload/候选根成本、历史 branch/RESULT_READY 与 APPLIED 保留增长、全局 CPU/内存/磁盘配额、100 批次演示限制、配置/密钥轮换与完整备份恢复、管理员解除历史待办及更多业务更正场景等待续。未在原业务站点部署，不把当前通过等同于全商业验收。下一阶段继续其余领域写者与统一审计，随后整体保值升级；UI 首次超时稳定性也保留为后续复核项。

选定源码及其根对应文件发布后冻结；成功的一次性 record/startup/deploy 禁止重跑。可重复运行本阶段 check-progress.py 和只读 verify-ai-import-cleanup-v4.mjs；后续新行为使用新模块或明确修订。
