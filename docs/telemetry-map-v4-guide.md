# v4采集领域运行与验证说明

此修订提供可独立运行的采集worker：在已经完整核验、持久停写旧源并激活的v4映射上，证明读取有限依赖，将测点、不可变回执、旧格式审计及冲突索引原子提交，再签发业务ACK。当前原站点仍运行冻结913源v2，尚未切换到此worker或映射。此包是精选源和脱敏证据，依赖项目其他模块及本机依赖，不是独立安装包。

## 数据和治理

激活器 scripts/telemetry-map-activation-v4.mjs 要求已有完整旧图迁移seal，重新验证全部原SQL事实、完整payload、全部旧点/回执/审计，并独立重建映射根。先写UPDATING，逐批安装直接实体/顺序/审计头/遥测索引和来源治理时间树，完整重构成功才转ACTIVE。旧源持久停写保持；原业务HTTP写入口不因此开放。

时间树覆盖当前及旧回执冻结来源配置。边界包含策略发布时间、生效时间及设备/测点定义提交时间，区间决策使用旧sourceGovernanceDecision。接收先核对当前租户、数据库/角色OID、目录摘要、活动围栏与registry，再读同一可信根的证明；不使用进程级业务缓存。更正、未来生效、暂停后成功报文重放及历史原点关联继续遵循旧语义。

正常快照预算256键/16MiB。单报文审计追加使用旧appendAudit与已认证前一事件，未重扫全历史。点、回执、唯一审计和各索引共用CAS提交；跨核冲突重取根并重新评估。未知COMMIT结果只按原command查证明；确认提交前不发ACK。MQTT处理在提交后排队发送业务ACK并释放handleMessage；不能在同连接处理器内等待自己的QoS1 PUBACK。

## 独立入口

每个worker绑定一个租户。私密JSON须符合 server/telemetry-map-worker-v4.ts 的 TelemetryMapWorkerConfig：format=1、purpose=TELEMETRY_DOMAIN_V4、最小APP account、已经固定的StateMapBinding、含私密HMAC资料的sources、mqtt连接资料；可选managed操作UUID和随机controlToken。配置不进公开包或版本记录。运行环境沿用项目兼容的Node/pg/mqtt依赖：

```powershell
$env:IDMS_TELEMETRY_MAP_CONFIG = 'C:\private\idms-telemetry-map.json'
node server/telemetry-map-worker-v4.ts
```

入口验证数据库和角色身份、目录摘要、ACTIVE、公开来源配置摘要及apply执行能力后连接broker；远程PG/MQTT要求验证TLS，loopback可使用本机明文，MQTT URL不接受内嵌账号。stdout/父IPC发送READY/STOPPED，日志只输出限定错误码，不回显私密配置或JSON解析片段。SIGINT/SIGTERM排空当前报文后关闭连接；受管模式支持匹配operationId及常量时间验证token的IDMS_TELEMETRY_STOP私密IPC，错误token不会停止进程。此入口不提供HTTP/OIDC或治理写接口。

不要用公开示例虚构数据库binding，也不要将QA入口直接指向原库。原站点切换须先完成全部读写领域和接口的协同迁移、授权、会话与恢复验证。

## 已执行的验证

最终完整QA为 work/telemetry-map-v4-20261019/8352d7b47cd6：真实PG、私有Mosquitto、MQTT QoS1、签名ACK、SQLite EdgeSpool、真实双Node同报文竞争仅一次业务提交；伪签名、外租户、event/sequence/time冲突、别名、当前围栏/registry、定义更正和计划暂停通过。注入中途delta失败后整笔回滚，同WAL事件恢复；代理实际丢弃成功COMMIT响应及解析回执响应，未确认时没有ACK，fresh receiver证明原回执后恢复。签名JSON内1e400的value/sequence/嵌套字段与旧PG参数JSON标准化语义一致。

1024条规模段直接调用同一真实接收器/PG/签名ACK，分别重读全部1024点、回执、唯一审计，以原verifySourcePoint/Receipt及原治理函数独立核对，完整1064条审计链重构。该段不是1024条MQTT吞吐测试；真实MQTT/WAL另在同次流程完成3条WAL事件，最终0pending/0rejected/3ACK。64/256/1024检查点均19逻辑键，证明节点389/429/519，读取值约9.5KB，末32条耗时中位214.712/213.658/225.085ms。边界QA仅控制自有Node业务时钟，不改OS时间。

SQL实现2只优化固定空树摘要取值，协议仍COMPRESSED_SMT_COUNTED_V1，根/节点ID不变；15组真实PG守卫及同64输入ABBA比较通过。结果见 specs/2026-10-19--state-map-extension-v2.md，有限本机样本中阶段中位均值下降约39.6%，不含传输、不代表SLA。

真正CLI入口另在 work/telemetry-map-worker-v4-20261019/4072563b194d 以未修改OS/业务时钟运行：broker收到了当前暂停后的签名拒绝ACK，拒绝审计已提交、原STORED回执保持、全链有效；错误purpose/远程明文/DB OID拒绝；实际坏私密JSON子进程exit1且日志无测试secret；错误停止token被忽略，正确私密IPC停止且原生exit0。主QA与CLI各自4库14角色、SQL守卫2库6角色、ABBA额外1库均按已记录OID/owner清理，不使用FORCE或终止未知后台。

## 尚待完成

此时仅完成采集领域独立服务。治理/批准/导入等写者尚未连接v4；更新这些内容必须先关闭采集、准备新时间树并将业务变更/审计/指针原子激活，禁止给generic map API直接接HTTP。现有站点SQL读接口尚不能读取新映射，工作流、AI、全HTTP/OIDC/CSRF/范围/游标、所有其他写者及全量备份恢复需再集成回归。历史根/节点保留删除、真实FIELD、跨服务HA灾备、安全、模型/RUL、SaaS/私有化与许可等完整方案A目标继续ACTIVE。

可重复检查为 work/telemetry-map-v4-20261019/check-progress.py。record-progress.py只发布一次，成功后不得重跑；旧14基础/12迁移/25恢复精选源及原913运行源保持。
