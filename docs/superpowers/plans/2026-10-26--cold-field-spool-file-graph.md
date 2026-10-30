# 完整FIELD文件图中的缓存流校验

1. 从已认证SOURCE lease body及其registry观察推导原stream binding全部字段，与原签名lease计算结果逐字段等价。此纯投影不签发lease、不授权；缓存内每个实际事件的原签名/租约验证不变。
2. 新snapshot3可从提供的issuance body核metadata绑定，不要求已有ACK或外部context签名。生产组合2只能使用真正SOURCE历史，校验全部pending/ACK issuance及ACK audit/time/point，并拒绝sequence落后于来源已保存事件。
3. 新SOURCE历史reader2提供深度不可变的原WeakMap owner和close；全材料编译器每企业仅完整重建一次，多个流只能复用同一原owner，复制/旧版本/关闭对象拒绝。
4. 新whole文件编译器3保留原全部字节/空WAL身份/证书/密钥/路径/全企业覆盖，所有捕获主db字节直接进入新缓存组合及总私密MAC。描述v2可提供历史stream的profile/eventKey/公钥文件，每项必须对应真实SOURCE历史，覆盖密钥轮换；跨企业/通道/请求事件角色密钥复用拒绝。
5. 测试真实whole非空SOURCE和no-ACK组合、empty提供body纯组件、空回退/未知流拒绝、历史材料SOURCE对应、历史错钥、原history owner生命周期及真实disabled。empty且来源也无任何已保存事件的完整新Native案例仍须后续真实构造；不能用纯组件通过替代它。
6. 原44材料/两SOURCE store/四fullmap材料保持，旧成功11/12/8不重跑。所有新源码和失败在执行后冻结。结果依旧source-only，当前HELD/SQL/身份/真实设备/broker ACL和程序批准及正式激活仍待。

执行结果：新10/10 normal0+原host0；whole文件图3已将实际SOURCE历史、全部捕获spool语义、所有原材料字节和空WAL身份纳入总私密MAC。原44文件、两来源store及4 fullmap材料不变。真实空流/密钥轮换Native、原30秒HELD/完整核心SQL与身份、实际设备/broker程序批准仍待。最新requirements-status-v28.json。
