# 工作流捕获发布边界修订与遗留恢复进程验证

真实旧入口基线复现6个已发布副作用：捕获中控制DB ACL变化，密封前/发布前key变化，发布前源LOGIN变化，同字节dump inode替换，以及未知run文件。后两者是在发布后清理报错。基线21例中的source-inherit另有一次“已安全拒绝但期望错误码列表漏项”，不算发布漏洞；失败记录保留，不改旧源码和历史归档用途。原服务尚未用这些故障场景捕获原库，测试产物均位于一次性私密QA根并已清理。

新增独立createGuardedWorkflowArchive与readonly边界guard。持续核对controlDB/owner/membership/ACL、控制表OID/owner/ACL/RLS/触发器/列结构并绑定能力摘要；完整源catalog比较当前冻结baseline，保持旧observer的准确lease/reader/native准入。key指纹、独占工作根、run文件集合和native dump物理身份在密封前检查；发布回调返回后再次检查当前源零会话、权限/key/目录和stage proof。完成重放认证后也复核当前边界。旧入口及16源、恢复11源均保持，新受控部署必须选修订入口和新专用工作目录。

当前guarded-current实测31项全部拒绝且发布数为0：cluster/tenant/operation、authority ACL/控制表ACL/RLS/owner继承/表OID替换、源LOGIN/连接上限/继承/密码验证器/ACL/membership/未知会话/阶段/lease丢失/角色OID与DB OID替换、非MVCC序列漂移、key密封和发布边界、dump inode/硬链接、未知run/root文件/外国恢复工作根、stage硬链接和输出junction。OID替换和junction为实际对象，不是mock；未知客户端被拒绝后仍能SELECT，产品没有终止它。非OID catalog/key变更由QA显式恢复，最后源DB OID替换是一次性QA场景，旧控制操作不冒称可释放。

正常路径也通过：新入口完成capture、认证重放复用原密文SHA，通过持久恢复协调器还原全部38表、两序列和上下文；发布前/后两个真实控制器kill/close后fresh同意图认证继续，发布后复用已提交归档。link是提交点，提交后进程退出可能已有有效归档，不能用“有错误一定无文件”替代实际发布状态核对。注入前出现会话拒绝时，只有真实旧进程退出并观察源后台归零才有限fresh重试，绝不放宽产品会话检查。

遗留恢复阳性单独完成：QA owner启动两个detached pg_restore，kill owner后确认两个真实原生进程仍存活；生产退休原语精确Stop第一个，第二个仍存活，再单独Stop第二个。释放QA独占锁后两个SQL后台实际退出。生产恢复仍attached，退休模块源码保持。输入旧LIVE_REVIEW_COPY_ONLY仅供原语QA，不升级为正式恢复资格；先前状态机实际COPY/源离线恢复证据另保留。所有自有控制器/原生进程、QA库/角色和私密文件已清理，最终CIM与两个QA根目录复核无残留。

后验原workflow9124/4016及两原38表/两序列/OID/LOGIN/连接上限、serviceToken/配置、两个旧jar保持；原业务/imports/五迁移/审计前缀/资料/角色、66契约、十轮/887/909以及旧工作流源副本保持。268构件/全部脚本语法/server和predictor类型通过；未重跑未变的509业务单元。当前core5356/5348、edge17428/27984和七依赖保持；6516条原待传清理逐条PG点/回执/审计守恒、37145旧确认保持，6460待传/50121序号时签名与总量守恒。积压未清空，FIELD实际签发/接收仍未配置。

指南见[workflow-capture-guard-guide.md](workflow-capture-guard-guide.md)。10项精选源码、基线/当前矩阵/原生阳性及阶段证据双份SHA一致，不是安装包。管理员仍属信任边界，最后检查到link之间不能抵抗恶意管理员并发；4096根文件上限不是容量承诺。下一步直接准备原workflow受控升级：准确退休旧进程、实际源持久围栏、使用修订入口正式归档与真实隔离恢复、保留旧配置/两jar后启用新私密reader配置和新拓扑核验。当前尚未冻结/切换原workflow，不构成跨服务灾备或完整商业验收，完整方案A继续ACTIVE。
