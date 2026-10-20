# 恢复激活实际材料与对端核验

恢复计划中的公开指纹不能代替实际证书和对端。当前新增root侧材料核验能力，并通过prepare的materialConfiguration参数接入activation attempt-v2。总协调器与activate/recover操作命令仍待实现；将来该入口必须强制使用v2，不能选择不检查材料的旧兼容分支。

固定私密配置格式为idms-field-activation-materials-v1，包含当前tenantId、intakeConfigurationFile绝对路径以及完整edges数组，每项为edgeId与configurationFile绝对路径。所有通道必须与已批准candidate准确匹配；当前使用一份只包含恢复企业的intake配置。Windows绝对路径支持正斜杠和反斜杠，读取前归一化，拒绝符号链接、硬链接、路径别名和重解析逃逸，不创建目录或修改配置。

例如（路径须替换为实际存在的私密文件）：

```json
{"format":"idms-field-activation-materials-v1","tenantId":"acme","intakeConfigurationFile":"C:/IDMS/private/acme/intake.json","edges":[{"edgeId":"edge-a","configurationFile":"C:/IDMS/private/acme/edge.json"}]}
```

edge配置复用既有idms-field-edge-config-v1格式，包含private profile、OPC UA证书/私密键/用户名口令、MQTT材料、请求/事件键和平台Ed25519公钥。intake复用idms-field-platform-intake-v1。加载不启动edge、不申请租约、不打开SQLite；检查完整private/public profile、当前注册键摘要及签发公钥标识，并复用既有证书时效、RSA用途、主机名/URI、私密键配对、CA与公开pins及本地吊销列表校验。每个文件大小和整个材料集合32MiB有上限。

FieldActivationMaterialInspection保留私有的随机256位指纹密钥，不导出该密钥。材料/口令及实际只读观察使用带该随机密钥的MAC承诺，不输出口令摘要、采样值或私密材料；不同inspection的MAC不作为可跨次比对的口令指纹。公开记录包括配置SHA、公开证书pins、实际协议/证据类型、样本数、有限服务和权限边界，source profile与根操作绑定准确。单次能力最多30秒，并受单调时间及证书最早到期限制，不能通过序列化证据重新取得能力。

核验先执行当前权限回调，再使用既有PinnedFieldReadOnlyClient进行实际SignAndEncrypt连接、用户名认证、namespace/type/UserAccessLevel及限定点只读采样；不调用Write/Call，不接收任何待执行远程命令。随后对EDGE与PLATFORM各执行实际TLS连接和不带client certificate的负试验，确认对端要求客户端证书。最多4个通道并行，错误/取消时等待所有连接实际关闭并清除材料。

不会发送MQTT CONNECT/订阅/发布：当前broker可能用证书CN覆盖Client ID，随机ID也可能替换正常连接。TLS 1.2要求观察实际发送的client certificate及完整握手；TLS 1.3要求新握手后的server session ticket，并在真实出站ClientHello转发前禁止PSK、early_data和ticket_request扩展，以免把早期票据当作客户端认证完成的证明。此机制依据[当前Node TLS文档](https://nodejs.org/download/release/v24.20.0/docs/api/tls.html)、[RFC 8446](https://www.rfc-editor.org/rfc/rfc8446.html)和[RFC 9149](https://www.rfc-editor.org/rfc/rfc9149.html)，通过公开generic Duplex接口检查实际消息，不固定某个Node补丁版本。

如果TLS 1.3后握手证明不可得，仅可重新连接服务所支持且原策略已允许的TLS 1.2，并要求同一pins/证书/认证证明；绝不低于TLS 1.2，也不在证书错误后降级。仅支持TLS 1.3且没有后握手票据证明的对端明确拒绝。该限制不被计为已支持。主题ACL/QoS/业务消息和新流另须正式激活后的全链验证，此检查不声称已验证它们；没有在线OCSP或外部设备硬件证明。

prepare在真实APPROVED目标和当前独立OIDC审批者/作者/Flowable核查下执行材料检查。证据作为attempt-v2的一部分由实际激活审计/phase中的attempt SHA绑定；原生ACTIVE发布后，最终闭包重新加载全部私密材料并核对同一次随机MAC、时效和当前外态。材料字节变化拒绝且保留，不能自动修复。旧v1保留历史校验及内部回归，不代表可绕过将来的正式入口。

真实隔离测试包括UA用户名/只读metadata、两角色mTLS、无证书及可选证书对端、错误wire leaf、TLS 1.2/1.3、真实代理截住后握手证明、可用TLS 1.2回退、硬链接、口令/配置字节漂移和held read取消。正常已连接的MQTT EDGE/PLATFORM核验前后仍能双向传输。另在非空4工单15outbox的完整归档/源不可连接/新目标恢复和独立plan-v2之后检查真实材料，提交前口令变化及作者撤权拒绝、真实COMMIT/控制者终止/新上下文回执恢复继续验证；Chrome审批与外部漂移拒绝单独记录。原正式FIELD未部署，未把这些测试作为生产commissioning。
