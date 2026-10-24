# 安装期工作流只读身份与捕获材料

`WorkflowReviewSourceInstallerV1` 为实际 `RuntimeFenceProvisionV1` 的未 sealed 安装窗口生成新 reader；SQL 目标还必须是原 deployment、原 control 身份、正确 PGDATA 且未 finalized。既有角色、模拟 provision、调用方自报权限、恢复目标补授权均不是输入路径。

在私密 PGDATA 外工作目录创建安装器，对两个真实工作流数据库分别调用 `install(client,{tenantId,authorityId,bpmnSha256})`。reader 初始 NOLOGIN/0；安装原表只读 ACL、明确只读会话默认值，原 provision 登记 actor。失败或提交结果不明会阻止该安装器继续发放材料。普通源码不包含密码；生成的私密文件不得进入 Git。

`prepare(controlClient)` 在原 HBA 文件最前加入精确规则：仅允许该 reader 从 127.0.0.1 连接自己的数据库，拒绝其他数据库、IPv4/IPv6 和 Unix socket。保留原文件内容并保存摘要，reload 后才打开新 reader。用实际连接验证本库只读及其他企业、postgres、template1、其他可连接库的 HBA 拒绝，然后才能取得 `runtimeConfig()`。数据库名使用 HBA 特殊选择符时拒绝。

原 provision 正常 `sealAll()` 后，`capture(controlClient)` 重验原 fence 完整 catalog、reader 角色/权限/原 BPMN 与工作流权威、HBA 文件及规则，产生不含密码的 `WORKFLOW_REVIEW_SOURCE_CONTRACT_V1`。不允许在源角色已改变的冻结 profile 上把材料重新解释成新普通源。重复捕获在材料不变时得到同一摘要。

`workflowReviewFrozenInventoryV1` 是新版本协调器的无副作用投影：只给捕获 reader 保留登录/2连接及其工作流库2连接，其余原角色 NOLOGIN/0、业务库0。投影本身不执行 SQL或授予权限。旧 cold V1 与维护 V4 保持原规则，完整加密冷恢复和受控 reader SQL 连接能力尚未接入。

验证入口：

```text
node --test tests/workflow-review-source-contract-v1.test.mjs
node scripts/verify-workflow-source-reader-v1.mjs <pg-bin> <java-home> <maven-home> <keycloak-directory> [offline-repository]
node scripts/verify-workflow-source-reader-cleanup-v2.mjs <new-case-nonce>
```

实际案例包含独立身份库、两个非空 Flowable 企业和第三个业务库，真实安装/跨库拒绝/原 seal、三 fence CLOSED 与投影的 QA SQL 执行、封闭后只读服务、关闭只读默认值后的 ACL 拒写、材料漂移拒绝与原进程正常退役。独立核验重验捕获材料、原封闭回执、角色和数据库投影、业务表/序列摘要、退出回执及两处实际 PG 目录离线。业务摘要明确排除合法变更的 runtime fence 控制行；未独立离线重算全部 SQL 原始行。

独立 verifier V1 的 Windows 路径字符类匹配失败源码保留；V2 支持 Windows/POSIX 分隔符，是有效入口。此差异不改变原九项 native 输入。

后续仍需新版本 cold 控制器、当前根维护 profile、真实自有 reader 连接能力、真实作者和独立审核、持久计划/审批与最终注册激活/提交恢复。正式用户图文手册和演示视频待完整验收版制作。
