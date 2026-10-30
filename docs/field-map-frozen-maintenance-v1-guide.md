# 当前根恢复维护存储适配

有效模块为 `scripts/field-map-frozen-maintenance-v3.mjs`，复用 `field-map-frozen-profile-v2.mjs`。它在调用方已持有的 bootstrap 事务中读取当前根、准备真实 map 增量，再将全部业务角色、数据库连接上限和 SQL 写围栏恢复封闭。返回 prepared witness 之后仍需调用方 COMMIT；返回不表示正式恢复计划已获独立批准。

```js
await bootstrap.query('BEGIN');
const snapshot = await openFieldMapFrozenMaintenanceV3(bootstrap, pinnedProfile);
// The recovery coordinator authenticates the archive, original intent,
// complete business facts, current author and independent reviewer.
const operations = await compileAuthorizedRecoveryDelta(snapshot);
const prepared = await snapshot.prepare(originalPersistedCommand(operations));
// Persist the exact root, receipt and CLOSED generations in the recovery chain.
// The coordinator owns final commit and unknown-commit resolution.
await bootstrap.query('COMMIT');
```

示例中的授权、意图持久化和恢复链属于上层协调器，尚未由本模块实现；不能复制示例作为现场启用脚本。本模块不提供 ordinary HTTP、COMMIT、ACTIVE 发布或全平台开放入口。完整归档与已退休源、当前 OIDC/Flowable、全部贡献者独立批准、旧数据/历史公钥迁移、原生 ACTIVE 发布和异常提交恢复仍须接入。

输入清单保留原 system/database/role OID、目录、成员关系、原角色配置、映射目录及 SQL 结构摘要。实际全簇必须处于准确的 NOLOGIN/connlimit0。临时属性只在维护事务内部可见；成员证明读取有 256 键、16 MiB 预算。错误会回滚本层保存点；若无法证明回滚成功，则抛出专用错误并要求外层整笔回滚、关闭原连接。独立批准者和材料的最终复查不能省略。

Windows 已用全新自有 PostgreSQL 集群和完整加密冷镜像验证恢复到不同目录，固定源码、原 process handle、实际 smart stop 与物理离线均另有记录。验证含错目录/固定 catalog/CLOSED 代数拒绝、真实成员读取、准备后回滚、带原审计的封闭提交、原 SQL 回执幂等、实际 SQL 失败后的保存点恢复、外来连接阻止和读取预算耗尽。Linux 结论须以本分支实际 Actions 结果为准。

V1 在 Windows 路径正反斜杠比较处失败，其源码和报告保留。V2 先按真实规范目录验证再统一清单中的目录表示，继续完成六项检查；错误注入又发现清理语句可能把原 SQL 错误替换为 25P02。V3 仅在成功后重置会话身份，失败由保存点回滚恢复身份，实际保留原 P0001/STATE_MAP_IMMUTABLE_KEY。原失败没有改写为成功。

本次独立清理工具重认证完整冷镜像，重算 SQL 回执摘要、核对 prepared/最终根并检查真实目录离线；它没有离线重算完整成员证明数据集，根成员断言来自固定源码的原生执行。所有 formal/full flags 均保持 false。本页是技术接入指南，最终用户中文图文说明及实操视频尚未交付。
