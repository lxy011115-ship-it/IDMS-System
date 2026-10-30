# 当前现场宿主的身份与恢复检查

`loadFieldMapAuthorityHostV1` 将已有的真实身份权威和物理冷恢复准入检查接到当前状态映射事务。它直接构造 `IdentityAuthorityGuardV1` 和 `RuntimeColdGuardV1`，不接受外部替代授权函数。返回的 `tenantBindings()` 可供当前 `FieldMapPlatformV1` 使用；本阶段的原生测试先验证实际 `FieldMapTransactionsV2`，统一接收服务及控制器接线仍待完成。

配置格式为 `FIELD_MAP_AUTHORITY_HOST_V1`，要求身份 runtime 文件、cold trust 文件、已有登记控制账户及明确企业账户/状态映射绑定。控制账户只在可信宿主管理代码中进行只读检查；不会生成新 SQL 权限，也不进入边缘材料。配置拒绝未知字段、错误端点、错误企业、重复数据库/角色槽位和非规范 OID。配置与恢复后口令文件固定摘要，变化时拒绝服务，不能自动采用。

每个 READ、WRITE、PRECOMMIT、POSTCOMMIT 调用核对：

- 实际当前身份头与冷恢复 ADMITTED 状态、维护封闭回执及同一次准入指纹。
- 恢复后的 credentialHash/controlId、企业角色与活动数据库清单。
- 实际 PostgreSQL 系统标识、当前恢复目标目录、数据库/控制角色 OID、非备库状态。
- OPEN 且 finalized 的 SQL 围栏、部署/catalog/DDL epoch、当前身份与恢复操作标识。
- 企业账户实际连接的 session 角色 OID、apply_delta_v1 的真实 EXECUTE 权限和 state_map 目录摘要。

SQL 检查前后均核当前身份与取消状态。关闭拒绝新调用，等待已有检查和实际连接退出，再清理宿主配置中的秘密。公开状态只提供资源计数。

原生验证使用新建的独立业务/身份 PostgreSQL、真实 Keycloak 和公开批准模板。先完成维护封闭、物理冷备恢复、口令轮换、旧 JWT/租约过期及真正 ADMITTED，再验证宿主。它还在实际 SQL 增量之后改变真实身份服务标记，要求 COMMIT 前拒绝并回滚；核对维护回执、冷控制阶段、口令文件、SQL 围栏漂移和持有 SQL 响应时关闭排空。

```powershell
node --test --test-concurrency=1 tests/field-map-authority-host-v1.test.mjs tests/field-source-static-graph-v1.test.mjs
node scripts/verify-field-map-authority-host-v1.mjs <PG16-bin> <JDK21> <Maven3.9.11> <Keycloak26.8.1> <公开源文件> <源SHA256> [本地Maven仓库]
node scripts/verify-field-map-authority-host-cleanup-v2.mjs <本次nonce>
```

源码收集区分“已固定的历史文件”与“本次执行模块的静态导入图”。所有基线字节都核对；仅从实际入口遍历导入。Node 自带解析器只编译、不链接或执行产品模块，避免把夹具中的生成代码字符串误当实际导入。动态入口和构建输入须明确列入固定清单。

这不是完整平台启用证明。严格 enabled 配置、现场槽位/descriptor、统一 SITE 机器 HTTP 与接收器、broker/edge 的实际句柄及逆序排空、同请求停机重试、历史点页面/预测消费和旧 SQL 现场历史迁移仍待完成。本测试的事务标记是明确 QA 记录，不是现场事件；先前真实现场数据链也不能替代本次实际身份组合的最终接收验收。容量、生产 OT、HA/灾备、安全和商业验收及最终图文视频交付保持原范围。未备案仍只准备云端部署。

现场写入账户应使用同次恢复清单中已有的写入角色及轮换后口令。站点HTTP读取账户用途不同，宿主会在启动时拒绝缺少提交权限的账户；不通过给只读角色扩权来接通写入。

独立校验采用V2，将Windows的PG目录斜线形式规范化后实际核对源业务、恢复目标与独立身份三处目录；V1字节保留用于原生固定源记录。修正只影响离线校验路径比较，不重启数据库、不修改原生结果。
