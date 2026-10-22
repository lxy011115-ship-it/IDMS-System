# 实施顺序

1. 新建显式 provisioner，记录实际 DB/角色/表，支持 fresh 初始化、一次 seal 和全库 close。
2. 新版 R4 factory 链覆盖全部 schema，旧源码不改；Flowable 正常停止后移交给 NOLOGIN owner。
3. 新自有业务 PG 与独立身份 PG，真实 R4/认证/队列/Flowable通过后检查逐库拒写与回读。
4. 接入持久维护互斥/操作意图，注入控制进程中断并按原 operation 续接，继续真正冷恢复准入。
5. 清理自有测试资源、核原运行环境、发布源码与准确的验证范围；不缩减完整方案和最终图文/视频交付。
