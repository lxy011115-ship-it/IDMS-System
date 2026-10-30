# 可重试现场数据恢复协调器

延续隔离恢复既定方案，整合到同一RESTORE操作的 `restore-target`。完整v3认证与原意图绑定前无目标DDL；源库无需在线。完成后仍RESTORING、app/mig/owner NOLOGIN、backup只读，不替代维护实例、外部现态及独立终审。

## 工作与原生执行

私密operations中先持久run记录，再落精确命名dump/SQL/prefix/marker；先持久工具记录，再启动固定PG16 pg_restore/psql。输入完整SHA、参数、程序SHA、宿主/PID/创建时间、目标角色与DB均绑定。复用已有Windows精确argv检查器，扩展固定程序集合；旧进程、检查助手、对应PG后端实际终态前不复用或清理工作文件。未知文件/会话不删不杀。认证器未知遗留私密目录不擅自清理。

每段不可变plan保存runId、前后库内标记、dump/SQL/prefix/marker摘要和两个程序摘要。next.content绑定完整工作摘要，避免只绑定COPY正文。SQL与最后COMMENT由psql单事务执行；角色为明确新迁移身份SET ROLE新owner。已提交段按库内阶段与计划识别，不能再次COPY；未提交段仅在旧执行者实际结束、输入完全一致时重试。序列非事务，失败段允许重设同一认证源值，结束必须全量核对。

## 状态与封闭

准备态四角色NOLOGIN且无成员；写入态只允许mig LOGIN并SET owner、backup/app/owner关闭；封闭态app/mig/owner关闭、backup LOGIN只读、无成员。角色能力注释和OID不变，模式转换在SQL事务中。库内阶段EMPTY/pre-data/data/post-data/VERIFIED严格匹配当前op/backup/意图/DBOID。未知混合状态拒绝。

post-data后仅对精确的无ACL还原基线套用编译权限；已经封闭则只核验，不能修复权限漂移。封闭事务内通过不提交的部署元数据投影复用基础/现场校验，再真实COMMIT。完整事实必须与源一致后才允许实际角色重绑定。

## 目标核验审计

先持久verification-intent（原始事实、预计重绑定事实、三段计划链和source/provision/上下文摘要），然后在单事务真正重绑定两迁移表部署角色、追加唯一FIELD_TARGET_RESTORE_VERIFIED保护审计、保存完整根、扫描最终事实，最后写VERIFIED库内标记同COMMIT。标记content绑定最终事实SHA，含真实audit ID。

重试若VERIFIED，不能再改元数据或追加审计。重验完整目标、审计末条与意图、所有旧审计行SHA、旧根payload摘要、原件/业务/投影、除两迁移表及audit/root/派生视图外的逐表事实；两迁移表只把部署角色投影回源再比原SHA，时间/校验和/触发器O/A保留。最终序列值与新审计序列一致且不小于源。根revision仅新增一次。外部结果未知时按真实COMMIT重建同一结果。

根记录的原始 `to_jsonb(t)::text` 在核验意图中保存；先与认证清单中的原表字节数/SHA及规范化根逐项核对，提交后用原始文本重建旧根及runtime_state。旧facts-v1的Date毫秒语义不变，不能用它代替数据库微秒精度的旧行证据。

恢复核验事务追加审计前，对唯一编译审计序列使用事务性 `ALTER SEQUENCE ... RESTART WITH 源值+1`，仅支持increment/cache=1、非cycle且源is_called=true。真实PG16双会话实验确认：未提交时只读备份会话仍见旧存储，事务拥有者见新存储；回滚后两者均为源值。最终待提交事实先要求独立只读会话的序列完全等于认证源，再在当前拥有事务中实际读取新序列值并与新审计sequence_no核对，用这份实际新值计算VERIFIED摘要；真实COMMIT后再由独立只读会话完整重扫，摘要一致才记结果。此处理只用于恢复核验的最后一次审计，不改变源事实入口的强制权限/只读备份检查，不接受未知序列漂移。依据：[PG16 ALTER SEQUENCE](https://www.postgresql.org/docs/16/sql-altersequence.html)；文档不替代实际中断验证。

## 验证

真实CLI、源不可连接/非UTC/ALWAYS触发器/2点2回执，完整恢复后重试无重写；阶段COMMIT前后/丢回复、工具/计划/结果前后、旧原生与PG终态、未知目标/权限/输入/日志拒绝。原66、十轮双份快照和原4010/角色/数据保持。最终现场与完整商业目标继续。
