# v4 预测与新工单内核

当前是受信宿主 SDK 开发阶段，入口为 `PredictiveMapV4` 与 `PredictiveWorkerV4`。尚未提供面向用户的预测 HTTP、SQL 租约队列、真实共享会话解析和页面。不得把本阶段直接替换为站点默认入口，或把测试回调当成生产身份验证。

宿主须使用绑定当前企业数据库和目录的 APP 账户，提供固定预测器、Flowable 绑定及服务器配置的公开采集来源；必须每次重新解析原申请人的当前身份、权限、范围与有效截止时间。历史 context 仅为证据。`activate()` 要求先激活既有维修目录。

`submit(request, commandId, context)` 接受两种小请求：

- `ANALYZE`：设备编码、`APPROVED_IMPORT` 或 `TELEMETRY` 来源；后者需服务器已配置的 edgeId。禁止提交原始测点、actor 或服务地址。
- `REVIEW`：alertId、expectedVersion、evidenceDigest、`APPROVED` 或 `RETURNED`、复核意见。申请分析的人不能复核自己的告警。

服务端冻结已批准导入事实，或已通过原签名接收器、历史治理审批、原始点和回执证明的采集事实。保持原工程规则 `engineering-health-rules-1.0.1`：三标签各至少 6 个 GOOD 测点，18–600 点和原窗口约束。没有故障概率、置信度或剩余寿命输出，FIELD 仍受既有治理限制。

独立规则服务可通过 `node scripts/predictor-service-v4.mjs <private-config.json>` 启动。私密配置格式为 `{format:1,purpose:"PREDICTOR_SERVICE",host:"127.0.0.1",port,serviceToken}`，token 长度 32–4096。私密文件不得进入 Git。HTTP 响应必须与固定模型的完整复算结果相符，网络失败不使用本地计算冒充远端成功。以子进程运行时，通过 IPC `PREDICTOR_STOP` 排空退出。

批准复核只冻结创建意图和 Flowable 信封。真实引擎确认前没有可维修的本地工单；确认后一次 CAS 发布工单、集合索引、维修关联、告警和建议、审计与作业回执。随后交给既有 MaintenanceMapV4 领取、开始、结构化提交和独立终审。

同一原人及 UUID 复用同一请求；相同 UUID 不同正文拒绝。真实服务允许重发同一信封，本地回执只应用一次。发送前、真实响应后、最终发布前重新授权；本人 `regrant` 增加 revision，旧响应不得写入。网络失败持久指数退避，7 次后人工处理；`retry` 可以由另一名有权限的人发起，但保留原人和创建信封。`inspect` 返回给受信宿主的计划包含业务事实，不能原样作为公开 API 输出。

本阶段仍有明确边界：输入和业务规划依赖完整 payload 重构，最多 60000 键、64 MiB 值和 6000 个候选采集事件；不是高吞吐或生产容量证明。SDK 队列存在队首等待，不是 SQL 租约调度。数据不足可以完成为人工审阅结果，不生成虚构评分。旧无原始申请人证据的告警要求对账，不自动追认。

验证入口 `node scripts/verify-predictive-creation-v4.mjs` 创建新的专属资源。已经成功的历史运行不要重复当作部署执行；只读清理复核为 `node scripts/verify-predictive-creation-cleanup-v4.mjs`，运行它前先确认没有本阶段验证仍在执行。
