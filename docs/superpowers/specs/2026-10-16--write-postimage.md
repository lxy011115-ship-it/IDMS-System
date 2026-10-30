# 写入后逐行一致性核对

## 背景和证据

完整方案A保持进行中。本批继续默认大数据完整写预算待办，不改变原目标。前批100设备/20k测点/22,170,784字节原件/12,500附加审计的真实登录写入在默认512MiB预算下拒绝。本批在独立QA库以相同数据和默认配置重现503/MEMORY_BUDGET，完整payload未改变。资源计费记录表明：首次实体加载约142MiB，工作区复制和wire规范化各约121.7MiB；到写后重建前约385.4MiB，第二次完整实体重建累计到512MiB被拒绝。采样heap约192MB，仅作为观察，不把逻辑权重当RSS。

## 方案选择

采用单语句逐行写后核对，替换savePostgres中完整rebuild对象。提高默认上限会保留重复图和容量问题；组件清单/增量证明涉及独立架构和迁移，仍是后续完整目标的一部分。此次通用于全部PG写命令，认证审计不建立跳过业务完整性的特殊入口。

同一事务中仍锁定business_state，完整读取和验证原payload，隔离可变Workspace，执行领域规则/独立审批/幂等，wire规范化并validateTenantPayload，应用原writeEntities和typed/revision投影。随后以与原entityRowsSql相同的UNION正文、单个SQL语句核对全部normalized来源；标记不同但字段/分支不减少。核对成功才以原canonicalDigest更新revision/payload_digest并提交。任一缺行、重复、乱绑定、内容/顺序或SQL错误均回滚，失败不得创建登录SID。

## 核对器

预期payload已由完整领域/来源校验覆盖，核对器只建立引用索引、紧凑位图和audit sequence的int64数组。逐行检查企业和kind，再按ordinal或ID定位预期对象：业务实体、批次元数据、原件SHA/Base64、输入行和validOrdinal、批准事实、导入/命令回执、审计列/完整事件、冗余工单body及state行。所有计数必须完整；未知/孤立/重复行拒绝。SQL顺序不作假设，audit实际序号必须与预期历史严格同序，允许合法回滚产生的序号间隙。validRows按列序号逐项核对并保证覆盖/唯一，不复制输入正文或生成完整input映射。

原件仍由原SQL独立文本列传输，每次最多一条最大文件行，逐字节比较其规范Base64和SHA绑定，预期文件此前已校验SHA。不是文件分块流式；最大单行仍可能超额度。完整审计链此前经validateTenantPayload校验，所有持久事件与预期链逐项相等且实际SQL序号同序，因而保持整链，而非只检查新事件。

状态头要求唯一、schema3、同企业/原revision/原payload摘要，防止在命令期间意外修改state头被覆盖。原payload摘要取原canonicalDigest，最终摘要仍用同一历史函数。不改schema、历史checksum、canonical实现、完整entityRowsSql或兼容视图。

## 生命周期和资源

读取时保留一条瞬时行租用，下一行到来时归还，驱动额外rows数组<=1。索引预算在分配前预留，成功或错误后清理引用和归还。索引随行数增长，正文保留按最大行而非整个数据库增加；不宣称总内存常数。已有before/工作区/wire副本与投影全读仍保留，冷/写全量验证、同步CPU和更大规模预算继续待办。默认容量配置保持不变。

## 验证与升级

单位按独立手工SQL行模型验证全类型、任意SQL次序、合法审计间隙、输入重复值及validRows排序，缺失/重复/foreign/unknown/所有绑定/旧事件/原件/镜像/state头错误及租用失败/driver排空。黄金函数/SQL/迁移文件字节保持。

真实PG默认预算的大夹具重新走真实Keycloak PKCE登录/退出、共享会话/双核心重启、普通导入/独立批准/同键/写后所有表核对。写后传输故障针对旧原件/旧隐藏审计/事实/输入绑定等，修改已发SQL后的返回行，必须503且DB/审计/outbox/回执整体回滚；恢复后相同幂等键可成功。quota拒绝和取消仍排空。既有全部领域、分页、状态/读取、工作区、容量、共享会话/采集/真实Flowable和AI租约接管回归。

原平台先业务29表加密备份/隔离恢复、预存SID/CSRF、即时父链/监听验证、仅停owned core并等launcher清理，专用私密v4基线拒绝覆盖，停机全payload/逐表/历史迁移核对、新核心和原SID/CSRF/原JSON/原6文件/分页/角色/旧归档与后恢复。独立PG/Keycloak保持。交付当前chat outputs的指南/证据/SHA/项目记忆，完整目标ACTIVE，生产门禁仍关闭。
