# v4治理与导入的原子大事务

模板创建/编辑/提交/独立批准，以及导入创建/独立批准，已通过v4维护协调器接通。大批变更在独立准备根构造，完整验证后一次发布业务数据、审计、来源治理和读目录。原站点仍运行冻结913源v2；这是已验证的服务端内核和独立QA宿主，尚未接入原站点的治理HTTP、后台调度、文件解析及AI任务。

## 安装与边界

SQL实现3由 scripts/state-map-schema-v3.mjs 生成，只用于新建、明确归属的数据库。它固定已发布v2生成器SHA，保留COMPRESSED_SMT_COUNTED_V1的根、节点ID、原apply、证明格式和保护器，新增branch_heads、不可变branch_steps和受限函数。旧14基础源/SQLv1及v2生成器不改，不对原运行库在线DDL，不在目录漂移后盲重绑。跨现有部署启用仍需迁移与完整回归，不能直接在原库运行新schema。

SDK PostgresStateBranchV1 固定数据库OID、角色OID、完整目录摘要。READER能读受保护状态/证明，不能begin/stage/publish；APP不能直接写表、私密_ctx或内部函数。新增ALWAYS写/截断保护器与既有DDL advisory锁、非MVCC epoch共同生效。branch固定公开base revision/root/receipt；每个stage仍受64项/8MiB与逐键旧值CAS、audit/receipt/blob不可变规则约束。

stage只提交内容寻址节点/值、独立进度和step回执，公开head及其回执链不变。发布同时校验公开base和最后step的revision/root/receipt，在同一事务插入原格式公开回执、切换head并标记branch已发布。整份候选无论多少stage，发布使公开revision只增加1；外围围栏、意图和计划准备也有自己的元数据事务，不能把整个维护过程宣称只有一个数据库事务。

stage请求/回执、branch seed与发布请求使用不同二进制摘要用途，绑定租户/branch/命令/前后根/回执。SDK只在成功COMMIT后返回；真实COMMIT回复丢失报告UNKNOWN，重连按原命令解析证明。公开base漂移拒绝发布，不自动重基或采用新输入。旧根及所有历史节点当前仍保留，未实现保留删除或失效branch/孤立计划清理。

## 治理协调器

服务端通过 GovernanceCommandServiceV4.execute(commandUuid,command,authContext) 调用。authContext必须来自既有真实OIDC/会话解析，不能从浏览器请求体接受角色、actorId或scope。支持六个action：TEMPLATE_CREATE、TEMPLATE_EDIT、TEMPLATE_SUBMIT、TEMPLATE_APPROVE、IMPORT_CREATE、IMPORT_APPROVE。id定位已有模板/批次，input沿用原领域规则的expectedRevision/contentDigest或expectedVersion/snapshotDigest。

协调过程如下：

1. 在读取缓存回执前检查OIDC真实用户、派生权限和管理员scope，核对当前活跃租户、control与公开来源配置摘要。command UUID按主体/租户固定，输入摘要变化拒绝；结果重放也重新核对当前领域范围。
2. 不可变意图分块准备后，以短CAS事务写入UPDATING和持久job。此前已规划的采集提交因根冲突重评，随后在活动门前拒绝；查询也拒绝，不向上游签业务ACK。
3. 维护路径完整读取/验证旧payload，在独立工作区调用原create/edit/submit/approveTemplate或create/approveBatch；保留独立终审、防本人批准、版本/摘要、范围、资料/更正/设备类型依据及原审计格式。确定的业务错误保留失败回执并恢复旧ACTIVE，不写半份业务。其他异常保留围栏，要求同命令恢复或明确修复，不盲开门。
4. 重新编译全部来源治理时间树和资产目录，形成逐键旧值CAS差分；业务实体/顺序、审计/顺序/头、治理/读指针、完成回执及新ACTIVE控制进入同一候选。不可变计划先持久化，随后CAS固定唯一计划；PLANNED之后不再往公开根追加准备内容，避免破坏branch base。计划中旧值不会以重试时的新值替换。
5. 按32项/约4MiB分批stage；step命令由固定计划和序号派生，可在另一进程逐步解析/重放。发布前从候选根重新构造完整payload，核对预期摘要和控制锚，独立遍历全部可达节点重建根，并对全部可达原值字节重新计算hash。没有完整候选证明不发布。
6. 一次publish同时公开新业务/旧格式审计、索引和ACTIVE。成功结果还须在新连接验证命令完成回执及对应不可变SQL发布回执。UNKNOWN不能当成功；同请求重试恢复既有结果，不新批次、不重复批准或审计。

