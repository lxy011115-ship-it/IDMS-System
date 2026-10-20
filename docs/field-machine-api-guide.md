# 现场机器接口说明

接口定义见 [OpenAPI](api/field-machine.openapi.json)，独立描述 `/api/v1/field-channel/lease` 和 `/api/v1/field-channel/lease/check`。已有业务 OpenAPI 保留原版本；此文件不包含人类治理视图、MQTT 消息或维护审批接口。

两个接口均为 POST，原始正文最多4096字节，必须使用 `application/json` 且无查询串。`Origin` 和 `Cookie` 请求头必须完全缺省。认证使用正文中的独立 HMAC；人类 OIDC 令牌不能代替该认证。

使用 `integrations/field-request.ts` 的 `signFieldLeaseRequest` 和 `integrations/field-check.ts` 的 `signFieldCheckRequest` 生成请求，使用 `services/field/lease-client.ts` 管理租约及连续当前核对。签名域中的 `\n` 表示实际换行字节；不能以普通 `JSON.stringify` 的插入顺序代替规范编码。私密32字节 request key 与固定平台公钥从受控配置加载，不放入请求或公开说明。

签发成功只在持久审计 COMMIT 及恢复围栏复查后返回 Ed25519 租约；租期最多30秒并受批准生效边界裁断。当前核对只读、不续租，结果最多有效2秒。客户端须核对实际签名、一次性挑战、原租约摘要、完整源/注册/配置绑定及时间，不能只读取 `allowed`。

`HTTP 200` 的当前核对可能是签名的 `allowed=false`。HTTP 错误没有授权签名；401、409、503或超时均不能用旧缓存继续读。恢复身份变更后必须取得新流授权，旧事件和ACK不能改绑至新队列。事件、mTLS、队列及恢复工具分别见既有现场操作说明和[新流指南](field-recovery-new-stream-guide.md)。

Schema只约束公开结构。请求年龄、租期/核对期限、整数修订字符串上界、允许/拒绝字段关系、密码学签名、当前批准和恢复围栏还由生产解析器及服务核验。回环之外需要HTTPS；此接口说明不等同生产TLS配置或真实现场投运。
