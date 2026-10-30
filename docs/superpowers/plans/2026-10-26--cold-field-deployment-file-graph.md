# FIELD 整体配置和私密文件清单

这是既有冷恢复全材料第6步中的文件图编译部分。最终仍必须完成真实当前HELD、核心SQL/身份/设备传输组合、独立批准、最后准入及完整系统交付，不能用文件图替代它们。

1. 从真实不可变SOURCE扩展取得完整已配置企业集合及所有通道；现有SOURCE32案例启用sandbox，acme保留历史且未配置。显式关闭SOURCE另有真实来源，不能从新声明推断关闭。
2. 新租户材料loader2验证全局intake企业集合后选择当前企业，保留原纯字段、证书、密钥、MAC和关闭行为。原loader1与其11项证据不修改或重跑。
3. 统一遍历SITE、gateway、host引用、平台签发端、各企业材料、Broker服务器/探针证书私钥、实际broker程序和DLL、离线spool文件及schedule所在配置。所有路径受明确根约束、禁止源/目标PGDATA；所有原始字节进入私密HMAC，不发布私钥/口令摘要。
4. Ed25519 signer必须匹配SOURCE registry leaseKeyId。平台profile、request/event键必须逐通道匹配已核边缘端及来源；禁止跨企业密钥复用、遗漏或额外通道；Broker证书、端点及通道集合完整对应。
5. 用原已接受32项案例的文件做独立副本验证。源文件与两SOURCE store不修改；新测试通过受限owned launcher执行，源码和失败均保留。程序只读取，不执行SQL、设备或broker进程。
6. 本组件明确不证明当前目标账号/权限、实际启动程序批准、spool语义、broker应用ACL、当前HELD和正式激活。SITE核心和authority引用的完整语义由核心编译器和当前身份组合检查承担。随后把同一私密文件集合接入原30秒会话、真实传输和完整Native独立复核。


执行结果：原版本1实际7过2失败，失败保留；整体编译器2及tenant-loader2新版本11项已normal0+原host0，覆盖真实启用/明确关闭SOURCE、平台signer及双侧密钥、broker配置/密钥、全企业通道和空WAL身份等。原44文件身份字节及两SOURCE控制store保持。合法零WAL/SHM按SQLite官方说明纳入私密清单，原FileSet非空约束不改。当前HELD、目标SQL/身份、设备传输、spool语义、broker应用ACL和程序批准仍未证明。最新requirements-status-v25.json及根记忆为准。
