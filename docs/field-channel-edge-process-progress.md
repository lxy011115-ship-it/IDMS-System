# 正式现场边缘进程：阶段进度与用法

2026-10-17。第5项现已补上独立现场进程，复用已验证的只读采集、租约、SQLite、mTLS和真实事务接收。原4010未部署、未重启，原企业没有现场schema、审批策略或测试点。完整方案A仍在进行。

## 启动

```powershell
node services/field/index.ts --config <私密配置文件>
node services/field/index.ts --config <私密配置文件> --once
```

持续模式按采集周期运行，故障时在实际排空后退避。单次模式尝试一次完整新观测并处理当前流积压；全部待确认成功且没有隔离记录才输出 FIELD_EDGE_COMPLETE。请求、读取、确认等失败则非零退出并保留队列，下一次运行继续验证原记录。onceTimeoutMs 到时请求取消，仍须等待本机任务实际终态，不是强制退出期限。

所有证书、密钥、profile和队列路径均相对于私密配置目录；路径不能跨出该目录。固定的v2 profile须先与平台来源/通道审批、公共摘要及平台注册一致。边缘只持平台签发公钥。配置完整结构如下，文件名和URL是占位示例：

```json
{
  "format": "idms-field-edge-config-v1",
  "profileFile": "profile.json",
  "lease": {
    "url": "https://idms.example.invalid/api/v1/field-channel/lease",
    "requestKeyFile": "request.bin",
    "platformPublicKeyFile": "platform-public.pem",
    "timeoutMs": 3000,
    "renewBeforeMs": 1000
  },
  "eventKeyFile": "event.bin",
  "mqtt": {
    "url": "mqtts://broker.example.invalid:8883",
    "caFile": "mqtt-ca.pem",
    "serverCertificateFile": "mqtt-server.pem",
    "clientCertificateFile": "mqtt-edge.pem",
    "privateKeyFile": "mqtt-edge.key"
  },
  "spool": {
    "directory": "field-spool",
    "capacity": 10000,
    "maxBytes": 16777216,
    "maxStreams": 16
  },
  "schedule": {
    "sampleIntervalMs": 1000,
    "retryMs": 2000,
    "ackTimeoutMs": 3000,
    "batchLimit": 20,
    "onceTimeoutMs": 30000,
    "retryBackoffMs": 1000
  }
}
```

请求键和事件键均为独立的32字节非零二进制，事件键摘要须与批准profile相符。平台公钥必须是固定Ed25519 SPKI PUBLIC KEY，拒绝以私钥文件替代。OPC UA和MQTT材料分别核对用途、身份、固定摘要、私钥对应及有效期，不自动信任或热换键。

capacity 为当前流未确认和隔离记录数上限，1..10000且须容纳整批点；maxBytes 是正文与确认的逻辑预算，65536..268435456且须容纳整批协议最大事件；maxStreams 为专用目录内1..64个流文件。采集周期500..3600000ms，重试间隔100..60000ms，业务确认等待250..10000ms，每轮最多发送1..100条，单次取消时刻1000..300000ms，故障退避初值1000..30000ms、最高30秒。这些参数不构成SQLite主文件/WAL/索引的物理总量或吞吐保证。

## 运行约束

进程先按tenant/edge取得确定的本机IPC锁，再发租约HTTP、连接设备/消息服务或创建SQLite。Windows使用命名管道；Linux实现抽象socket路径，本阶段实际验证在Windows完成。修改配置路径、设备/点表版本或队列目录不能绕过同一tenant/edge锁。锁没有PID文件或超时删除，须实际关闭或由OS在进程终止时释放。

启动取得新鲜租约和当前允许状态后，按streamId使用独立文件。同流续租复用原文；审批/注册变化换流。旧文件保持，不自动发送、重标或删除。旧待确认、隔离及过期流需后续运维证据流程处理；流文件上限到达时停止创建新文件。目录仅接纳合法流文件及其WAL/SHM，未知文件、链接或目录会拒绝运行。

