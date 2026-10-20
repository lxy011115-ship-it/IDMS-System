# 流程与 AI 后台任务领取、续租和接管

更新：2026-10-16。原平台已部署 `leased-fenced-outbox-v1`，地址为 http://127.0.0.1:4010/?view=data-center 。完整商用方案 A 继续进行，生产发布门禁关闭。

## 当前行为

两个核心不再仅凭各自的 busy 标记读取同一条待处理任务。流程和 AI 分别通过 PostgreSQL 短事务领取到期的 PENDING 任务，使用 `FOR UPDATE SKIP LOCKED` 跳过已被锁定的行。每次领取保存核心实例 UUID、随机领取 token、递增的 bigint fence、数据库时间及 30 秒租期，每 10 秒续租。

成功回执和失败处理都在企业业务事务内重新锁定任务行，校验原任务 ID、owner、token、完整 bigint fence、有效租期与冻结请求内容。只有仍持有有效领取的处理者能够修改业务、审计、任务状态和失败次数。校验后的行锁保持到事务结束，租期在事务内到期也不能让另一个处理者穿过该锁同时提交。旧实例的迟到成功、迟到错误和清理操作不能覆盖新领取者。

领取与心跳使用每企业最多 2 条连接的独立低权限连接池。网络等待期间不持有数据库事务或企业业务锁；每种服务每核心最多 2 个活动任务，流程与 AI 合计最多 4 个，按企业轮转。worker 查询有 3 秒服务端语句超时、4 秒客户端查询超时和 1.5 秒连接超时；业务连接增加 20 秒空闲事务及客户端查询期限。连接异常使当前事务失败，续租失败使当前领取失效，不退回内存所有权。服务异常按企业记录。

正常关闭取消网络请求并有条件释放自己的领取；进程被杀或连接不可用时依赖数据库租期恢复。SQL 持久化失败保留原命令，不作为模型或流程服务失败计数。人工重试仍保留原 command ID 和单调 fence。

网络投递保持至少一次语义。服务已提交而核心没收到响应时，新核心用原 request/command ID 取回持久回执。不能由租约推导出跨服务物理恰好一次。Flowable 的原权限、版本、维修证据和独立终审保留；AI 仍是固定模型的 SHADOW 审阅，转人工复核后才能由独立人员终审。

## 迁移与运行

数据库迁移版本现在为 **4**；领域实体布局仍为 **3**、兼容视图 payload 为 **2**、独立认证库 schema 为 **1**。v1/v2/v3 的实际校验和保持不变。

v4 只给 `workflow_outbox` 和 `ai_review_outbox` 增加 `worker_id`、`claim_token`、`claim_fence`、`lease_until`、`claimed_at`、一致性约束与待领取索引。历史任务的原冻结请求、状态、失败次数和回执不变，新增 fence 初值为 0，其余领取字段初值为空。启动检查要求有效 v4 迁移、列类型、约束和必要索引；业务启动不执行 DDL。

升级顺序是先完成加密备份及隔离恢复，停止旧核心与所属后台服务，再由独立部署进程执行 `npm run postgres:migrate`，核对保值证据后统一启动新核心。旧 worker 不识别租约，因此不能在迁移期间混跑旧新核心。多核心必须使用相同的业务库、认证库、公开 Origin 和上游服务绑定。当前本机启动器默认只启动一个核心，双核心专项使用隔离库验证，不代表已部署生产集群。

原 acme/sandbox 已实际升级。停机迁移前后完整 payload、每张历史表、旧迁移记录和审计前缀的摘要相同；在线阶段只允许认证审计及原 sandbox 模拟采集继续追加，并核对旧采集前缀。原 acme 仍为 6 批、0 工单，业务和导入摘要未变。升级前建立的同一 SID/CSRF 继续有效，设备/测点 JSON 相同；升级后 acme 的 29 表加密备份及隔离恢复通过。认证库与密钥仍不在该业务备份范围。

## 复现与证据

```powershell
npm test
npm run build
npm run workers:leases:verify
npm run workers:verify
```

`workers:verify` 顺序运行原生租约测试、真实 Flowable 与真实本地模型的双核心专项，创建并清理自己的 QA 数据库、角色、Keycloak 用户和私密配置，不把合成业务写进原企业。原生测试覆盖 v3→v4 保值、12 路抢占、数据库时间、续租、超大 bigint fence、回滚、旧领取释放、正常关闭、索引缺失及已借出连接中断后的事务恢复。

真实双核心专项覆盖另一企业并行处理、稳定租约一次投递、业务锁等待期间独立心跳、过期后的迟到成功/错误、真正杀掉持有者并等待真实 30 秒租期、原 ID 持久回执恢复、一次业务/审计落库。Flowable 测试在维修独立终审已提交但响应未返回时杀核心，接管后正常关单；AI 接管后仍拒绝上传者自审并由独立审批人完成终审。

主要证据：

- `outputs/worker-ha-verification.json`：一次完整专项的聚合结果及三个子证据时间。
- `outputs/worker-lease-verification.json`、`outputs/workflow-worker-ha-verification.json`、`outputs/ai-worker-ha-verification.json`：可独立复现的子证据。
- `outputs/worker-upgrade-offline-verification.json`、`outputs/worker-upgrade-live-verification.json`：原库停机迁移和在线保值证明。
- `outputs/live-worker-upgrade-verification.json`：升级前同一浏览器 SID/CSRF 与查询结果保留。
- `outputs/live-data-management-verification.json`、`outputs/live-backup-verification.json`：实际页面与业务恢复证据。

本批 110 项单元测试、64 项运行文件及全部脚本/TypeScript 构建通过；角色、更正、设备类型、质量、采集、共享会话、领域双核心、数据中心与导出回归通过。读取容量参考保留原连接超时，避免新的业务空闲事务期限改变旧参考的测试条件。

## 继续完成的商用范围

本批验证单一权威 PostgreSQL 上的核心进程故障接管，数据库、认证、Flowable、模型服务自身的集群切换与网络分区验收仍未完成。冷校验/写入工作区、全局队列、更大规模/长时/内存/吞吐、受管秘密及 key 退役、TLS/SSO/MFA、跨服务 PITR/RPO/RTO、真实现场只读设备、时序/对象/搜索/事件通知、真实标签/RUL/模型评测、插件制品与运行、SaaS/私有化控制面、许可/配额/计费和客户 UAT 继续。
