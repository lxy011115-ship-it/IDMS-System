# 实施与检查

1. 核旧schema/DDL计数与catalog，不改原部署；统一fence schema及fresh SQL包装。
2. 实际catalog/角色/表/序列与LOB权限登记和pin，CLOSED持久化与CAS控制。
3. 实际旧SDK和SQL并发/死锁反序/RR/故障/冷恢复验证；拒绝越权与漂移。
4. 当前权威OPEN绑定与控制互斥，完整清理、原系统复核、Git发布。
5. 继续全局跨DB持久控制和原R4恢复准入，不把此层当整体完成。
