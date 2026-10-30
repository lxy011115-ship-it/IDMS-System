# 旧模拟采集链路的业务确认背压

新增显式入口 `services/edge/flow-index.ts`。默认启动器仍使用 `services/edge/index.ts`。当前本机运行的旧边缘端尚未接替，原队列积压仍存在。

## 行为

新入口复用旧telemetry-v1报文、HMAC、来源绑定和 `EdgeSpool`，读取同一配置和SQLite。默认一次等待1条业务确认；MQTT PUBACK仅表示代理收到了报文。只有原spool验证通过的STORED/REJECTED才能释放业务槽位。ACK早于PUBACK时还需等该次发布回调结束，避免传输层暗中堆积。REJECTED保留并占容量，来源、序号、事件ID、签名和待传字节不会被改写。

默认60秒未收到业务确认才重试，随后120秒、240秒，最多300秒。未完成PUBACK的同一发布不再叠加publish；断网不新增发布。重启依照SQLite最后尝试时刻等待剩余基础超时，随后使用单调时钟计时。重连后明确重新订阅ACK，收到成功SUBACK才允许发送。

整组采样前预检空间，不足一组时跳过本轮并增加gap/skippedBatches。被拒收的数据也占空间。容量当前状态 `capacityBlocked` 会随空间恢复解除，进程内累计gap保持；这些计数未改成跨进程持久统计。预检只防容量不足导致的部分组，仍沿用每事件独立SQLite事务，不承诺磁盘故障或崩溃时整组原子性。

## 配置与接替

基础配置仍由 `IDMS_TELEMETRY_CONFIG` 指定；默认 `.local/mqtt/telemetry-runtime.json`。额外流控参数可用 `IDMS_LEGACY_EDGE_FLOW_CONFIG` 指定私密JSON文件；未设置时使用默认值。JSON必须准确包含：

```json
{"version":1,"window":1,"ackTimeoutMs":60000,"maxRetryMs":300000}
```

`window`为1至8，`ackTimeoutMs`为5000至300000，`maxRetryMs`不得小于基础超时且不超过900000。参数不会关闭确认/容量保护。入口仅支持本机只读SIMULATOR，不启用现场来源。

接替需先核实旧进程身份，保存配置和队列只读事实，等待旧边缘端真正退出，确认状态端口与旧MQTT连接退役，再用相同配置/SQLite启动 `node services/edge/flow-index.ts`。标准同配置重复启动会在status监听处失败，先于spool/MQTT/OPC初始化。该监听不是任意重配状态端口后的跨进程文件锁；不得给同一spool启动不同status配置的第二写入者。

Windows协调器可通过私有子进程IPC发送 `{"type":"STOP_LEGACY_EDGE_FLOW_V1"}`，入口等待正在进行的采样和连接关闭后关闭SQLite。也支持SIGINT/SIGTERM。不要以删除队列、重置序号、重签旧报文或自动驱逐记录来消除积压。

## 验证与边界

运行 `node --test server/legacy-edge-flow.test.ts server/telemetry.test.ts`、`node scripts/verify-legacy-edge-flow.mjs`、`node scripts/verify-legacy-edge-flow-postgres.mjs`。两组集成使用唯一私密目录和端口，PG组另建唯一数据库/最小角色，终态后清理；不改原队列或配置。

第一组是实际MQTT/OPC UA与模型签名ACK，覆盖丢确认、错误确认、容量、重启、代理重启和竞争启动。第二组实际调用未改动的 `TelemetryService`、企业事务和完整审计，以1000条合成历史审计、600ms接收延迟及提交后丢失一次ACK验证15个事件：14点/15回执/15新审计，1条拒收保留；一次重试不增加重复点/回执/审计。故障延迟和丢ACK在QA包装器中，生产代码无注入开关。

这些是隔离功能验证。尚无原万条队列的真实接替/排空或长时吞吐证据；核心完整事务的其他成本仍需测量。容量、拒收归档和确认历史保留期仍有上限与待办，真实FIELD、HA、跨服务灾备和完整商用验收继续。
