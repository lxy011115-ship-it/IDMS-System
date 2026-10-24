# 当前根现场恢复的封闭维护事务

承接完整现场恢复审批设计与 current-map 接入核对，实现底层存储适配。此层不提供用户授权、正式激活或普通 HTTP 入口。最终仍须由真实冷恢复上下文取得归档/源离线/原维护链能力，独立审批协调器持久记录意图并完成当前 OIDC/Flowable 核验。

只接受调用方已开启的 bootstrap 事务、固定冷捕获 inventory、目标真实目录、state-map 与 runtime-fence 目录见证、精确 CLOSED operation/revision。实际全簇 inventory 必须等于原清单仅将目录改为目标、全部业务角色 NOLOGIN/connlimit0、全部业务数据库 connlimit0 的形式。源清单结构、OID、成员关系、角色配置和权限不得重定基线。

以保存点保护本层所有变更，按 runtime-fence、state-map 顺序取得事务锁并锁住当前根。事务内暂存完整原角色/数据库 LOGIN 与连接属性，验证原目录、固定结构、实际 bootstrap 身份及映射 writer/reader/owner。使用 SET LOCAL SESSION AUTHORIZATION 调用原读取和增量提交函数，不修改 SQL 函数、触发器或 GRANT。普通角色的默认会话参数不随身份切换加载，显式固定本层日期、时区、search_path 与 SQL 时限。

快照只暴露当前根、经成员证明核验的有界 state/get/operation，不暴露 client、角色变更或 COMMIT。增量调用明确绑定原 expected head、command UUID、准确请求摘要和两次围栏 operation UUID；原函数返回的回执必须通过完整摘要、前根/后根及链校验。失败回滚至本层保存点，并恢复原身份；如果回滚不能证明成功，则要求调用者整笔回滚并关闭该连接，不提供 prepared 结果。

写入完成后以原请求的 close operation/revision 将围栏恢复 CLOSED，恢复全部 NOLOGIN/连接上限0，核完整 inventory 与原结构不变；只有此后才能释放保存点并返回不可变 prepared witness。调用者拥有最终 COMMIT，必须将原根、SQL receipt、before/after fence、清单与目录摘要写入恢复阶段/不可变意图，处理丢提交回复并证明旧 socket 终态。此层不把客户端异常当作回滚证明，不自动重试未知 COMMIT，不据此调用旧 cold.admit。

只读结束不改变围栏 revision、不留下角色变更。未完成的快照不能并发操作，事务结束或出错后不可复用。所有失败保留原首错，清理失败另附；不能掩盖为成功。正式激活的 ACTIVE 文件发布、当前外态复读和全平台最终开放仍属于后续协调器，不能由此处的维护 prepared witness 替代。

验证使用全新自有 PG 和原 SQL：错目录/OID/清单/目录摘要/CLOSED代数拒绝；外部 app/reader 在维护期间及提交后都无法登录；快照成员证明和真实增量保持；失败恢复保存点后调用方即使 COMMIT 也保持封闭和原根；未提交 prepared 回滚无数据；真实维护 COMMIT 保留新根而全角色与围栏封闭；同一命令和未知提交解析不得重复数据。跨租户、容量、SQL 错误和实际资源退役分别核验。
