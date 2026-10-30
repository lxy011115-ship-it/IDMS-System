# 当前工作流运行与核验

2026-10-19已将原工作流受控切换到具备独立恢复读取权限的新Java服务。业务核心5356/协调器5348与模拟边缘17428/协调器27984保持，新工作流25776由独立协调器43680持有，监听127.0.0.1:4016。三个长期工具会话69179、73945、20287需要保持；PID必须结合创建时间、父进程、命令行和端口核对，不能仅凭数字操作。

从项目根执行可重复的只读核验：

```powershell
node work/workflow-controlled-upgrade-20261019/verify-runtime.mjs
```

该命令核对实际进程拓扑、私密运行配置及jar摘要、执行输入与独立key摘要、原数据库和角色OID/权限、真实恢复读取接口、旧业务token与恢复token双向隔离、核心OIDC/加密会话和边缘确认窗口。默认允许正常业务数据增长。`--verify-upgrade-baseline`仅用于核对切换时的完整快照；业务开始新增工单后不能把与旧快照不同当作运行故障。

本次运行jar SHA256为115b0e132795e783f156365722d5518ed5a5ed4640f1999fff59c444f12a31d7。运行状态路径为work/workflow-controlled-upgrade-20261019/runtime-state.json。该文件只供本机运维读取；plan.private.json、私密配置、凭据、实际档案与独立key不进入公开审阅包。旧.local/workflow/runtime.json、client.json、原target两个jar保留原字节。默认启动器仍可能使用旧配置，不能把workflow:setup、start-platform或Maven构建当作本次运行的接续命令。

旧Java9124已真实退出。旧edge deployment/verify-active-runtime.ps1要求它仍存活，已成为历史核验器，不能作为当前状态检查，也不修改历史基线。新核验器还确认原启动器4500持有的六个其他服务及独立PG33440保持。

切换期间使用原两个业务数据库workflow_outbox的SHARE事务锁：确认无待处理命令和有效租约，以真实应用账号测试ROW EXCLUSIVE锁被阻断且SELECT可用，再退休旧Java。它是维护连接持有的事务锁，不是持久HTTP写入围栏；原HTTP写门保持开放。原工作流源随后通过独立持久控制账本进入NOLOGIN/连接上限0与DRAINED，再用guarded入口正式加密归档。故障处理必须核对真实SQL与进程状态，不能把超时当作已退出，也不自动重启旧服务或覆盖原库。

两个实际原源档案均完成完整认证、独立新库恢复、38表/两序列/数据库上下文一致和新Java真实快照/凭据边界核验。切换前后原全部事实一致，原源LOGIN/连接上限精确恢复后启动新Java，最后释放outbox锁并验证应用账号重新可取得写锁。新服务仅增加独立只读reader凭据，旧业务serviceToken继续有效。

隔离验证目标随后按控制账本记录的精确库和角色OID清理，测试Java和SQL后端已经退出，临时测试密码已删除。保留正式密文、独立key和控制账本；档案保持ISOLATED_ONLY/禁止自动激活。清理后的历史VERIFIED目标不能直接重放，后续恢复需要新操作与新隔离目标，不能覆盖原库。

prepare、两次输入pin、实际协调器切换、retire-validation-targets、post-preservation及record-progress成功后均禁止重跑。修订2输入清单承接修订1；执行源码在运行期间保持固定。可重复执行verify-runtime.mjs与check-progress.py。现场FIELD实际签发/接收仍未配置，采集积压尚在下降，长期容量/保留期、跨服务灾备、模型/RUL、SaaS与私有化等仍属后续完整方案A范围。
