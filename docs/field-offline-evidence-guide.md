# 现场证据导出与离线校验

使用 Node.js 24。导出限当前 ACTIVE 现场注册，执行真实 OIDC READ 权限与全租户 site/line/device 范围检查。独立 auditor 可读取，仍不能执行 AUTHOR/REVIEWER 动作。包包含完整租户业务快照及所选 edge 的点与回执，应按私密业务资料保存；包不包含配置口令、原始 token、签发私钥或事件密钥。

先在受控位置准备既有 runtime、platform、external 配置及当前 access-token 文件。所有文件参数使用绝对路径且禁止符号链接，输出父目录必须已存在。以下为 PowerShell 示例，路径需换成实际受控文件：

```powershell
node scripts/field-evidence-export.mjs `
  --runtime-config C:/private/runtime.json `
  --platform-config C:/private/platform.json `
  --external-config C:/private/external.json `
  --access-token-file C:/private/access-token.txt `
  --trust-config C:/private/evidence-trust.json `
  --public-materials C:/private/evidence-materials.json `
  --observations C:/private/evidence-observations.json `
  --output C:/private/evidence-pack.json --tenant acme --edge-id edge-01
```

输出只创建新文件。已有输出、身份撤权、恢复围栏变化、配置变化或超限均拒绝。数据库采用原 app 权限的只读一致快照，不需 backup 凭据或额外 sequence 权限。可用 `--expected-root-sha256` 固定所期待的原始 business_state JSON 文本摘要。

独立信任文件的格式为：

```json
{"format":"idms-field-evidence-trust-v1","tenantId":"acme","edgeId":"edge-01","keys":[{"keyId":"<实际keyId>","publicKeyPem":"<外部受控Ed25519公钥PEM>"}]}
```

keyId 使用已有 `fieldLeaseKeyId` 算法，公钥必须从可信管理渠道取得。最多16个键；不能从待验包自行建立信任。公共材料文件 `idms-field-evidence-public-materials-v1` 包含 `profiles:[{profileDigest,opcuaEndpoint,mqttBrokerUrl}]` 和 `certificates:[{sha256,derBase64}]`，需覆盖所有历史事件使用的 profile 和 DER 证书。观察文件 `idms-field-evidence-observations-v1` 包含同一 `tenantId/edgeId`、`events`、`acks`、`checks:[{lease,check}]`。已存事件从真实回执提取；未存历史事件可在 events 中补充。ACK/check 是可选的真实观察材料，不能用汇总报告中的布尔值替代。

将包与独立信任文件移至离线环境后执行：

```powershell
node scripts/field-evidence-verify.mjs `
  --pack C:/private/evidence-pack.json `
  --trust-config C:/private/evidence-trust.json `
  --expected-pack-sha256 <从独立可信渠道取得的包摘要>
```

校验器只读文件，要求包为规范 JSON 字节；不要手工美化或重存包。它重算平台用途域签名、根快照、审计链与序列、历史注册/准入/租约、事件/点/回执、证书和提供的 ACK/check。退出码0表示限定范围校验通过，1表示拒绝；输入原件保留。最大32MiB包、2000点和回执、25000审计、256张证书，超限拒绝。

默认校验不声称重新认证源事件 HMAC。需要直接重算时，用独立私密32字节事件密钥文件增加 `--event-key-file C:/private/event-key.bin --hmac-policy require`。该文件不能随公开包分发，校验器不会输出密钥。结果分别报告实际事件和 HMAC 覆盖数。

离线校验不能证明当前数据库状态、当前 OIDC 身份、实时对端握手、外部可信时间或物理硬件真实性。包摘要只有经独立可信渠道固定后才能限定预期包；自签包本身不提供外部防回滚锚。证书按历史捕获/接收时刻核验。最终冻结、正式现场部署与完整商业验收另行完成。
