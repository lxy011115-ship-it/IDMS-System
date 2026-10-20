# v4 治理持久作业

此模块是独立的新部署路径。原 v2 站点继续运行；不能向原库在线安装 schema 或重新绑定目录摘要。完整方案 A 仍在开发。

## 接口

所有作业接口使用现有 OIDC Bearer 或共享 PostgreSQL 会话，要求 `X-Tenant-Id` 与认证身份一致。Cookie 的 POST 还要求现有 Origin 与 CSRF 校验。

| 方法 | 路径 | 行为 |
|---|---|---|
| POST | `/api/v4/governance/jobs` | `{commandId,command}`，持久 COMMIT 确认后返回 202 |
| GET | `/api/v4/governance/jobs/{id}` | 本人作业，重新检查当前角色和领域范围 |
| POST | `/api/v4/governance/jobs/{id}/authorize` | 空 JSON 对象，更新加密授权引用并使旧 claim 失效 |
| POST | `/api/v4/governance/jobs/{id}/cancel` | 空 JSON 对象，请求取消；本人保留 read 权限即可 |

`command` 为 `{action,id?,input}`。支持 `TEMPLATE_CREATE/EDIT/SUBMIT/APPROVE`、`IMPORT_CREATE/APPROVE`。业务批准、版本摘要、自审限制、更正链和范围继续使用既有规则。相同租户/主体/command UUID 固定一个作业，请求内容变化返回冲突。

导入 JSON 使用 `input.rows`，原件由服务器规范生成，历史行号延续既有从 2 开始的约定。文件使用 `input.file={filename,base64}`，CSV 必须为 UTF-8，XLSX 只能有一个 `data` 表，禁止公式、链接、复杂单元格、宏及超限归档；原字节、物理行号和表头由服务器冻结。客户端不能提供 `originalBase64`、AI 判断、解析行号或授权上下文。单文件 8 MiB、请求及归一化命令 16 MiB、最多 10000 行；归一化后超限也会拒绝。映射和设备类型引用由既有业务规则核验。AI 当前明确不可用，导入要求人工审核补充说明。

202 仅表示作业持久接收。`job.businessCommitted` 只有在最终业务根和队列状态于同一 PG 事务提交后才为 true；导入创建成功后的结果仍可能为 HUMAN_REVIEW。接口不会返回加密盒、授权引用、租约 token 或原始输入。结果必须从当前根中的不可变完成回执及对应发布回执核验，状态读取不重构租户全历史。

## 执行与恢复

队列位于同一租户 DB 的独立受保护 schema，不进入业务 SMT。否则 PLANNED 后更新队列会破坏准备根的 base CAS。新 schema 生成器 v4 在保护触发器安装前移除 APP 对原始 branch publish 的执行权；队列 owner 只在持有有效 claim 时发布。旧 schema 源不修改。

真实数据库时钟租约为 30 秒，独立 worker thread 每 10 秒续租，主线程进行维护 CPU 工作时仍可续租。队头严格按 ordinal 执行，WAITING_AUTH 阻止后续作业，等待本人重新授权或取消。重新授权递增 grant revision 和 fence。准备阶段的每次公开根修改及最终发布都在同一事务核验 claim；只保护最终发布不足以阻止取消后的旧 worker 再次设置 UPDATING。

最终发布在同一 SQL 事务内调用 branch publish、验证根内完成回执并写 queue COMMITTED。取消在同一事务写不可变取消回执、恢复原 ACTIVE 和写 CANCELLED；已提交的业务返回真实提交结果。提交回复丢失先按固定键用新连接核验，无法确认时返回 UNKNOWN/503，不伪造成功。重试不把网络错误当作确定业务失败。

授权引用经独立用途的 AES-GCM 加密，绑定部署、数据库 OID、租户、作业、主体、请求 hash 和授权 revision。角色不持久化为执行权限；每次阶段与提交前都由原认证实现重新验证。共享会话能刷新并观察角色变化；Bearer 受已签发 JWT 的有效期约束，不声称有效期内角色即时撤销。心跳仅续租，不代替授权。

## 独立进程

`node scripts/governance-jobs-v4.mjs <private-runtime.json>` 使用显式私密配置，`mode` 为 HTTP 或 WORKER。HTTP 配置只包含 QI 和业务 READER 凭据；WORKER 包含 APP 和冻结的 source registry。两个进程使用相同 job key ring、队列部署绑定及共享认证部署。启动时核验数据库/角色/目录绑定和最小权限，认证存储禁止退回内存。

配置字段：`format:1`、`mode`、`queue:{account,binding}`、`business:{account,binding}`、`jobKeyFile`、`auth`、`authRuntimeFile`、`authDeploymentDigest`。HTTP 额外设置 loopback `host`、`port`，由已配置的可信公共 origin 前置代理；WORKER 额外设置 `sources`。所有密钥、密码及配置文件留在私有目录，不加入交付。退出只排空本进程，不停止原平台。

## 当前边界

维护内核仍会完整重构、编译和独立验证候选业务根。这解决大事务分段、持久恢复和一致发布，尚未完成全部普通写者的增量闭环与全局内存/CPU 配额。当前六动作覆盖不代表其他领域已集成；原站点切换、用户界面、真实 AI outbox、跨服务 HA/PITR、现场接入和完整商业验收继续按总待办推进。
