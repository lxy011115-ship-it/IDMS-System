# v2实际运行恢复与操作边界

当前原资料站点已经使用913份冻结源码修订2运行v2。当前入口是`work/runtime-resume-20261019/platform-owner-r2.mjs --attempt 2`，由隐藏WMI父进程持有；业务核心28472，协调器10320，PostgreSQL32152。以重复核验的实际身份为准，不能只凭PID或旧status文件操作进程。

本轮先准确退休5356/5348并启动v2核心17076，随后后置恢复库连接清理拒绝，维持闭门。之后该核心、控制器、PG和依赖全部终态，原因未确认。首次持久化恢复也再次结束，42944已复用为其他Node。原会话内存丢失，因此本轮最终成功证明的是**重新建立的恢复会话**从只读认证服务跨到完整v2核心的SID/CSRF/旧加密审计游标连续性，不能宣称中断前会话仍有效。

独立启动首次遇到逻辑AppData路径在普通后台进程中不可见。通过原PG_VERSION文件句柄解析真实路径，并在隐藏runner中固定同一用户/CWD和物理LOCALAPPDATA；恢复后实际system_identifier及原数据库/所有者OID一致，未initdb、未创建替代集群、未改业务权限或模式。WMI的意义是独立原生父链与日志句柄；短TTL canary实测不在任何Windows Job中，而实际服务进程可能属于自身运行时的Job，不能笼统宣称所有服务都不属于Job或所有外部停止原因已解决。

只读恢复入口复用冻结源码中的真实OIDC/PKCE、PostgreSQL加密会话、业务读取、文件/CSV和审计分页；仅身份登录/注销按原产品逻辑追加认证审计，普通业务写入503，不启动MQTT、工作流或AI后台。先在这里建立新鲜全域/限域见证，停止该入口及其SQL后台，再取得两原租户维护门、完成前置加密档案/隔离恢复，启动完整v2核心闭门核验。会话、六原件14513B、两CSV、范围/伪造租户403、旧游标和1440/390/320界面通过后，再执行后置档案恢复。两轮原业务档案的完整facts/business与非MVCC审计序列核对完成后，才释放维护门、开放epoch0→1，真实注销和删除临时见证用户，最后恢复模拟器与原spool的升级edge。

隔离恢复中，原restore验证连接和序列读取连接可能同时短暂存在。r3仅观察**固定隔离库OID与其随机生成角色OID/名称**的连接直到0；未知主体或超时保留资源，不终止连接、不FORCE。完整认证事实和业务/序列已核对，删除前再核对库/角色OID。源业务/auth连接的保护仍严格按真实核心OS TCP端口归属，不因这个目标库观察修订而放宽。真实两关闭连接、未知主体拒绝和两QA31/33表恢复均通过；本次遗留的两个自有恢复库分别按认证档案和完整事实精确清理，其他历史QA库保留。

常用重复核验从项目根执行：

```powershell
node work/runtime-resume-20261019/owner-command.mjs STATUS 2
node work/runtime-resume-20261019/verify-runtime.mjs
node work/runtime-resume-20261019/verify-recovered-ack-conservation.mjs
node work/legacy-edge-flow-20261018/deployment/verify-current-conservation.mjs
python work/runtime-resume-20261019/check-progress.py
```

后两个Node核验分别逐条检查本次开放后新增确认的真实PG点/回执/审计，以及最初万条积压和37145旧确认、当前待传HMAC与总量。它们只读SQL/SQLite并更新自己的后验文件，不删除队列。当前并非承诺始终零待传或容量SLA。

`STATUS`是只读状态命令。实际分阶段命令为`START_AUTH_READ_ONLY / PREPARE_WITNESS / START_CORE_CLOSED / VALIDATE_CORE / CAPTURE_POST / OPEN_CORE / START_EDGE / FINALIZE`，本次均已成功，不能重跑。修订2的`RECOVER_FAILED_ACTION`只在明确失败记录、同一维护事务/源pin/实际子进程状态下准备重验或续接已存在核心，不因观察超时再启动核心；未知资源需独立精确核对。控制文件含私密随机token，仅供当前用户，不公开。`STOP_ALL`是真实停机命令，日常检查不要调用。

WMI启动器的同一kind/attempt目录只允许一次。PG首次恢复、postgres-3、platform-2、QA/原实例见证、既有恢复目标清理和发布record均成功后禁止重跑。postgres-2是路径不可见、未启动PG的失败历史；platform-1和首次实际切换的中断证据完整保留。旧69179/73945/20287/10938/2355等工具会话及旧5356/17076/42944/33780不是当前运行身份。旧workflow切换拓扑核验器与v2准备readiness只适用历史阶段，当前用本页新核验器。

当前四份权威业务密文及独立密钥私密保留并重新认证；更早档案和失败阶段的密文也保留。它们只覆盖租户业务库，不包含身份库、Flowable、模型、边缘缓存和秘密，不是跨服务灾备证明。日志、配置、原件、密文、密钥、凭据、浏览器响应和调试过程不公开。当前发布只包含操作源码与脱敏证据，913运行源另有完整双份清单，并非独立安装包。

完整方案A仍ACTIVE。全企业图写入仍有线性扫描成本，增量事务、保留期、真实FIELD、跨服务HA/灾备、安全、模型RUL和SaaS/私有化与商业许可仍待继续。
