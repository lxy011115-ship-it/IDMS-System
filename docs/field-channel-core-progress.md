# 现场安全通道开发进度：只读采集内核

本文件记录先前采集内核阶段。后续新增的独立治理与签名租约内核进度见[field-channel-governance-core-progress.md](field-channel-governance-core-progress.md)；平台全链路仍未开放。

当前只读采集内核已实现并以独立本机OPC UA测试端验证。406项单元测试（新增20）、156项构件语法/类型及旧模拟采集回归通过。平台FIELD准入、通道独立审批、mTLS MQTT、现场协议/补传及平台证据尚未完成；现运行4010仍是上一轮UUID回执兼容版。本文件不是现场接入已开放或商业验收声明。

## 已实现并实测

- 严格有界私密profile及材料读取；准确服务端/客户端叶证书SHA256、URI、SAN主机/IP、RSA强度、用途、有效期、拒绝清单和客户端私钥对应校验。使用明确固定叶证书信任，不自动信任未知证书，不声称有CA路径构建或在线OCSP。
- SignAndEncrypt配合Basic256Sha256和Aes256_Sha256_RsaPss。两种安全策略已由实际服务端channelSecured事件观测，CreateSession证书/端点与服务端签名在激活会话前核对。
- 只暴露受控读取API，服务请求白名单拦截Write/Call及任意未配置Read。实际QA服务端Write、Call请求计数均为0；有效写请求注入也在发往服务端之前被阻止。
- 在读取数值前核对NamespaceArray、DataType、标量ValueRank和UserAccessLevel。此处证明的是配置节点所观察到的只读权限，不证明OT账户在所有其他节点上的权限。
- 10种内置数值类型都经过实际线协议验证；64位整数不舍入，超安全整数范围拒绝，BAD/null保留。无隐式字符串数值化，GOOD越界、数组、类型漂移及缺失/过旧/未来时间戳不产生成功样本。
- 真实安全通道内用户名认证、错误密码拒绝、原始材料内存快照、会话签名/证书篡改、读取响应缺项与字符串替换、错误对端不降级、回调授权撤销、取消和超时排空均有验证。
- 清理任务未终态时保留active/quarantined，不因观察超时建立替代连接。实际有意保持未完成清理的QA用例验证了拒绝新连接，释放原任务后才恢复。

## 接口与边界

`services/field/opcua-readonly.ts`提供`PinnedFieldReadOnlyClient`，强制传入调用方授权断言，并在请求和最终返回后重复核对。测试使用独立布尔授权夹具；这不是已经接通的平台审批、OIDC范围或签名租约。采集代码不返回原始OPC客户端或会话。

私密profile不会把端点原文、用户名、密码、文件路径或私钥放入公共摘要；摘要绑定端点、证书、账户标识摘要、namespace、类型和物理定义。单位来自调用方的点表声明，平台独立审批尚待接入，不冒称读到了传感器物理单位。原始观测`fieldCommissioned=false`。

内核不自动发现换证、不自动重连、不使用默认PKI生成客户端证书。直接信任模型接受明确批准的RSA叶证书，证书签名算法目前为RSA-SHA256/384/512，通道PSS与证书自身签名算法是不同参数。材料加载后本次连接不重读可变路径。整个格式仍为未发布开发格式，平台治理接入前不视为冻结业务证据版本。

复现：`node scripts/verify-field-readonly.mjs`。仅启动由QA拥有、回环监听的独立服务端，不连接客户设备或数据库。完整证据在`work/field-channel-20261017/opcua-verification.json`；原始日志与临时密钥不交付。

## 下一步

按[完整设计](superpowers/specs/2026-10-17--field-channel.md)及[执行计划](superpowers/plans/2026-10-17--field-channel.md)继续实现通道策略、准确来源版本引用、独立终审/撤权、私密配置摘要绑定与准入租约，再接入现场签名协议、mTLS MQTT、配置隔离补传、平台事务接收和离线证据。完成全链及原数据/会话/恢复验证后才切换本机核心。

依据：[OPC UA应用证书](https://reference.opcfoundation.org/specs/OPC-10000-4/7.3)、[OPC UA证书与服务校验](https://reference.opcfoundation.org/specs/OPC-10000-4/full)、[NodeOPCUA客户端选项](https://node-opcua.github.io/api_doc/latest/interfaces/node-opcua-client.index.OPCUAClientOptions.html)，以及当前锁定2.187.8的实际源码和真实测试。
