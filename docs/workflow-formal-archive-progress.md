# 工作流围栏绑定加密归档 v2：隔离验证完成

新增独立 IDMSWFA2 归档 API、严格 manifest、64 KiB 流式 AES-256-GCM/完整 dump SHA、当前围栏 observer、原生程序持久意图及非覆盖发布。持有准确 session advisory lease；当前 cluster/DB/role OID、baseline、drainedAt 绑定，当前 DRAINED 复核前后夹住自有只读 RR holder/同快照 pg_dump。旧围栏 status 仍要求零源会话，未放宽，旧 v1 LIVE_REVIEW_COPY_ONLY 标签保持。

实际非空 Flowable QA：4状态/4工单/15提交命令。38表全量行/列/索引/约束/视图/函数/触发器及两条非MVCC序列前后核对；完整认证后新建唯一隔离库/最小角色，恢复后全量事实、编码/locale/provider/版本及session参数一致，恢复库启动实际Java后的完整非空恢复快照也一致。篡改、错误key/tenant拒绝；完成重放复用密文，实际两个hardlink别名的发布中断形态可恢复。

最终测试真实终止三个控制器：SNAPSHOT_READY、AUTHENTICATED、BEFORE_PUBLICATION，各自真实close后fresh同意图重试、认证成功，登记明文工作区清理。另用32 MiB随机QA payload，实际观察COPY public.act_ge_bytearray传输时终止控制器并fresh重试，归档事实匹配。该数据是故障路径载荷，不代表容量/SLA。

原生退休分两组证据：正常Windows附属导出进程可能随控制器退出，但PG锁等待后台仍需独立确认；该真实中断形态重试通过。另以QA专用detached owner生成确实存活的孤儿pg_dump，杀掉owner后生产退休原语按精确程序/参数/PID/启动时间实际走Stop分支，确认原生进程及PG后台均退出。生产导出保持附属方式，没有为了测试改成detached。正式程序参数固定锁等待30秒，正常监视250ms、导出总上限300秒。

联调纠正了会话时区比较、schema选择dump显式创建public的空目标冲突和认证工作区中断登记。期间还观察到维护后台会话并按保守规则拒绝；仅自有QA库禁用表自动维护并等待真实零后台窗口，不终止未知后台、不放宽原源检查。早期“Stop分支”测试发现附属OS子进程已随owner退出，未将其冒称真实孤儿Stop，最终另建存活孤儿阳性测试。所有自有QA Java/控制器/原生进程、数据库/角色和临时私密文件已清理。

原workflow9124/4016尚未冻结、未升级；两个原租户38表/两序列/原OID/LOGIN/连接上限、serviceToken/配置和两个旧jar保持。原业务/imports/五迁移/审计前缀/资料/角色、66整文件契约、十轮及887/909双份快照通过。268构件/全脚本语法及server/predictor类型通过；本轮没有重跑未变的509业务单元。当前core5356/5348与edge17428/27984及七依赖保持；后验4304条原待传清理逐条匹配PG点/回执/审计，原37145确认保持，7613待传/序号49062时签名与总量守恒，未排空。

详见[workflow-formal-archive-guide.md](workflow-formal-archive-guide.md)。16项精选源码、最终QA及阶段证据双份SHA一致，仅供审阅，不是安装包。超级管理员/OS管理员仍属信任边界；8 GiB等是拒绝上限，未经对应容量验证。

下一步：恢复内核的持久意图、真实原生恢复中断/遗留目标处理，及归档来源/权限/目录漂移的完整负例矩阵；之后原Java受控部署与新拓扑verifier。当前恢复内核会清理普通失败，但尚不是控制器崩溃resumer；不原地覆盖、不自动业务激活，不能冒称原部署、跨服务原子灾备或完整商业验收。完整方案A继续ACTIVE。
