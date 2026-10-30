# 正式恢复命令的活跃COPY与协议提交故障验证

延续已批准的第6项恢复门槛，不更改恢复权限和激活条件。仅新增自有QA夹具，三类、四个场景均走真实v3归档、源库不可连接、非UTC、ALWAYS迁移触发器、2点2回执的正式restore-target。原4010和已有历史资料保持。

1. 代理由测试监督者持有，不随被测控制进程退出。真实psql进入数据事务，先完整转发至少一个非空COPY并观察真实服务端CommandComplete(COPY N)、N>0，再截住下一COPY的CopyInResponse；监督者从pg_stat_progress_copy确认该后端正在COPY、backend_xid非空且后端active/ClientRead，再终止控制进程。小批COPY可能直到批量刷入才更新tuples_processed，因此不拿当前表的零计数冒称已处理行，使用同一会话/事务中真实服务端已完成的前一COPY行数为证据。直属子进程场景记录控制进程结束后旧psql实际仍存活或已终态；另设独立持有场景，由监督者直接启动固定真实psql，逻辑控制器通过仅转发实际close的IPC适配器等待它，必须证明控制进程终止后旧psql和代理连接仍存活，不冒称其物理父进程属于被终止控制器。新正式控制进程先退休旧原生及PG后端，在重新APPLY之前独立只读检查34个物理表全空、旧COPY后端已不存在，再恢复完成。pending重试必须沿用同一计划、SQL生成一次、相同参数和全部输入SHA。
2. 数据段COMMIT：仅在实际前端COMMIT后，丢弃真实服务端CommandComplete(COMMIT)并断开连接。psql必须实际非零退出；正式协调器按已提交数据阶段继续，data APPLY总数仍为1，完整事实与唯一核验审计通过。
3. 最终核验COMMIT：只给目标control会话代理，在标记的最终核验COMMIT后丢弃真实服务端完成消息。该CLI连接失败退出、结果文件不存在，但数据库已VERIFIED/唯一审计1。下一正式CLI完整重验并补写同一结果，数据段不重复APPLY，后续重复无根/审计/序列变化。

代理绑定loopback、目标QA库、明确角色及application_name；有界解析，不记录或保存认证/COPY/SQL消息正文。所有自有控制进程、代理socket、旧原生进程和匹配PG后端确认终态后才能清理已核对的自有QA目录、库和角色。未知进程不停止。只有测试探针重定向已绑定连接的传输层，生产恢复代码没有跳过权限、输入或现态验证的开关。

依据：[PG16消息格式](https://www.postgresql.org/docs/16/protocol-message-formats.html)、[Node内置模块绑定同步](https://nodejs.org/docs/latest-v24.x/api/module.html#modulesyncbuiltinesmexports)。文档和探针进入点不构成验证通过证据，以真实场景输出和当前状态为准。
