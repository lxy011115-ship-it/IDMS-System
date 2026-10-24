# 当前映射现场网关与统一 SITE

本接线提供可在异步启动完成前持有的运行对象，将当前映射现场签发、接收和 MQTT transport 接到真实身份及物理冷恢复准入宿主。它仍需进入正式应用 manifest、平台现场槽位及 broker/edge 控制器，现有 child V2 不接受新的 SITE 包装配置。

## 配置与绑定

`FIELD_MAP_SITE_RUNTIME_V1` 配置包含 `format: 1`、`baseRuntimeFile` 和 `field`。基底必须是同一次恢复的 `RUNTIME_COLD_SITE_V1`，其下为实际 `SITE_CONSOLE_AUTHORITY_V1`。

- 关闭现场：`field` 只能为 `{ "enabled": false }`。不读取现场材料，不增加现场 SQL、MQTT 或现场子进程。
- 启用现场：`field` 只能为 `{ "enabled": true, "gatewayFile": "...json" }`。
- 网关配置为 `format: 1`、`purpose: "FIELD_MAP_AUTHORITY_GATEWAY_V1"`、`enabled: true`，以及 `authorityHostFile`、`platformFile`、`intakeFile` 三个引用。
- `authorityHostFile` 使用 `FIELD_MAP_AUTHORITY_HOST_V1`。现场写入账户须为同次准入登记并已轮换的实际 writer；它与 SITE 的浏览器只读账户用途不同。两者仍须匹配企业、实际数据库 OID 和 catalog，trust 与 authority 文件须一致。
- 配置必须位于源和目标 PGDATA 外。固定配置变化使现有对象拒绝继续使用，不自动重新绑定。

`createFieldMapAuthorityGatewayV1` 可供其他可信宿主使用，但必须显式给出同站点绑定。不能传入替代实际身份或冷恢复检查的许可函数。

## 调用者持有资源

调用 `createFieldMapSiteRuntimeV1(file)` 同步取得对象，再等待 `ready`。机器签发与检查接口复用 `/api/v1/field-channel/lease` 及 `/api/v1/field-channel/lease/check`；原 SITE 浏览器路由仍由同一 handler 服务。调用者负责创建并持有唯一 HTTP listener，运行对象不另开生产端口。

`state()` 返回自身、现场 host、platform、接收 owner 和 MQTT 状态。SITE 的现场就绪状态随网关实际状态变化。`fieldSnapshot(tenant)` 只返回公开注册快照，不返回写入凭据或签名私钥。

停止时先对同一个对象调用 `requestStop({requestId})`，立即拒绝新工作并同时取消 MQTT 接收和平台在途操作；再等待 HTTP listener 以及 `close({requestId})`。不要先等待 listener 的所有请求退出才发起现场取消，否则持有 SQL 的机器请求可能阻塞排空。网关等待实际事务结束、owner 释放和所有自身连接退役后才关闭 host。相同 requestId 复用关闭结果，不同 requestId 被拒绝。

## 当前验证范围

边界测试覆盖关闭模式、错站点绑定、启动前取消和关闭请求一致性。真实组合验证在独立 Keycloak、完整 R4、维护封闭、物理加密备份恢复、凭据轮换及 ADMITTED 目标中运行；由实际两用户经治理队列独立发布策略，再接入 OPC UA、mTLS MQTT、当前 SQL 根、签名 ACK 与 SQLite。来源策略沿原编码族升级，保留过去条目，并等待已批准的未来切换时间。

现场专用 ACTIVE control 和 activation candidate 在该 QA 中明确为测试材料，全局身份及物理冷恢复为真实运行。正式现场恢复批准、旧 FIELD 历史迁移、控制器接线以及授权查询、设备页面、预测消费仍须完成，不能由局部组合验证替代。实际验证结果以对应运行报告和离线检查为准。

## 站点子进程入口

`runtime-field-site-child-v1.mjs` 是供新管理器接入的独立 SITE 入口。新建 fork 先返回带 owner、component、challenge 和实际 PID 的 `APPLICATION_COMPONENT_CREATED`；只有同一父连接发出 `APPLICATION_COMPONENT_START` 后才加载配置。管理器因此可在启动前持有真实句柄并请求取消。

`APPLICATION_COMPONENT_STOP` 携带原绑定及 requestId。关闭先请求现场取消，再等待 HTTP listener 和运行对象退役；最终文件及消息包含该请求和实际 runtimeTerminal。父连接断开或信号退出不计为已请求的正常关闭。启动配置失败也不会报告 READY。

三个实际进程边界测试覆盖启动前取消、配置失败退役、不同实例之间的停止隔离。新入口仍待正式管理器接线及启用现场后的原生排空核验，尚未进入现有应用管理器的启动路径。
