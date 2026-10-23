# 边缘进程接入：本地生命周期 V1

本阶段落实平台依赖计划第 5 步的边缘进程所有权接口。旧 `services/field/index.ts`、原循环和既有核心验证入口保持原字节；新入口由 `scripts/field-edge-lifecycle-v1.mjs` 创建，使用循环 V2。

`launchFieldEdgeLifecycleV1` 接受材料配置文件、登记候选、准确 edgeId、边缘配置文件和私密工作目录。它复用 `loadActivationMaterialSet` 检查完整材料绑定，关闭加载副本，然后先返回实际 ChildProcess 句柄。边缘子进程仅加载自己的 OPC UA/MQTT 私钥、请求/事件密钥和平台公钥；不会加载平台签名私钥或平台 MQTT 私钥。新鲜 owner 密钥生成的不透明 MAC 核对实际加载副本，配置摘要及材料改变均在获取身份锁、HTTP、OPC UA、MQTT 和 SQLite 之前拒绝。MAC 不证明人工审批；是否允许采集仍由实际租约和当前状态检查决定。

`bindFieldEdgeLifecycleV1` 请求实际启动并等待就绪。只有本流收到经验证的签名 STORED 业务确认、当前租约允许且 MQTT 连接有效才报告就绪。流切换清除旧确认。`probeFieldEdgeLifecycleV1` 通过自有 IPC 取得当前状态；`lastObservedState` 仅为最近观察，不能冒充新鲜探测。创建进程、持锁、流打开和 PUBACK 均不能产生 READY。

`stopFieldEdgeLifecycleV1` 固定首次 requestId，重复调用返回同一 Promise，换 requestId 拒绝。它持久记录意图后发送相关联停机请求，不使用 PID 枚举、信号强杀或历史证明重建所有权。实际子进程 exit、stdout/stderr 关闭、IPC 断开、来源摘要保持和相关联 CLOSED 同时成立才给出正常停止。父 IPC 失联仍触发排空，但父端未收到 CLOSED 时会保留“本地排空未证明”的状态，不从退出码 0 推断该事实。

循环 V2 关闭时分别等待租约 HTTP/观察任务、原生 OPC UA 读取、MQTT 连接/发布/回调，关闭 SQLite 并清密钥，确认任务退役后才释放身份锁。清理失败产生固定错误码，不能发出正常 STOPPED；队列文件不删除。停机期间如果原生任务尚未结束，观察超时不能作为已结束或重新启动依据。清理失败后的同请求恢复、整套平台依赖停机围栏仍须在后续控制器组合中实现并验证。

## 已取得证据与限制

Windows 的 6 项循环检查和 5 项实际子进程检查通过，另完整 TypeScript 类型检查通过。真实验证覆盖 HTTP 取消、操作系统身份锁、无关边缘隔离、启动前取消、重复停止、配置/请求凭据变更拒绝及父 IPC 失联。首次启动前取消暴露了 Node 24 在排队 IPC 消息分发期间同步 disconnect 的异常；已保留失败记录，并把断开延后到 setImmediate 后，实际复测通过。

这些测试在租约 HTTP 阶段取消，未运行现场 OPC UA 采样、MQTT 事务接收或签名业务 ACK 正例。因此本阶段没有正例证明 READY 分支、SQLite 业务补传、真实签发/事务接收、全平台依赖接线或生产部署。Linux 证据必须以后续 CI 实际结果为准。完整范围及实施顺序见 `docs/superpowers/plans/2026-10-24--field-owned-lifecycle.md`。
