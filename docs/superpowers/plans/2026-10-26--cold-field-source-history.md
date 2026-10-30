# 实际SOURCE历史与缓存字节组合

1. 新版本保留原完整map文件、全部节点/根/receipt链、完整domain/audit payload和FIELD runtime索引校验，在已认证私有leaf缓存关闭前投影全部FIELD lease、registry和STORED/REJECTED receipt及point，调用原inspectFieldMapReceiptV1验证历史决策及审计。
2. 部署侧wrapper只从实际只读SOURCE选择tenant map文件和facts，前后检查文件身份/哈希及SOURCE不变，结果用私密HMAC绑定到该SOURCE；不接caller替代文件/facts/events。
3. 新snapshot2保留原12项版本的全部结构/MAC/事件/ACK语句，增加所有事件lease body与所提供来源issuance的对应，以及ACK audit/time/point与所提供来源receipt的对应。新组合wrapper自行读取真实SOURCE历史，再使用snapshot2，不能由caller提供历史证明。
4. 使用真实SOURCE32启用/明确关闭两来源及缓存主库字节测试完整投影和组合。修改叶值、删除receipt、缺失/错历史key、替换ACK来源outcome、移除pending来源lease均必须拒绝。原材料和两来源库、已发布pins不改，旧12项不重跑。
5. 仍未绑定whole private FileSet/空WAL与当前HELD，未证明当前SQL/身份、实际连接、程序批准或完整FIELD。接下来与整体材料编译器和原30秒会话组合，保留原全范围验收。

执行结果：实际8/8 normal0+原host0；44原FIELD材料、两来源store和4原完整map证据字节身份保持。SOURCE完整历史与缓存副本已组合；whole FileSet/空WAL、empty/no-ACK流全覆盖、当前HELD/SQL/身份/设备与broker程序批准仍待。最新requirements-status-v27.json。
