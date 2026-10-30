# 当前现场数据网关

本实现把机器租约 HTTP、只读 OPC UA、双向 TLS MQTT 和当前状态映射接收事务连通。原事件认证、租约格式和签名业务 ACK 保持。MQTT 协议确认不代表业务已存储；边缘持久队列只接受经过验证的业务 ACK。

## 启动与关闭约束

`FieldMapPlatformV1.start` 必须接收明确的企业数据库账户、状态映射绑定和当前授权 guard，并加载 v2 平台配置及恢复材料。guard 无默认许可实现。接收标记必须由明确维护过程准备；已有现场审计但缺标记时需要迁移，不能以空集初始化。HTTP handler 供统一宿主挂载，本模块不另开生产监听端口。

每个企业的接收独占权是同一数据库内的实际会话锁。`FieldMapOwnedTransactionsV1` 在持锁的同一连接上执行增量和 COMMIT，并校验实际数据库/角色 OID、目录与锁。其他实例只能处于待命；持锁连接丢失后不借别的连接继续接收或签 ACK。未知提交保留原回执解析机制，但失去所有权时仍拒绝返回 ACK。

先停止接入并取消/排空 HTTP、MQTT 回调和接收事务，再关闭签发器、接收器与持锁连接，最后允许 PostgreSQL 停止。真实 SQL 增量执行后若关闭发生在 COMMIT 前，事务回滚且边缘待传项保留。关闭失败须显式报告，不能按历史 PID 重建所有权或通用杀进程。

## 边缘状态观察修复

原 runner V3 的 `state()` 调用会撤销租约的授权函数，可打断首次在途核对。新的 SDK V2、只读客户端 V2、runner V4 和生命周期 V3 把状态观察变为只读。就绪仍要求当前租约、实际 MQTT 连接和至少一条签名 STORED ACK；它不表示整个批次已排空。

状态读取只观察已验签租约和墙钟、单调时钟截止时间，不联网、不延期、不取消在途 HTTP。实际设备读取、队列访问、MQTT 发布仍须通过原授权检查。原两秒核对窗口不变。测试实际运行旧/新 runner，在持有首次核对响应时验证旧版被状态探测取消、新版等待显式停止；另验证过期、错误 profile 和显式撤销仍失败关闭。

## 验证

使用隔离的新 PostgreSQL 16、实际 QA OPC UA 服务器、实际自有 broker 和五个实际边缘子进程。测试不连接原数据库。执行：

```powershell
node --test --test-concurrency=1 tests/field-map-http-v1.test.mjs tests/field-edge-observation-v2.test.mjs
node node_modules/typescript/bin/tsc -p server/tsconfig.json --noEmit --allowImportingTsExtensions
node scripts/verify-field-map-gateway-v1.mjs <PostgreSQL16-bin> <Mosquitto-bin>
node scripts/verify-field-map-gateway-cleanup-v1.mjs <本次输出的nonce>
```

原生验证包含 12 项检查：当前 map/queue/SQL 围栏、持锁连接及待命互斥、实际读数提交和队列确认、关闭 SQL 围栏拒绝无操作重放、恢复文件变更拒绝重放、在途原生读取消、丢 ACK 保留、重放复用原回执、持有实际 SQL 时等待回滚、排空后待命接管与所有资源正常退出。

独立校验不重启 PostgreSQL；核对实际子进程终态、当前根成员证明、已存事件 HMAC/ACK 签名、SQLite 完整性/MAC 和回滚项缺席。Windows 结果见 validation/field-map-gateway-windows-v1.json。五个边缘进程及 broker 均须退出、管道/IPC 正常关闭，所有持锁连接正常退役。

## 交付边界

QA 恢复材料和外部 guard 是声明测试模型；实际签名协议、OPC UA、mTLS MQTT、SQL 提交、队列和进程退出真实执行。没有执行真实身份权威/OIDC 冷恢复准入。统一平台 enabled/descriptor/controller、精确当前身份与恢复绑定、历史点 HTTP 授权/页面/预测消费、旧现场数据迁移仍未完成。QA 设备不代表生产 OT 现场验收，也不是容量/HA/灾备或商业验收。

本阶段没有切换云端服务，没有启用 idms.xin 公网访问；备案、最终中文图文说明及旁白字幕实操视频仍属于完整项目待办。
