# 现场源码与公开证据快照核验

修订快照使用目录后缀如 `field-channel-20261018-2`，配套独立清单；已冻结副本保留，不原地覆盖。

源码审阅快照采用 `idms-field-channel-review-snapshot-v1` 清单，包含明确路径、字节数和 SHA256。快照与同目录清单分别保存；它用于复核开发源码和公开验证范围，不是安装包、现场准入或商用验收。

使用 Node.js 24，给出绝对路径：

```powershell
node scripts/verify-field-review-snapshot.mjs `
  --manifest C:/review/field-channel-release-verification.json `
  --snapshot C:/review/field-channel-20261018 `
  --expected-manifest-sha256 <独立可信渠道取得的清单SHA256>
```

校验器只读输入，检查清单结构、文件路径、完整文件集合、长度和摘要。缺失、多余、重复大小写路径、路径穿越、符号链接、硬链接、错误摘要及超限均拒绝，原件不修复、不删除。最多2048文件、每文件16MiB、总64MiB；退出码0表示限定范围检查通过，1表示拒绝。

未提供独立预期清单摘要时，只能核对该清单所描述的内部一致性。预期摘要也需要从可信渠道固定；自报清单不证明发布者、外部授时、当前运行状态或防回滚。校验成功不会批准部署、恢复或现场采集。第三方依赖/许可清理、干净安装、运行密钥、生产安全与商业门槛仍需分别验证。

源码快照与现场业务证据包不同。业务证据的Ed25519/历史事件/回执重算见[离线证据说明](field-offline-evidence-guide.md)，机器协议见[接口说明](field-machine-api-guide.md)。
