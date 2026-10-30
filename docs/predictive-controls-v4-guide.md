# 预测任务取消与独立重试

本修订继续使用独立预测 HTTP/worker，暂不切换原运行站点。SQL 扩展 `predictive-controls-v4.sql` 只随新部署安装，在 DDL 目录见证启用之前执行，不在已有运行库上直接修改。

## 取消与未知接受

`POST /api/v4/predictive/commands/:commandId/cancel` 正文 `{}`。先持久关闭本人 UUID 的接受，再处理现有作业。尚无作业时返回 `acceptanceClosed=true,job=null`，之后晚到请求也不能接受。返回丢失时，以原 UUID 查询，不换 UUID。

尚未记录外部发送开始的作业进入取消流程，由本人当前授权和新 lease 执行。已有 SDK 时，取消事务同时保存 CANCELLED、取消原生回执与审计，REVIEW 仅删除其自己持有的创建意图，保留原告警/建议内容。SQL 独立检查取消请求、外部发送边界、SDK 状态和原生审计后才提交 CANCELLED。当前 HTTP 会核验取消回执才显示 SDK 取消证明。

一旦 Flowable 发送开始已落库，关闭返回 `recoveryRequired=true`，不报告已取消，不撤销原命令。后续仍用原 UUID、原计划和原 Flowable 信封恢复。外部调用可能重复，不能宣称网络恰好一次。

## 独立人工重试

- `GET /api/v4/predictive/retry-candidates/:id`：具有 `predictive:approve`、当前设备范围可见且不同于原执行者的审核人读取控制摘要。
- `POST /api/v4/predictive/jobs/:id/retry`：正文 `{controlId,expectedGrantRevision}`，两项分别为本次控制 UUID 和已读到的原授权修订字符串。

审核人的当前会话引用按独立 RETRY 用途、原作业及 controlId 加密。worker 重新解析该真实身份和设备范围；原执行者不能自审，审核人不能代替原执行者执行分析或创建。

重试审核事务保持原人、完整计划、原 context 和流程信封，记录审核人/原人的独立审计及原生回执，清零网络尝试并将作业置为 WAITING_AUTH。原执行者再通过既有 `/authorize` 提供新会话授权后，worker 才可恢复原命令。审核处理期间原执行者的重授返回冲突。审核人退出或授权无效时，本次控制返回人工复核，不自动复活；新控制 UUID 代表新的明确审核。

同一 controlId 重放读取其现有结果，不重复审核。所有控制 UUID 写入不可变的决定台账；被新决定替代的旧 UUID 返回冲突，不能在多次审核授权失败后重新排队。台账触发器为 ALWAYS，复制模式也不能直接改写。SQL 检查原 SDK HUMAN_REVIEW、审核人身份绑定、原人/context/plan 不变、新 SDK revision、原生回执和审计，再与业务根一起提交。读取控制摘要中的 `reviewed` 也要核验原生回执和审计，不能仅凭队列标记认定。

这些控制接口继续要求真实 OIDC、当前企业/设备范围、Origin 和 CSRF。后续仍需设备/告警/证据读取、统一站点预测页面、真实浏览器 PKCE 和移动端验收；密钥见证/轮换、容量、旧作业宿主绑定迁移及完整商用待办继续。
