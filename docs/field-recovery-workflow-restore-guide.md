# 非空工作流与核心归档恢复验证

本验证把核心工单、工作流outbox、真实Flowable和恢复审批放在同一隔离组合中。它验证核心35个关系的归档恢复后，是否仍与正在运行的独立Flowable一致；不代表Flowable数据库本身已从备份恢复，也不授予FIELD激活许可。

运行自有回环QA：

```powershell
$env:IDMS_FIELD_REVIEW_QA='1'
$env:IDMS_FIELD_REVIEW_UI_QA='1'
$env:IDMS_FIELD_REVIEW_WORKFLOW_QA='1'
node scripts/verify-field-recovery-external.mjs
```

该模式只创建带随机命名空间的测试库、角色、身份客户端和用户。原始告警为明确测试夹具，工单通过实际业务函数、PG事务、WorkflowService及持久outbox产生，使用当前QA身份的用户ID和相符角色。维修人使用有设备范围的maintenance-engineer；受OWN_TASKS限制的operator不能用于领取未分配任务。恢复计划作者和独立审批人的身份再由真实Keycloak PKCE和当前权限核验取得；不能把直接调用业务函数的夹具生成描述成人工在业务浏览器中创建工单。

四种状态为UNASSIGNED、IN_PROGRESS、AWAITING_APPROVAL、CLOSED，共15条已同步冻结命令/回执，包含领取、开始、提交维修证据、不同主体退回和终审。seed进程等待worker排空后退出，源库才持久冻结和归档。恢复期间源库不可连接；恢复工单逐字节等价，证据摘要、请求摘要、回执及最后命令绑定保持。

恢复后通过只读事务查询当前独立Flowable，核对4个case、3个活动流程、1个结束流程、任务、变量、历史、定义和全部命令摘要。真实CLI恢复计划/独立审批以及浏览器替换计划和独立批准继续验证。最后通过真实外部流程命令推进一张工单，再从浏览器提交恢复计划应拒绝；目标根、审计、序列和32张其他实体表保持。历史APPROVED仍可只读审阅，外态状态仍需重新核对。

本轮运行证明保存于 `work/field-channel-20261017/recovery-workflow-restore-verification.json` 和 `workflow-restore-command-verification.json`，公开摘要见 `docs/field-channel-recovery-workflow-restore-progress.md`。原始日志、配置、JWT、密钥、SQL和备份不交付。

2026-10-18运行环境曾出现原进程全部终止。当前原功能通过 `work/field-channel-20261017/originals` 中431个可核对的旧运行源码和原工作流jar恢复，未部署新FIELD代码。现有数据与原迁移/导入/业务/审计基线重新核对；旧“原PID未重启”记录仅为历史证明。新运行身份位于 `work/field-channel-20261017/runtime-resume-20261018/runtime-state.json`，用同目录 `verify-runtime.ps1` 核对，不能继续用旧PID或静默替换新基线。启动没有重跑安装、迁移或默认Maven打包。

完整目标仍待新现场注册、当前外态再核对、独立激活、离线CLI/现场全链、受控切换及跨服务灾备等验收。
