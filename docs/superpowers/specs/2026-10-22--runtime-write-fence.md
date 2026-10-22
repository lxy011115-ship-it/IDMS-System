# 数据库持久写入围栏

完整目标继续：身份迁移/业务冷恢复需要持久关闭写入，不依赖单一HTTP入口或长连接。旧BusinessMaintenanceGate是临时锁，本层实现DB内CLOSED/OPEN及事务排空，先在新自有部署验证，不改原源。

每个普通业务/认证/工作流表附加ALWAYS的BEFORE STATEMENT DML/TRUNCATE触发器。写触发器先尝试非阻塞事务级shared advisory lock，再对私有gate行FOR SHARE；CLOSED或正在排空即拒绝。关闭控制器取得同键exclusive事务锁，等所有已获得shared的写事务结束，然后持久CLOSED。后来者不能等待在业务行锁上造成close/writer环路；真实锁竞争必须验证。REPEATABLE READ旧快照必须因行锁看到更新/serialization failure而不能误读旧OPEN。

runtime角色不得拥有受保护表/schema、CREATE权限、成员关系、super/bypass/repl/SET session_replication_role或直接nextval/setval能力；LOB写入口亦撤除并检查。超出支持范围拒绝登记。控制维护身份受信任，不承诺限制superuser管理员。对旧APP owner/直接序列能力的迁移仍必须做，不能只加一个触发器冒称安全。

采用新部署SQL包装，在各原schema的DDL见证触发器启用前装附加触发器；保持旧SQL函数wire，外部catalog按新部署首次固定，禁止重定已接受运行的旧见证。范围覆盖所有登记的普通表；新DDL或未知表/能力漂移使写入或控制器拒绝。初始provision阶段只有私有安装器，最终固定manifest后才是可接入运行的门。

控制器以实际systemID/DB/owner/role/catalog核绑定；关闭不依赖身份API可用，OPEN必须核当前签名ACTIVE权威。OPEN与authority写事务互斥，防验证后head改变再开门。跨多个DB的持久意图/恢复、角色冷恢复准入、全局后台登记和原实例切换仍后续；本层不宣称一次SQL锁完成跨库原子事务。

验收包括真实未升级SDK/直接DML、真实在途事务阻塞close、排空期间后来者fail fast、业务行锁反序环路、RR旧快照、连接/进程结束后仍CLOSED、关闭状态冷PGDATA恢复后仍拒写、APP改门/停触发器/序列/LOB负例、目录漂移拒绝。最终图文/视频与原方案A范围不缩减。

依据：[PG16锁](https://www.postgresql.org/docs/16/explicit-locking.html)、[事务级advisory锁](https://www.postgresql.org/docs/16/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS)、[事件触发器](https://www.postgresql.org/docs/16/event-trigger-definition.html)。
