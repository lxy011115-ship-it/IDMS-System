# 统一工作台 R4：取消建单对账

本版本将既有取消对账领域协议与耐久作业接入统一网页。它是显式的新运行版本，当前原环境没有安装或切换。`idms.xin` 未备案，仍只进行服务器部署准备。本文件是开发与接入说明，最终图文使用手册和操作视频另行交付。

## 操作入口

统一工作台第四个模块为“取消建单对账”，地址为运行站点的 `/reconciliation/`。预测工作区中已取消且需要核对外部创建的任务提供直达入口。页面登录与其他三个模块共用。

原操作人可按原命令编号查找任务。已有对账时返回原记录；不要求用户从旧设备复制本地存储。独立审批人从当前设备权限范围的对账列表进入。本人操作列表只展示本人作业；恢复列表只保存当前浏览器的白名单编号。

1. 原操作人打开对账，明确点击“核对外部结果”。
2. 另一位当前有权限的审批人核对证据、填写意见并批准或退回。批准后保持该审批登录，直到处理完成。
3. 原操作人在独立复核后重新登录，核对固定证据并明确确认。
4. `BLOCKED` 结论不创建业务工单。实际原始流程为 `HELD` 时，确认关联原计划工单后，仍需明确开始释放。
5. “释放已开始”代表不可撤回的授权提交点。后台按原意图恢复，不再次建单。外部已推进或业务证据变化时保留“需人工处理”。

原预测任务、原计划和原取消回执保持原样。页面的“已受理”只说明作业已受理，不能等同于业务完成。

## 中断恢复

发出写请求之前，页面保存操作编号及摘要。刷新后先查询原操作，不自动生成新编号重提。未知动作可关闭原编号；已受理时返回原作业，未受理时形成迟到请求围栏。

重新授权也有独立授权编号与预期授权代数。授权回执不确定时可查询或关闭同一编号，无需恢复以前的意见正文。关闭未受理编号后，原 SQL 授权入口也不能绕过围栏。当前权限、设备范围和登录变更会清除旧视图及意见草稿；后台原记录仍保留。

本地仅保存恢复所需编号、动作、摘要、预期授权代数和状态，不保存 SID、角色、意见正文、业务结果或授权引用。清理按钮只清除已确认的本地编号。

## 显式部署

新运行不自动安装 schema 或激活领域。先在经过批准的新目标库中使用 `predictiveCancelUiSchemaSqlV1` 安装 fresh queue 扩展。它在 queue DDL 见证武装之前加入目录与授权围栏；不能向已有运行队列追加后重新计算基线。

使用已验证的 APP 部署工具 `activateReconciliationUiV1` 写入 `reconciliation_ui` marker，绑定领域配置、队列部署、数据库、目录和密钥见证。只读网页使用 QI 与 READER，执行器使用 APP 和独立外部凭据。网页配置不得包含工作流服务凭据或私有遥测来源密钥。

成员配置固定为 `format: 1`、`purpose: RECONCILIATION_RUNTIME_V1`，包含 `mode`、`queue`、`business`、`jobKeyFile`、`auth`、`authRuntimeFile`、`authDeploymentDigest`、`authAuditBinding`、`read`。`read` 只接受 `predictorBinding`、`workflowBinding`、公共 `sources`、`configuration`。WORKER 额外要求 `transport`，HTTP 拒绝此字段。所有凭据与密钥文件保持私密，不能提交仓库。

R4 站点配置固定为 `format: 4`、`purpose: SITE_CONSOLE_HTTP_R4`，包含 `baseSiteRuntimeFile`（指向 R3 配置）及每个已登记租户的 `reconciliationRuntimeFiles`。复用 R3 的审计登录、身份解析和会话状态；缺失租户、业务绑定或共享认证不一致时拒绝启动。

```text
node scripts/site-console-v4-r4.mjs <R4-private-runtime.json>
node scripts/reconciliation-worker-v1.mjs <WORKER-private-runtime.json>
```

READY 分别为 `SITE_CONSOLE_R4_HTTP_READY` 和 `RECONCILIATION_WORKER_READY`。自有进程管理器分别发送 `SITE_CONSOLE_STOP` 和 `RECONCILIATION_STOP` IPC 消息，并等待实际终态。启动失败不应自动重装 schema、激活领域或替换密钥。

## 验证范围

SQL 协议测试为 `verify-reconciliation-ui-sql-v1.mjs`。完整隔离站点与真实浏览器流程使用 `verify-site-console-v4-r4.mjs`，输入已验证的隔离工作流构建报告；原工作流 target 不重建、不替换。浏览器测试使用独立 Chrome 与 Edge 登录，测试数据与 realm 不属于原运行环境。

每轮报告记录精确源摘要与已完成检查。`verify-site-console-r4-cleanup-v4.mjs <nonce...>` 只读核对选定已完成轮次的数据库、角色、realm 和私密运行文件是否清理。失败轮次也保留报告，不能视为验收通过。

完整浏览器验收、正式归档恢复与部署切换各自需要实际证据。单元测试、构建通过或显示 READY 均不能代替它们。
