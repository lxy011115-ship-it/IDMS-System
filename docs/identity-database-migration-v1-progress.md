# 身份整库迁移实际验证结果

2026-10-22：在两个全新自有PG集群和两个独立Keycloak副本之间，真实完整数据库逻辑迁移通过。原身份库/原服务/云配置未切换；完整原目标继续。

最终5c0212628b9c通过10项检查、10直接源码pins逐字匹配，无QA后执行源补丁。102表/1640行、2schema、1序列、1函数、1真实LOB；custom dump266639字节，加密封装587547字节。两端启动前事实SHA一致，包含非public探针；序列下一值42、函数17及LOB内容在目标实际读取正确。逻辑列顺序保持，物理attnum不是跨逻辑恢复的稳定编号。

真实身份结果：同issuer、realm与四个user UUID、完整JWKS保持，原access JWT仍能验签；原有效refresh成功并返回从两个site缩减到一个site的当前范围，已撤角色不出现；已logout和disabled的旧refresh被拒，disabled密码登录也拒绝。目标新增target-only角色实际可见，旧restore调用与旧source/epoch1准入拒绝，源APP和维护账户连接旧身份DB均被数据库拒绝。旧JWT离线验签仍有效，不能描述成所有旧JWT即时失效。

两个新JVM35600/36928均完整正常停止proof/exit0/nullsignal；源和目标独立PG f9bdc42de29b/a7379040aaa4均正常smart stop。实际篡改ciphertext、错密钥、错issuer/context都在创建目标DB前拒绝。

失败历史保留：07577ddf40dc在4项后因pg_dump的`--file=-`写成实际“-”文件而非stdout，格式校验拒绝；确认文件头/大小/创建窗口后移入该轮私有目录并收紧ACL，未提交。30997ad5956c通过6项后，严格事实门因142处历史删列物理attnum差异拒绝；全部其他事实和数据相等，目标APP未启用。改为有效列逻辑ordinal后第三轮通过，并未放宽列名/定义/顺序或数据比较。两轮均清理自有资源，不洗白失败。

第三轮a8c75259b346已通过迁移，但site用例是旧站点替换为新站点；随后将QA加严为两个site缩减到一个，第四轮5c0212628b9c完整通过，最终执行源pins均匹配。

独立只读清理核全部4轮的8个自有PG clean shutdown、6个记录的自有身份JVM退休、7个实际创建数据库已移除（首轮目标未创建）、8个角色按OID/owner核验DROP。加密包/独立key、失败与私密运行材料离线保留。

当前能力是新受管隔离环境流程，非任意旧数据库迁移器；权威代数记录在PGDATA外私有work，尚未接入原业务R4恢复/运行准入或正式持久控制器。没有跨进程崩溃接管、全矩阵故障补偿、Linux/原实例接管、外部provider/secret完整见证、全offline/短暂认证cache会话保证。原PITR/HA/旧workflow权限/C outbox/R5/整站切换及最终同验收版本PDF/DOCX图文和讲解字幕MP4继续。