每次采集前按整批最大协议载荷保守预留未确认/隔离容量，已确认历史可回收；不足时仅尝试补传。读成功后一次原子追加整批及序号。发送一次只等待一条业务确认，MQTT PUBACK不删队列；精确STORED才清对应记录，REJECTED持续隔离。长批补传在租约到期前更新当前允许状态，先等待旧传输和核对终态；变化绑定后不处理旧流。

平台HTTP或当前允许状态不可用时，不继续读或发送。broker不可用而当前允许仍有效时，按有界容量积压，并退避重连。后台核对失效取消当前读/发送。SIGINT/SIGTERM或受控父进程私有IPC STOP请求停止；Windows监督进程可用该IPC完成受控停机，强制终止按崩溃恢复处理。父IPC失联同样请求停止。等待HTTP、原生读、MQTT及回调实际结束后关闭SQLite、清零密钥，最后释放本机锁。

应用结构化事件只输出状态、错误码和计数，不输出采样值、私密URL或密钥。原生依赖诊断仍属私密运维日志。没有新增远程停机接口。

## 已验证

- 480项单元测试、198项运行构件及脚本语法、server/predictor TypeScript检查通过。
- 真实IPC互斥、不同身份可并行、相同身份修改设备/点表不能绕过、实际关闭后重获；队列整批预留、确认历史回收、隔离占容量与当前许可先行通过。
- 真实OIDC/Chrome独立批准来源/通道，启动实际生产CLI；边缘目录仅含平台公钥，经原生加密OPC UA、SQLite、mTLS、最小角色PG真实COMMIT后签确认清队列。
- 六类坏配置（跨目录、请求/事件同键、私钥冒充公钥、错客户端证书、队列越界、未知字段）在锁、网络及队列创建前拒绝。相同身份改配置及队列路径的第二进程失败，没有新HTTP业务根、设备请求或SQLite目录。
- 保持实际原生读取时发送受控STOP，实际exit后可重新启动；父IPC失联也取消保持的读取并实际退出，没有追加半批或点。Write/Call始终为零。
- 真正PG提交后故意丢响应：CLI非零退出，原待确认正文和摘要保留；重开恢复原回执，不重复入库。
- 明确注入业务确认丢失使队列达到容量，后续设备值读取次数保持；终止精确自有守护子进程，确认真实exit才重开，原事件不改并恢复真实提交回执。这是进程故障测试，不是物理断电测试。
- 浏览器独立终审换版后，新流从序号1开始，新点正常入库；旧流序号14/两条待确认及整个SQLite主文件字节保持，未发送或改写。流文件达到两份限制后，再换版启动在设备读取和创建第三份文件前拒绝。
- QA最终共14点/14回执；最后完成的新流序号2、pending0，旧流保留两条待确认供人工处置。所有自有CLI子进程均从实际exit确认终态；被强制终止的子进程不声称正常exit0。原企业数据、基础迁移、表数和Acme根保持。

联合验证在 `scripts/verify-field-workspace.mjs` 中启用 `IDMS_FIELD_QA_MTLS_PROFILE=1`、`IDMS_FIELD_QA_FORMAL_EVENTS=1`、`IDMS_FIELD_QA_TRANSACTIONAL_INTAKE=1`、`IDMS_FIELD_QA_EDGE_PROCESS=1`。协议/工作台联合模式仍可分别运行。公开验证文件只含结论、计数和源码SHA，不交付SQLite、密钥、真实配置或原始日志。

## 后续

第5项已完成当前阶段实现与隔离联合验证。继续第6项：先落实恢复围栏，使同配置数据库恢复也使旧允许状态/流/业务确认失效，再完成包含idms_field的备份恢复、现场证据冻结与离线CLI及完整全链验证。之后按第7项受控切换原服务并验证旧会话、权限和恢复。旧备份不能声称已覆盖现场schema。

旧66完整文件契约、十轮双份冻结快照及每份1571文件SHA保持；不建立第十一份最终快照。当前不是最终格式冻结、现场验收、完整HA或商业验收。
