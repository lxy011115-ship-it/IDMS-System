# 现场 SITE 应用管理器接线

当前是开发入口，尚未通过启用现场的管理器原生整链验收，也未接入平台 broker/edge 控制器。不得据此切换服务器或正式启用现场。

`runtime-application-manager-v3.mjs` 使用 `RUNTIME_APPLICATION_SUITE_V2` manifest，保留原四种后台组件、每租户完整覆盖和唯一 SITE。额外的 `field` 必须明确为 `{enabled:false}`，或 `{enabled:true,siteComponentId:"实际SITE组件id"}`。唯一 SITE runtime 必须是 `FIELD_MAP_SITE_RUNTIME_V1` 包装，开关必须一致。先仅读取包装核对开关，错配时不跟随 gateway 或 base 文件；之后仍执行完整冷恢复、身份与文件摘要门禁。

`application-lifecycle-v3.mjs` 提供 launch/bind/stop/inspect 四个 V3 方法。launch 返回自身实际新建的管理器 fork 句柄；外部 PID 形状对象无效。stop 接收 UUID requestId，相同请求复用同一 Promise，变化请求拒绝。启动期间的同一请求经 AbortSignal.reason 传至管理器及各组件。manager 的 SITE 使用新 child：原始 fork 句柄先保存，收到绑定 CREATED 后记录 START_AUTHORIZED，再发送 START。

V2 registry 将 CREATED、START_AUTHORIZED、RETIRED 纳入独占 SQLite 快照和哈希链。SITE 的 CLOSED 回执先保留在内存，等原始进程实际 close、stdout/stderr 与 IPC 关闭后，再读私有结果文件，核对结果与 IPC 的 runtimeTerminal、requestId 和启动取消分类。退役验证器检查 HTTP、host SQL、platform owner/issuer/receiver、MQTT 传输的连接、任务与密钥清理。曾就绪的 enabled SITE 不得缺少这些资源。尚未创建资源的启动取消可以为空，异常退出不冒充正常取消。

SITE 正常退出但缺少有效资源证明，也不允许继续停止后台成员。管理器报告排空受阻并保留其余进程；上层不得停止 PG。正常全组停止需要所有组件曾就绪、对应 CLOSED、实际 code=0/signal=null 以及 SITE 的 RETIRED。生命周期层再次读取原始 SITE launch/result 文件，重新算出完整退役摘要并与 registry 对比，不只相信事件计数。

已运行：新增 12 项边界/结构测试，以及原应用生命周期、真实 SITE child、SQLite 快照锁和并发 checkpoint 的 8 项回归；类型检查通过。结构测试中的完整资源形状是明确的合成测试数据，不能称为实际现场退役证据。真实 fork 目前证明了 child 启动授权前取消、明确 START 后配置失败且资源退役、无关 owner 隔离，以及新管理器自身的提前取消/失败处理。

下一步需将新 manager/lifecycle 接入正式平台依赖控制器，登记真实 MQTT broker 与 edge，按 broker→SITE→edge 启动、edge→SITE→broker 关闭，在同请求下验证正在处理 HTTP/SQL 时的排空及无关实例隔离。治理后台仍为 V4；不能绕过 V6 队列迁移门禁。现场正式恢复/激活批准、旧数据和历史签名键迁移、授权数据页与预测消费、完整验收和最终图文/实操视频仍为完整目标。当前 enabled 是技术接线开关，不产生现场恢复/激活批准。
