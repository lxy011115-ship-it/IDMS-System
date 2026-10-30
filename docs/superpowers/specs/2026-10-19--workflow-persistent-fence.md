# 工作流数据库持久写入围栏

补齐正式工作流备份缺失的非MVCC序列静默门槛。使用独立控制数据库/NOLOGIN owner和仅受信任bootstrap运维连接，操作记录与cluster/shared catalog变更在同一PostgreSQL事务提交：源业务角色NOLOGIN、源DB CONNECTION LIMIT 0、操作FENCED状态。控制库不改源38表或两序列，记录准确cluster/sourceDB/role OID、原属性/ACL/成员关系/密码验证器摘要，准备时要求独立最小owner角色、仅拥有目标DB和无跨库会话。

普通用户与源角色不能在提交后新连接；已连接的源角色只有在精确pid/backend_start/datID/roleID实际退休后才能确认DRAINED。未知会话、两阶段事务、订阅、共享源角色、属性/凭据/权限漂移均拒绝；不杀未拥有的其他会话。角色NOLOGIN和DB上限0在控制进程死亡/机器进程重启后保持；只读内存开关和两个序列的双读都不替代该持久状态。

所有控制动作按源DB持有session advisory lock，并对同目标活动操作唯一约束。PREPARED/FENCED/DRAINED/RELEASED可读取与同ID继续；提交前死亡应原子回滚，提交后丢回复/进程退出应通过持久行+真实catalog辨认，不能重复覆盖原属性。释放在一个事务里精确还原原LOGIN及connlimit并标记RELEASED；不改ACL、密码或数据，漂移拒绝不自动修复。RELEASED不能用同ID再次冻结。

围栏限制应用写入，受信任superuser运维仍可访问，不能宣称抵抗管理员或OS账户。正式归档后续需把受控只读管理连接/原生dump和当前围栏绑定；本阶段只实现停写/退役/精确还原，不生成正式工作流归档，不启动原Java替换。

隔离实际PG验证：原38表QA副本、已连接长事务及两非MVCC序列，提交后新连接/nextval/写拒绝、老事务真实退休/回滚、精确还原和可写恢复；真实控制子进程在准备/冻结/退役/释放各提交边界退出，fresh进程同ID恢复；并发控制锁、未知会话、属性和OID漂移拒绝。原workflow9124/配置/角色/数据保持，所有owned子进程/库/角色清理后才发布。QA进程barrier仅fixture提供，不在CLI/私密生产配置中加入故障开关。
