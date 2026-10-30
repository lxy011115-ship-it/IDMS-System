# 持久围栏绑定的工作流正式归档

在既有工作流持久围栏基础上建立独立v2归档，不改v1 LIVE_REVIEW_COPY_ONLY。源必须当前DRAINED、正确cluster/DB/role OID和baseline，整个捕获/发布期间持有同一workflow session advisory lease。现有status仍要求源零连接；归档前后调用原status，中间新adapter只允许准确绑定的自己readonly snapshot/native dump连接，未知会话拒绝。

新只读holder导出RR快照，捕获38表全量行/列/索引/约束/视图/函数/触发器和两非MVCC序列。sequence稳定性来自当前NOLOGIN/connlimit0/旧连接退休，双读只作为漂移复核。固定fact session/数据库locale/collation上下文，原生pg_dump16通过相同snapshot、明确public schema、只读PGOPTIONS和固定SHA程序。结束必须真实原生进程close、准确source backend消失、全量facts复核、源holder关闭及原status再次通过，才可发布。

每次run先持久保存owner OS身份/host、snapshot/native唯一appname和准确输出路径，再连接/启动；原生意图含程序SHA/准确args。重试不能凭旧记录认定进程已死：同host准确识别并退休自有pg_dump及遗留检查助手，确认旧holder/native PG backend真正退出后才清理自有partial。原控制进程仍同身份live时拒绝抢跑；已关闭的同进程调用可重试，完成归档同参数重放不重新导出。旧源围栏一直保持，失败不自动开放源权限。

归档格式IDMSWFA2/AES256-GCM/独立key/64KiB流式/严格有界manifest和全dumpSHA，来源/围栏/context/facts/程序绑定纳入认证。完整tag、manifest和dumpSHA通过前不给恢复者明文路径。输出不覆盖，意图绑定backupId/key/output；未完成密文只在私密工作区，原子非覆盖发布。恢复仅允许新隔离数据库/最小角色，采用准确编码/locale和fact session，完整38表及2序列复核；档案不自动批准业务恢复激活，不是跨服务原子灾备。

QA使用实际非空Flowable副本，正常完整capture/认证/隔离恢复及真实重启读取，篡改/错误key/错误tenant/source/fence/refreeze/未知session/实际原生进程遗留与控制器中断拒绝或同ID重试，源所有权限数据保持。原workflow9124不冻结、不停、不切换；最终原部署需完整阶段证据和新拓扑。保留所有旧one-shot/快照。
