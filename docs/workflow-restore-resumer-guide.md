# 工作流隔离恢复持久状态机

新 API `resumeWorkflowRestore(settings)` 位于 `scripts/workflow-restore-resumer.mjs`。输入包括受限控制库 authority、固定 operationId、已认证归档路径/key、tenantId、新 targetDatabase、独立私密 credentialFile 和每操作独占 workDirectory。调用者是受信本机运维程序，不应直接接收浏览器用户提供的路径或管理凭据。旧 v2 归档和简单恢复内核保持旧源码/用途。

完整 GCM、manifest 和 dump SHA 认证先于控制库/目标操作，输入文件身份及 key 绑定复核；持久请求保存准确 cluster/controlDB、归档 SHA、manifest SHA、key 指纹、目标名和路径。不同请求不得复用同 ID/工作区。尚无本模块 binding 的目录只能含认证工作区，不得复用捕获任务的原生意图目录。明文先登记身份，旧原生程序实际退出后才能清理旧认证工作区。

控制库 owner 必须为预期 NOLOGIN 最小角色，无 membership，CONNECT/CREATE/TEMP 权限只属于该 owner。registry 表归该角色所有，不向其他角色授权、无用户触发器/RLS，严格检查结构、请求/状态摘要。当前目标 session advisory lease 防止并发接管。旧 owner 的 host、PID 和启动 ticks 必须实际终止；同进程只有已标记 quiescent 的成功重放可继续。跨 host 接管未实现。

目标仅为 `idms_workflowrestore_<acme|sandbox>_<12hex>`，角色同名，最小权限、NOLOGIN、role connlimit 0；数据库 connlimit 0、PUBLIC 无权限。原生 pg_restore 由管理角色连接，固定 `--role=<owner>` 执行，因此归档对象属于隔离 owner，而业务凭据不可登录。完整事实验证成功也不打开目标。QA 为实际 Java 快照比对曾显式短暂打开唯一 QA 目标，关闭 Java、确认后台退出并恢复隔离属性后才重放；产品没有自动激活步骤。

阶段为 INTENT、ROLE_CREATED、DB_CREATING、DB_READY、RESTORING、RESTORED、RESETTING、VERIFIED。角色创建、角色属性/密码验证器摘要与 ledger 在同一事务提交。私密凭据不覆盖，ledger 只存摘要。CREATE DATABASE 先持久 DB_CREATING，再核对精确新角色 OID/唯一所有权、编码/locale、connlimit 和允许的初始 ACL，保存 DB OID。这个窄窗口信任超级管理员没有冒用新角色手工建同名库；记录 OID 后同名替换绝不接管。

重试先核对 catalog，再按持久程序 SHA/准确参数/PID/启动时间退休自有 pg_restore 和遗留检查助手，准确绑定旧 PGAPPNAME/DB OID/管理角色及 backend_start 退休旧 SQL 后台。原生进程 close 与 SQL 后台退出分别确认，不以超时认定退出。未知客户端会话拒绝且不终止；维护后台不是允许的 reader，零会话门槛可等待其自然退出约 5 秒，仍存在则拒绝。等待不改变权限或修复漂移。

未完成且 catalog/权限/OID 仍匹配的自有隔离目标按 RESETTING 意图删除并重建，解决 single-transaction 导入前后结果未知及序列等状态。这个操作只作用于本操作的未完成目标；不重置未知或 VERIFIED 数据库。VERIFIED 重放先登记本次只读连接意图，再只读 RR 比较全部 38 表、两序列及数据库/session 上下文，复用原 OID；事实或权限漂移拒绝。超级管理员/OS 管理员仍为信任边界，未实现对其恶意并发操作的隔离。

原生恢复程序限实际 PostgreSQL 16 pg_restore.exe，程序路径/SHA/版本固定，八参数固定，密码只放环境；5 分钟超时、250 ms 围栏/catalog 监视，失败等待真实 close。认证记录、原生意图和 ledger 均为私密材料，不应打包公开。正常 Windows attached 子进程在控制器退出时可能被操作系统一起结束，仍须单独处理 SQL 后台。当前本模块已验证实际 COPY 中断；独立存活孤儿 pg_restore 的 Stop 阳性测试仍待补充，不能拿前一阶段 pg_dump 阳性替代。

阶段证据见 `workflow-restore-resumer-progress.md`。这不是原库覆盖、业务激活、跨服务原子灾备或完整商业验收。原 workflow9124/4016 未冻结/切换，后续还需捕获侧来源/目录/权限漂移完整矩阵、恢复侧孤儿 Stop 等门槛，再原服务受控部署和新拓扑核验。
