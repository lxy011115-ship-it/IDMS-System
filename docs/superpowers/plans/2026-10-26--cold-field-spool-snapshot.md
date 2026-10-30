# FIELD 已捕获缓存字节的离线语义校验

这是已授权冷恢复材料第6步的子步骤，不替代完整材料、当前HELD、原30秒时限或正式激活批准。

1. 新组件仅接收已捕获主SQLite字节、真实历史profile/签名lease、event键、公钥、确认事件集合与容量限制。不接受authorize回调，不构造FieldSpool，不连接原spool文件或任何网络。
2. 将字节复制到自有私密临时目录，只读核验原精确schema、metadata、容量、last_append、状态MAC、每条保留事件与每条ACK；ACK必须有完整可验证的历史签名事件，历史签名不等于当前SQL提交证明。
3. 私密HMAC绑定输入数据库字节、容量和所验证事件集合；临时数据库正常关闭后，只删除该组件新建目录中的固定文件，再删除空目录。不修改原数据库/WAL/SHM。
4. 用已接受SOURCE32真实材料副本进行正例和篡改测试，包含MAC重封后事件/ACK签名失败、确认事件遗漏、结构/容量/绑定错误。原材料字节和身份、两个SOURCE store及已发布源pins保持不变。受限owned launcher执行，保留所有失败版本。
5. 本步骤成功也只证明提供字节和提供密钥的语义。后续必须把它与整体私密MAC、空WAL身份、实际SOURCE和当前HELD绑定，并完成当前SQL/身份、真实设备传输、broker ACL及程序批准。

执行结果：原版本1实际12/12 normal0+原host0。原44材料和两SOURCE store保持。此结果只证明提供字节/键的缓存语义；实际SOURCE完整map历史成员投影、整体文件MAC/空WAL和当前HELD组合仍待。requirements-status-v26.json为最新状态。
