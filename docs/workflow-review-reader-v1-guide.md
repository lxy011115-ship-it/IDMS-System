# 恢复审核的独立只读工作流

本组件读取实际 Flowable 7.2.0 的既有流程，供完整恢复审批接入。它不安装表、不部署流程、不接收业务命令，也不授予人工批准或现场激活。

新应用位于 `services/workflow-review-reader-v1`。私密配置使用 `format: 1`、`purpose: WORKFLOW_RECOVERY_READER_V1`，按企业声明本机 JDBC 地址、数据库和专用角色的名称/OID、独立密码、恢复读取 token、工作流权威 ID 和原 BPMN SHA。仅支持有界完整快照；超限拒绝，不能截取部分流程后称完整。配置与凭据不得提交 Git。

启动时检查独立 reader 不持有强角色权限、成员关系、对象所有权、库 CREATE/TEMP、DML/DDL、序列写以及用户函数或大型对象执行权限。引擎使用已有 schema，禁用异步执行。每个恢复查询重新核权限，在同一数据源的 REPEATABLE READ READ ONLY 事务中核真实流程、活动任务、历史、受限变量与完整命令账本；BPMN 必须与捕获摘要一致。恢复 HTTP token 按企业独立，普通 service token 不通用。

`scripts/build-workflow-review-reader-v1.mjs` 在独立源副本中通过已认证 JDK/Maven 构建；`scripts/workflow-review-reader-lifecycle-v1.mjs` 持有实际新 JVM 的原始句柄、配置和运行包摘要，并通过原 helper 正常关闭 Spring、连接池与 HTTP。不会采用历史 PID 作为控制权。

可复现验证：

```text
node scripts/verify-workflow-review-reader-v1.mjs <pg-bin> <java-21-home> <maven-home> [offline-maven-repository]
node scripts/verify-workflow-review-reader-cleanup-v1.mjs <new-case-nonce>
```

验证在全新自有 QA 簇中用普通 Flowable HTTP 建立进行中与独立批准关闭工单，正常停止 writer，再安装本次 QA reader 并封闭原业务角色。检查真实读取、跨企业与普通 token 拒绝、实际 SQL 拒写、权限漂移拒绝、全部用户表及序列前后摘要相同、JVM 正常退出和实际数据库离线。此安装不是对已恢复目标补权限，也不是完整 cold 恢复演练。独立工具核全部固定源、原退出回执、前后摘要和实际离线状态；它没有独立离线重算全部 SQL 原始行。

完整系统仍需在受控源安装阶段声明并捕获专用 reader 的访问契约，使用显式版本的冻结/恢复策略。旧 cold V1 全角色 NOLOGIN、全库连接上限 0 的目标保持原约束，不临时 GRANT 或重定 catalog。当前根维护只允许原恢复锁连接，reader 还需实际自有 JDBC 连接能力或满足最终外态复读要求的协调顺序；不能按自报 PID、角色或 application_name 放行。

真实作者/全部贡献者/独立审核身份、完整流程复读、持久计划及审批、最终注册激活与提交恢复仍需接入。本页是开发接入说明，正式中文图文手册和实操视频尚未交付。