新的治理anchor及读目录generation会使旧HTTP游标要求刷新；单独追加采集数据仍可沿用原窗口。历史根/旧点/冻结治理依据不会被改写。定义更正改变当前批准引用后，旧来源映射按原规则拒绝新数据，必须再独立批准新映射；旧STORED回执继续按其业务时点核验。

IMPORT_CREATE接收维护上游已解析的rows及冻结originalBase64、filename/MIME/sourceKind、映射/类型/更正引用。这里不是新的原始文件HTTP解析器，接HTTP前必须复用受控CSV/XLSX/JSON解析与冻结绑定，不能让浏览器任意声明“解析结果”。AI明确使用unavailable→HUMAN_REVIEW，批准须人工reviewResolution；未伪造网关结果，影子AI/outbox仍待接。原领域的100批次/10000行等现有限制仍在，不代表商业容量验收。

维护准备仍完整重构、重编译和全根核验，限于既有64MiB分块文本、维护读取2百万键/1GiB等预算；它不是所有常规写者已完成有界依赖闭包。正常采集和查询继续沿用有限证明，不把全历史加载放回每条采集路径。

## 已执行验证

work/state-map-branch-v1-20261019/7a81363cb9ce 在两新库通过原15组语义守卫及13组branch检查。16批准备1024键，全部成员逐一证明、每批独立重建完整根，公开根始终不变；另测竞争与丢回复后，整个候选一次发布仍只增加一个公开版本。原根缺失证明与新完整根均有效。stage与publish的成功COMMIT回复分别被真实代理丢弃，新连接恢复同回执。新增表直接DML/复制模式截断拒绝，真实新表DISABLE DDL等待advisory锁且回滚仍污染epoch。初次两失败均为测试适配问题：新增外键先拒绝旧截断语句、误把非空租户用于空基线；两轮各2库6角色已清理，再fresh全过。

最终 work/governance-command-v4-20261019/7af99023f56c 执行全部六动作及真实更正：96 DEVICE创建后明确转人工、本人批准拒绝且完整payload不变；另一Node17148在首个已提交stage后实际exit0，公开业务仍HUMAN_REVIEW/零新增记录、采集/查询拒绝，新实例同计划恢复后一次提交96行、唯一IMPORT_COMMITTED。批准后115个范围内资产逐条匹配旧effectiveRecords/dataScope。

模板编辑后旧版本submit拒绝且payload不变；独立发布新source policy正确退役旧版。最终发布COMMIT回复被实际丢弃，首call UNKNOWN，fresh同命令从已提交回执恢复且不重复审计。未来恢复生效后原接收器STORED；随后新POINT_DEFINITION更正经独立批准，旧映射拒绝新输入，旧STORED点/回执仍可历史核验。8个候选全payload/根及全部可达值字节核对，全旧格式审计链有效。QA只控制自有Node业务时钟，未改变OS时间。

业务三轮各4库14角色、基础三轮各2库6角色均按记录OID/owner清理，私密child配置删除，无FORCE/未知后台终止。23重点单元（新branch及治理授权2项，加原基础/模板/导入21项）及268构件/全脚本/server-predictor类型检查通过；此前509单元/13组完整业务回归未在本轮重跑。

## 接下来

将该内核接到受信写HTTP和持久作业调度：明确接受/进行中/失败/已提交状态，同请求恢复并在恢复/回执前重新核对真实身份权限，避免长维护准备占住普通HTTP。再接文件解析、真实AI、全部其他写者/数据查询/六原文件/CSV、OIDC加密共享会话/工作流与全量恢复回归后再安排原站点切换。真实FIELD、保留删除、跨服务HA灾备、安全、模型/RUL、SaaS/私有化/许可等完整方案A目标继续ACTIVE。

本轮18精选源双份保留，不含原客户数据/SQL/文件/私密配置/会话密钥，依赖既有项目模块，不是独立安装包。可重复检查为 `python work/governance-command-v4-20261019/check-progress.py`；record-progress.py只发布一次，成功后不得重跑。
