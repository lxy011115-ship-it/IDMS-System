# 当前根的持久恢复审核上下文

本阶段为已真实冻结、归档并恢复的当前状态根提供 root 运维入口 `CLAIM` 和 `STATUS`。它把原 cold 控制持久转换为 `FIELD_REVIEW_V1`；旧准入和普通运行入口继续拒绝该状态。此转换不是独立人工批准，也不产生现场租约、注册观察或 ACTIVE 发布。

固定私密配置的 purpose 为 `FIELD_MAP_COLD_REVIEW_V1`，包含原 cold trust、真实 bootstrap 账户、独立身份权威、所有租户的捕获绑定、PG 程序、原归档钥匙及私密证据目录。配置应由受控恢复流程生成，不能由普通网页用户、自报 actor 或 PID 列表组成。

```text
node scripts/field-map-cold-review-entry-v1.mjs CLAIM <private-config> <original-recovery-uuid>
node scripts/field-map-cold-review-entry-v1.mjs STATUS <private-config> <original-recovery-uuid>
```

claim/status 在原 SQLite writer mutex 下认证 source body 与归档、实际源离线、目标和固定清单，读取当前独立 Keycloak 权威，使用本次实际创建的原恢复锁，并核所有 state-map 租户的覆盖。每个目标通过维护 V4 暂存原属性作完整只读扫描；结束后整笔 SQL ROLLBACK，连接及原锁均真实关闭。SQL 根、审计、CLOSED 代数和全部业务角色保持原样。只有初次 claim 的控制阶段和新恢复身份在 SQLite 中原子持久化。

全事实包含完整当前树的逐节点/值重算、所有 SQL 回执链、当前数据库全部用户关系的有界原始行摘要，以及从同一根证明重建的完整业务、原输入、幂等和审计。私密 JSONL 证据由离线工具用临时私有磁盘索引重新构造整棵根与全部领域负载。关系摘要由该工具认证，但没有离线重算全部 SQL 原始行；跨数据库和原归档的真实性仍由原冷捕获与实际恢复绑定提供。

相同操作及新 CLI 进程重开时，仍重新检查当前外态、原证据、归档、源离线和全部目标基线。缺失租户、未知 SQL 会话、伪造 PID 能力、不同操作、材料/证据漂移或当前权威漂移均拒绝。清理失败保留原资源并禁止新动作，不以观察超时或 PID 发现来接管连接。

后续仍须接入真实作者/全部贡献者/独立批准者 JWT 与当前完整 Flowable、恢复计划与维护提交意图链、注册材料和历史数据/公钥迁移、原生 ACTIVE 发布、凭据轮换和最终提交恢复。普通 Flowable 启动包含写入和部署，不能为读取恢复审核事实提前开放业务。此页是技术接入说明，完整用户图文文档和实操视频尚未交付。
