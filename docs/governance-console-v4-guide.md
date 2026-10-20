# v4 治理控制台

新增控制台将模板四动作、导入创建与独立审核接到持久作业。它使用独立的新部署协议；原 v2 站点继续运行。本阶段不对原库在线安装或切换。

## 页面与接口

入口 `/governance/`。登录使用现有 OIDC Authorization Code + PKCE 和加密 PostgreSQL 共享会话。角色、范围、租户和 CSRF 都由服务器验证。页面提供模板配置、CSV/XLSX/JSON 导入、映射及设备类型引用、更正信息、行与错误分页、原件下载、作业恢复与重新授权。

| 方法 | 路径 | 内容 |
|---|---|---|
| GET | `/api/v4/governance/context` | 当前租户、权限、阶段、导入类型 |
| GET | `/api/v4/governance/templates` | 模板摘要；status/purpose 过滤 |
| GET | `/api/v4/governance/templates/{id}` | 单份模板配置 |
| GET | `/api/v4/governance/batches` | 批次摘要；status/dataType/sourceSystem 过滤 |
| GET | `/api/v4/governance/batches/{id}` | 白名单详情与文件描述 |
| GET | `/api/v4/governance/batches/{id}/rows` | 至多 20 行，保留原物理行号 |
| GET | `/api/v4/governance/batches/{id}/errors` | 至多 100 项错误 |
| GET | `/api/v4/governance/batches/{id}/original` | 核验全部分块及原件 SHA 后流式下载 |
| POST | `/api/v4/governance/jobs` | `{commandId,command}`；持久接收返回 202 |
| GET | `/api/v4/governance/jobs/{id}` | 本人作业，按当前权限重新验证 |
| POST | `/api/v4/governance/jobs/{id}/authorize` | `{}`，恢复本人授权 |
| POST | `/api/v4/governance/jobs/{id}/cancel` | `{}`，请求取消已有作业 |
| GET | `/api/v4/governance/commands/{UUID}` | 按本人命令键恢复作业或接受关闭证明 |
| POST | `/api/v4/governance/commands/{UUID}/cancel` | `{}`，持久关闭该键的未来接受并取消已存在作业 |

所有业务接口要求 `X-Tenant-Id` 与认证租户相同。页面另发送 `X-IDMS-Actor-Id` 作为身份变化的负匹配检查，它不能提供身份或权限。Cookie POST 要求同源 Origin 与 CSRF。Bearer 仍遵循已签发 JWT 的有效期，不提供令牌有效期内的即时撤权承诺。

## 导入与恢复

六动作名称与输入结构延续 [治理作业说明](governance-jobs-v4-guide.md)。单原件 8 MiB、最多 10000 行、请求及归一化命令 16 MiB；归一化后超限也拒绝。CSV/XLSX 由服务器解析、冻结原字节和行号，文件来源规范为 MANUAL_FILE，以符合原映射规则；保留旧归一化 hash 以识别已有同键请求。当前 AI 明确要求人工审核，最终批准必须独立主体完成。

202 表示持久接收，作业 COMMITTED 表示该动作的业务根和完成回执已经发布。导入创建动作的结果可能仍为 HUMAN_REVIEW，需要独立批准动作。

网络错误后的命令 UUID 必须保留。页面仅在 sessionStorage 保存命令键、输入 hash、动作和状态，不保存原文、令牌或结果。已接收命令用原键恢复；换内容先处理旧命令。确需放弃未知请求时，服务端接受关闭与入队使用同一 SQL 锁：确认关闭后迟到请求无法重新入队。若业务已经提交，保留真实提交状态；读取结果仍须满足当前业务权限。取消保留当前读取权限即可；取消观察路径隐藏业务结果，避免权限收窄后泄露内容。

最近作业列表只代表本浏览器、当前账户保存的键，不能当作服务器全部作业列表。可手工输入命令或作业 UUID 恢复。退出、换账户或范围变化后清除旧详情及结果；未完成的文件读取会被身份 epoch 阻止提交。

## 读取与发布

治理维护候选根同时包含业务、审计、读取目录和 console 投影。投影按 generation 保存摘要、范围计数、行/错误块及原件块；发布前独立重建候选根并重新编译投影逐项比对。摘要不含整批原件或全部行。范围覆盖复用原 dataScope 语义，包括更正前值及缺失设备的回退规则。

列表每次最多扫描 48 项、返回 20 项；行页最多 20 行，错误页最多 100 项，字节预算可进一步减小页。单个异常大行可能分块，仍受响应上限约束。加密游标绑定部署、generation、主体、角色、范围、过滤和路由，30 分钟到期；治理发布或权限变化须重新加载。

原件使用 256 KiB 块，先核验完整 SHA，再重新授权、按窗口输出；浏览器再次验证下载 SHA。读取使用真实只读 PG 快照、目录绑定与成员证明，避免每个分页请求重构租户历史。

新 schema 撤销旧 worker 准备/发布与旧 ingress 入队入口，专用发布函数要求 console anchor 与新 control 一致，失败回滚整个事务。维护计划保存为不可变操作组和小头，组内至多 32 操作；头绑定所有组 hash，恢复验证同一计划。安装只适用于已排空旧作业且 ACTIVE 的新部署路径。

## 进程与边界

`node scripts/governance-console-v4.mjs <private-runtime.json>`，配置结构同前述作业 CLI，mode 为 HTTP 或 WORKER。HTTP 仅持 QI 和业务 READER；WORKER 持 APP 与冻结 sources。两者共享加密 job keyring、队列绑定和 PostgreSQL 认证部署。HTTP 绑定 loopback，由已配置公共 origin 的可信代理接入。私密配置及凭据不进入交付。

既有导入业务仍限制每租户最多 100 个批次，商业保留策略尚待替换，当前不能依靠删除历史绕过。维护准备仍会重构全部 payload 和候选根，操作组消除了单个计划 JSON 的容量瓶颈，尚未完成所有普通写者的有界依赖闭包。作业状态仍可能解密受输入上限约束的完整命令。认证审计 outbox、其他领域写者、全站迁移回归、HA/PITR、现场接入及完整商用验收继续开发。
