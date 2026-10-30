# 逐批输入与逐行事实的完整冷证明

目标：移除独立SQL冷读和启动在企业级完整输入/validRows/事实对象图上的依赖，保留原canonical摘要、治理锚、全部文件/审计/回执及原事实/typed/更正证明。整体验收目标仍完整方案A，不新增DDL或重算历史基线。

同一个RR：读取真实业务集合与最小批次header；全审计canonical及链校验，仅留接收锚摘要/次数/标记和类型治理锚；命令回执流；按批次读取真实元数据和全部输入，恢复完整真实BatchBody/独立validRows，按原属性顺序和48KiB文件重放canonical，核对实际接收事件摘要/映射/类型/更正治理并积累紧凑更正期待；释放该批；全root事实流同时生成原根records和projection digest；全部导入回执；最终全根匹配、typed SQL及更正链全量核对成功后只返回小tenants/历史绑定。

更正仅留必要来源键、版本/前批次行/前值和后值摘要、device_code及类型/来源/批次快照；SQL按root/revision流式重建一个当前版本，逐一核对原before/previousStoredRow/本批真实输入与不可变ledger，不保留全部root事实索引。漏/重/foreign/孤儿/顺序/无效治理/旧隐藏事件/回执/文件/投影均失败。全部数据仍完整传输并计算；一个批次及更正索引/业务数据仍有上限和增长成本，不宣称RSS/SLA。

独立SQL验证与启动使用新明确ColdBindings，禁止假BatchBody/空records或空文件TenantPayload。旧需要完整ImportView的GET显式启用完整ReadCollector：收集用于同一canonical证明的真实批次/事实和业务对象，仅在所有证明完成后冻结返回；不在根证明后再次查询未绑定的轻对象；完整写/维护入口保持。coalesced成功证明/精确MVCC/取消与失败不缓存保持。

验证：独立旧完整canonical和old readColdSnapshot对照；七类型/映射/类型继承/有效选择/物理行/多轮更正；全部来源故障/重新计算根但无效治理/更正链；真实PG/OIDC20k和大多批、更正、大文件/审计回执、冷/暖/启动逻辑峰值、预算/取消/RR物理篡改、完整写/会话/CSV/页与20回归；原站点受控升级/前后恢复/原文件和全部历史，独立源码SHA及记忆。
