# 采集容量诊断使用说明

`scripts/telemetry-capacity.mjs`通过原应用账号、PG只读事务、SQLite只读连接与签名状态接口，持续观察旧模拟采集链路。它不修改保留期、数据、默认预算或运行服务。现场FIELD尚未配置时，不把本机模拟观察当作现场容量证据。

从项目根执行，输出目录必须是新的目录，其父目录预先存在：

```powershell
$edgeState = Get-Content -LiteralPath 'work/legacy-edge-flow-20261018/deployment/operation-state.json' -Raw | ConvertFrom-Json
node scripts/telemetry-capacity.mjs --business-config .local/postgres-business.json --edge-config $edgeState.configFile --tenant sandbox --edge sandbox-edge --out work/capacity-new-observation --seconds 300 --interval 15 --core-pid 5356 --core-created '2026-10-18T22:38:39.3001760+08:00'
```

PID与创建时间必须先用当前运行核验器确认，不能复制历史值后直接假定仍有效。核心进程采样目前支持Windows；省略两个core参数时仍采集数据库与队列。当前诊断入口只支持loopback业务PG和SIMULATOR，默认300秒/15秒，允许15至3600秒、间隔5至60秒且至少两个间隔。配置路径与认证值仅本机读取，不写入报告。

输出`observations.jsonl`逐条同步落盘；只有窗口正常结束才非覆盖提交`report.json`。输出目录已存在、配置/账号/库/表/source绑定漂移、队列不守恒、计数逆转、核心进程身份改变、状态接口异常或SQL超时都会失败，不重启任何服务。失败时可保留有限观察文件，但没有成功报告，重新观察使用新目录。

每次PG采样的点/回执/审计行数和`pg_column_size(t)`合计来自同一READ ONLY REPEATABLE READ快照。行大小合计是该SQL函数的行值测量，不等于原JSON字符数或磁盘分配。heap/index/total、数据库大小与SQLite DB/WAL/SHM文件大小是物理时点观测，不具备MVCC一致性。库中三表总量可能包含其他来源或业务，审计增长不能全部归因选定边缘源。

状态读取在PG与SQLite采样前后各进行一次，序号/ACK必须包住SQLite快照，避免假装跨存储原子一致；实际PG确认、传输确认与SQLite确认依然可能分处提交前后。队列始终核对pending+rejected+acknowledged=sequence。容量/缺口/重试/发布计数也保存，进程内计数重置会拒绝。

`pendingNetReduction`为实测窗口的净下降；`currentWindowLinearDrainScenarioSeconds`仅在净下降时推算当前剩余pending，无净下降时为null。每日物理增长情景只在本窗口分配净增加时提供，页面分配、压缩、检查点、其他表与负载变化都会影响它。报告不授予删除资格，也不是长期容量或SLA保证。

核心CPU是同一实际进程的累计CPU差；workingSetBytes是工作集，privatePageBytes是独占提交页指标，都不同于应用任务额度。`diagnosticPgSampleMs`是诊断查询自身耗时，不是采集提交延迟。应在独立QA中进一步分析完整企业重建、canonical与写后核对的成本，再选择增量事务改造。

可重复模型检查：`node scripts/verify-telemetry-capacity-model.mjs`。真实PG/SQLite QA：`node scripts/verify-telemetry-capacity-sql.mjs`；成功证明文件独占写入，已成功的同份QA证明不覆盖重跑，需要明确新结果路径后再运行。QA使用随机专用数据库与角色、原追加保护schema、真实并发提交和签名队列，清理核对精确OID，原数据不参与故障注入。

后续保留机制必须覆盖审计链与business_state一致性根、回执幂等/序号冲突、质量与分析历史证据、归档可验证查询和恢复。当前审计不可变触发器与最小角色没有DELETE权限，不能用绕过保护的时间DELETE代替归档保留设计。
