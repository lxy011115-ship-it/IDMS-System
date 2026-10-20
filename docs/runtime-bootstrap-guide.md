# 运行启动绑定与按需业务工作区

后续[批内双流证明](cold-inputs-guide.md)已移除bindings-only中的整批rows/validRows驻留，保留原完整canonical及全部来源；本页数字和实现说明属于对应历史阶段。

后续[逐批冷证明](cold-imports-guide.md)已将启动/独立SQL的输入和事实改为逐批/逐行；旧完整只读消费者明确收集同一证明的真实对象，原canonical/全部来源和完整写模型保持。以下样本属于对应历史阶段。

后续[批次分页](batch-pages-guide.md)已将PG批次列表/详情及冻结输入/批准历史页转为独立完整证明后的直接SQL；其他旧GET轻工作区及冷输入事实图继续保留。以下改造样本和限制属于对应历史阶段。

后续[冷读取分段证明](cold-proof-guide.md)已用于启动验证，原完整性/绑定折叠保持，暂留轻输入事实而不重建完整原件/审计/回执。以下样本为原绑定改造批次历史。

后续已部署[只读正文按需加载](read-bodies-guide.md)：普通GET缓存不含原文件、完整审计或回执；启动/冷验证及写事务的完整内容边界仍保留。本文性能/对象图样本为对应批次历史。

更新：2026-10-16。本批继续完整方案 A 的全局常驻内存与按需读取待办，无新 DDL；业务迁移 4、实体 3、payload 2、认证 schema 1 保持。

## 运行入口的变化

此前每个核心启动时，会永久保留全部企业的业务实体、导入批次、输入/事实、原文件、审计和命令回执。当前 HTTP/后台业务已经依赖锁后当前企业工作区，这份全局聚合只用于启动绑定和历史配置检查。

运行入口现在调用 `loadRuntimeImports`：依次读取每个企业，在原事务和 SHARE 锁内完整核对角色/历史迁移、canonical payload 摘要、原文件 SHA、审计链、冻结映射/类型/更正绑定及 typed 数据投影。每个企业使用独立任务账本，完成后仅将企业身份/状态/modules、是否存在 Flowable 历史、历史 AI modelDigest 去重集合折叠到启动绑定；没有业务对象或文件的隐式引用逃逸。业务根集合、导入、审计和幂等记录为空，根对象与绑定字段冻结。

Flowable 与 AI 的 `start` 显式接收只读历史摘要，所以清空根业务不会使历史服务配置要求消失。有 Flowable 历史而缺少配置会失败；有 AI 历史而缺少网关配置或 modelDigest 不同会失败。启动根不能通过 `platformSnapshot` 假装成完整业务快照，也不能在遗漏显式摘要时重新推导为空历史；PG execute 拒绝用启动根执行业务。

维护/迁移和显式兼容读取仍使用完整 `loadImports`/`loadPostgres`；独立文件 Demo 保持原持久化规则。运行时使用同一规范化表，历史摘要、只读 runtime_state 和 v2 归档保持。健康标记为 `runtimeBootstrap=verified-bindings-only-v1`。

## 实际验证

隔离双企业 QA 库包含 100 台设备、20,000 条测点、22,170,784 字节原文件及 2,500 条附加审计。实际导入运行入口后，通过真实 HTTP 比对批次、报告、typed SQL 数据中心、全部原文件 SHA 及完整审计；根对象在查询后依旧不保留业务集合。原文件、审计、迁移 checksum、typed 投影的故障分别使启动失败，恢复后完整 payload 与迁移行精确保持。

| 启动后保留项目 | 完整聚合路径 | 绑定路径 |
| --- | ---: | ---: |
| 原文件 Base64 字符数 | 29,561,052 | 0 |
| 事实行 | 20,200 | 0 |
| 审计事件 | 2,524 | 0 |
| 根对象图估算权重 | 108,638,116 B | 3,094 B |
| 单次 GC 后观察堆 | 55,445,760 B | 18,174,056 B |
| 进程生命周期 maxRSS | 291,724 KiB | 295,408 KiB |

两种模式各一个全新 Node 进程。基线仅运行完整 loadImports；当前运行真实 index 与 HTTP，外部服务配置关闭。根对象图权重可用于判断本次保留范围，GC 堆为单次观察，加载耗时/RSS不是隔离组件性能对比。maxRSS仍接近，因为启动仍完整读取和验证目标企业；本批不声称峰值内存、启动时延或生产 SLA 已解决。该大数据专项使用仅属于 QA 的 Demo 身份头；真实 OIDC/Flowable/AI 配置历史、接管及业务路径另由现有真实服务回归验证。

运行 `npm run bootstrap:verify`；证据为 `outputs/runtime-bootstrap-verification.json`。135 项单元与 70 项运行文件及全部脚本/TypeScript 构建通过，原有容量、领域/更正/类型/质量/数据导出、读取、真实 Flowable/AI、采集与共享会话继续回归。

## 仍需继续的工作

当前减少了运行根的永久聚合；冷启动仍逐企业全量校验，活动工作区及普通 GET 缓存仍可能保留完整目标企业文件、事实和审计。文件/审计分段与组件完整性、真正流式导出、同步 CPU 隔离、typed 投影和编码资源、长时及更大多节点负载仍未完成。逻辑权重不等于物理堆/RSS硬限。数据库/上游 HA、安全与跨服务恢复、现场 OT、模型评测、SaaS/私有化、插件制品及许可计费/UAT等完整商用范围保持，生产门禁关闭。

## 原平台受控升级

原4010已部署本批。升级前建立的同一SID、CSRF与设备/测点JSON保持，原业务/导入摘要与审计链保持，acme仍6批0工单。专用私密runtime-bootstrap基线拒绝覆盖；停机全payload、逐表及4条历史迁移核对通过，升级后历史行/审计前缀、角色/原v2归档和只读页面通过。前后29表业务加密备份均已隔离恢复；认证库和keys仍不包含在业务备份内。

证据为`live-runtime-bootstrap-upgrade-verification.json`、`runtime-bootstrap-upgrade-offline-verification.json`、`runtime-bootstrap-upgrade-live-verification.json`及前后备份报告。完整交付快照与SHA256见`outputs/runtime-bootstrap-release-verification.json`，开发平台持续运行，完整商用验收继续。
