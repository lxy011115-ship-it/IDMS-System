# v4 预测持久队列协议

当前实现的是 PostgreSQL 协议和受信宿主 SDK 适配基础，尚未实现真实共享会话的预测 HTTP、独立产品 worker、人工重试控制与页面。不得直接用本阶段替换默认站点或把测试 context 回调当作 OIDC。

`scripts/predictive-jobs-schema-v4.mjs` 只在新的、已归属并安装 state-map 的部署中安装额外 `predictive_jobs_v4` namespace；继承冻结队列保护，再增加预测原生回执校验和外部发送边界。安装方提供已核验的 tenant、owner、worker、ingress 和 deployment，不自动建立生产角色或修改已有协议。

HTTP 宿主将使用 QI/READER；QI 没有业务读取、写入、领取权限，APP 不能走 ingress 入队或旧分支发布入口。命令与授权引用使用不同 HKDF/AES-GCM 用途，密文绑定企业、数据库、部署、作业、原人、请求和授权 revision。当前单位测试只证明密文读取旧密钥/使用新活跃密钥，数据库启动密钥 witness 和完整轮换仍待补。

`PredictiveJobStoreV4` 绑定数据库、会话角色与实际目录指纹，提供 enqueue/find/read、未知接受 close、authorize、claim/renew/checkLease、prepare、startExternal、settle、finish 和受限 cancel。实际宿主仍需调用既有真实身份解析；数据库检查的是已由宿主解析的 deadline 与授权 revision，不自己验证 JWT 或角色。

claim 使用 SKIP LOCKED 领取具体作业，WAITING_AUTH/HUMAN_REVIEW 不阻挡之后可运行作业。独立 `startPredictiveHeartbeatV4` 线程维持 30 秒租约；SDK 宿主必须使用领取的具体作业，不能通过普通 SDK 队首误调度另一个命令。

SDK 的 commit hook 应交给 `prepare`，而不是直接调用 APP 的通用 delta：准备阶段校验原生 SDK 作业身份与请求，SQL 保持 RUNNING；完成阶段必须有相同请求/计划摘要、结果、真实审计和 `receipt predictive:<businessKey>`，一次事务使业务及队列 COMMITTED。缺回执或错身份/空状态的真实写入回滚。ANALYZE 完成审计可以由 RULE 执行，SQL 另核对原申请人 metadata，不能误把规则执行者当成人。

真实 Flowable 发送前必须提交 `startExternal`。此标志单调保留，后续原人重授不能抹去可能已发送的事实。发送边界后 close 只关闭同 UUID 接受，返回 recoveryRequired，保留原租约供原命令恢复；请求取消被拒绝。外部服务允许原信封重放，本地一次应用，不保证网络恰好一次。

当前 cancel 仅支持尚未产生 SDK 作业的请求。SDK 已准备后的取消明确返回 `PREDICTIVE_SDK_CANCEL_REQUIRED`，不能假报取消成功。HUMAN_REVIEW 也不能通过普通 authorize 自动恢复；独立复核的 retry 控制及原授权解析还需接入。产品宿主完成前禁止将这些底层方法直接公开。

`settle` 从已证明的 SDK 状态保存人工/授权等待或实际网络退避；不会把旧 grant 自动复活。实际写 COMMIT 回复不明时 `prepare` 通过原生 state-map 请求摘要和回执恢复，不能重建新命令。

验证入口为 `node scripts/verify-predictive-console-pg-v4.mjs`，每次创建新的专属资源；在 Windows 本机运行时需正确使用现有 native runtime 路径。只读清理复核 `node scripts/verify-predictive-console-cleanup-v4.mjs` 仅应在所有相关验证终态后运行。原始实例和历史成功的 startup/record/deploy 脚本不可重跑。
