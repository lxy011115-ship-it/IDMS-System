# 隔离恢复清理 R5

R5 为独立模块，用于后续已授权的受控恢复协调器。当前活动 owner 仍使用冻结 R4；本次没有替换其输入、重启原核心或执行原业务库捕获。

`scripts/core-upgrade-archives-observed-r5.mjs` 导出 `captureCoreUpgradeArchives`，参数和 R4 相同：phase、directory、keyFile、config、gate。原备份、隔离恢复、维护门与原生连接观察语义保持。新 `withRestoreClientR5` 无论业务或清理失败都尝试一次关闭；单个失败保留原值，多个失败按发生顺序放入 AggregateError.errors。只有目标安全清理和管理连接关闭均成功，才删除本次恢复凭据。已有凭据文件拒绝覆盖；无法确认创建结果的目标仍存在时保留凭据。

`scripts/reconcile-private-restore-targets-r5.mjs` 导出同名 `reconcilePrivateRestoreTargets`，参数沿用 R4。先核 key SHA、档案认证、隔离目标身份与原业务排除，再完整核对事实及业务。内外层连接均纳入生命周期包装。只有实际删除目标库/角色并确认不存在，且关闭连接成功，才删除凭据。未知连接、事实不符或关闭失败不能被当作清理完成。

R5 沿用 R4 对 pg_stat_activity 的精确观察：自己的角色/OID，以及形状精确的原生 autovacuum worker，均等到实际空集；未知主体立即拒绝。不调用 FORCE 或终止 backend。仍存在“观察到零连接”到数据库 DDL 之间的竞态，本修订没有证明完整 DDL 并发隔离。

验证入口 `node scripts/verify-restore-cleanup-r5.mjs` 会创建全新随机 QA 源库及专属 work 目录，使用合成业务、真实维护门和 pg_dump/pg_restore；不会在原库执行恢复。加密档案及独立 key 为私密证据保留。只读库存入口为 `node scripts/verify-restore-cleanup-r5-inventory.mjs`，适用于该 QA family 已终态后核对精确名称/OID及恢复目标命名空间零遗留。

这不修改旧 backup-support 的其他失败路径，也不是跨服务灾备、原站切换、HA/PITR 或商业验收。当前旧 owner 的运行版本不会因新增文件自动改变。
