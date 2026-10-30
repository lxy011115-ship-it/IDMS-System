# v2核心切换准备使用与边界

当前交付包括数据库维护门、可重复关闭/开放的HTTP维护门、受控核心入口，以及913份运行源码修订2。原运行核心仍是5356，尚未启用v2。此前509单元/13组集成验证见[完整核心回归](canonical-v2-core-regression-progress.md)，本次没有重复整套业务回归。

数据库门先以`FOR SHARE`排空正常根写事务，核对工作流/AI任务无待办或有效租约，再以`SHARE`锁全部业务基表。实际应用写入受阻、SELECT继续；绑定真实事务、集群/库/角色/关系身份、ACL/列/约束/索引/触发器/函数和非MVCC审计序列。序列推进只报告漂移，不回拨。两租户部分取得失败仅释放本门已持有资源。控制进程死亡会释放事务锁，已等待写入继续，因而此门不提供持久围栏；再次取得必须重新验证。

HTTP门初始拒绝写入及OIDC login/callback，既有会话读取继续。带操作UUID、清单SHA和epoch的父进程IPC控制关闭/开放，丢回复应先读取状态；陈旧epoch不能开放。logout仍调用原认证撤销逻辑；数据库门期间审计可能超时，不能据此承诺logout必定200。后台任务由数据库门限制。

权威源码目录为`outputs/core-canonical-v2-20261019-2`，外部清单为`outputs/core-canonical-v2-source-revision-2-verification.json`，SHA256为`52a71a10bf72e9cfcea1a3184fe0fc9a6e665cf648520e5b973d3e79a3aa48ab`。909份旧R2加v2、loader、HTTP门、entry四项共913份。入口核对完整文件集合和逐文件SHA，拒绝额外文件、内置node_modules/.local/.git、硬链接、junction。初次冻结的检查器实际接受额外文件/硬链接，保留原件并用修订2拒绝这些情况；共9类实际负例通过。两份913源均不包含依赖安装包，使用本机祖先目录依赖，不能作为独立安装包。

重复只读验证从项目根执行：

```powershell
node scripts/verify-canonical-v2-runtime-source.mjs --root C:/Users/Administrator/Documents/Codex/2026-08-31/fen/outputs/core-canonical-v2-20261019-2 --manifest C:/Users/Administrator/Documents/Codex/2026-08-31/fen/outputs/core-canonical-v2-source-revision-2-verification.json --expected-sha256 52a71a10bf72e9cfcea1a3184fe0fc9a6e665cf648520e5b973d3e79a3aa48ab
node scripts/verify-core-upgrade-readiness.mjs
python work/canonical-v2-core-upgrade-20261019/check-progress.py
node work/workflow-controlled-upgrade-20261019/verify-runtime.mjs
```

readiness命令更新自己的后验JSON；不取得原库维护门、不启动/停止核心。发布checker只核对已发布文件与证据。当前拓扑命令适用于原5356及已升级workflow25776，未来核心实际替换后需另建验证器，保留旧发布包。

真实隔离QA以两套最小角色PG库冷启动同一修订2入口，缺loader/坏清单实际启动失败；两库维护门持有期间冷启动成功。31/33表加密业务档案实际隔离恢复，核对全表事实与审计序列，源门始终保持。随后真实OIDC、两次上传、关闭/重开、旧SID/CSRF/加密审计游标和独立旧编码器验根通过，同一子进程实际停止。所有自有QA进程、库、角色、身份、临时凭据和密钥清理；QA密文只私密留存，QA密钥已删除，不能作为未来可恢复档案。原库并未执行这些备份或切换。

维护门初始与hardened验证、两次freeze、文件负例、managed-entry验证及本阶段record已成功，禁止重跑同名one-shot。失败的初始检查与结果保持；私密配置/密钥/SQL/原件/原始日志和QA密文不公开。源码14项与脱敏阶段证据双份，913运行源另有完整清单，两者用途不同。

后续先实现原核心切换协调器、实际OS/端口/PG客户端归属绑定及退休请求记账，再获取新鲜原SID/CSRF/旧游标见证、两原租户切换前后档案/隔离恢复。维护态中确认同一原资料、范围/CSV及edge/workflow/六依赖保全，全部通过才开放。观察超时继续确认同一进程终态，不能自动重启/回滚或终止未知客户端。完整商业目标、增量事务/保留期、真实FIELD、跨服务灾备、安全、模型RUL和SaaS私有化继续。
