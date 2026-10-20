# UUID 回执规则 v2

设备报文允许大写、小写或混合大小写 UUID。PostgreSQL 将采样 UUID 规范为小写，而签名报文保留原文。旧版按文本匹配，可能把合法大写原始回执判为不匹配。

新版在“测点数据质量”“历史复核与报告”和“质量策略评估”默认使用 UUID 兼容规则 v2。页面中的“回执规则与报告版本”可切回“旧规则与旧报告 v1”。切换后需重新复核；旧预览、导出凭证、报告正文、审批意见和重试键均清除，迟到响应不能恢复旧结果。旧冻结报告始终留在 v1 列表。

新版仅将原始 receipt.event_id 与采样 UUID 按 UUID 等价比较。envelope.eventId 与原始 receipt.event_id 仍须逐字一致；企业、来源、设备、测点、节点、映射、序号、状态、摘要、数值、质量、单位和时间的既有条件全部保留。大小写别名不能代替原始采样的摘要、序号或截止前回执。历史截止仍为持久记录时间，不是可信授时。

新版覆盖输入/报告为 `idms-coverage-input-v2` / `idms-coverage-report-v2`，规则 `frozen-sample-coverage-2.0.0`，标记 `persisted-uuid-receipt-binding-2.0.0`。新版质量评估包为 `idms-quality-policy-evaluation-v2`，规则 `governed-data-quality-2.0.0`。冻结报告族 `COVERAGE_V2`；生成或提交人不得独立终审本人报告。

API 保留 v1 入口，新增 `/api/v1/telemetry/quality-v2`、`/api/v1/telemetry/coverage-v2`、`/api/v1/coverage-replay-v2`、`/api/v1/quality-policy-evaluation-v2` 及其 `/export`、`/api/v1/coverage-v2-reports` 及报告详情/提交/审批/导出。参数、权限、CSRF、Origin 和幂等要求与对应旧入口一致。健康标记为 `receiptIdentity`。无数据库 DDL 或权限扩张，迁移仍为五版。

原生导出的报告可用 `node scripts/verify-frozen-report.mjs --file <报告.json>` 重算，质量评估用 `node scripts/verify-quality-evaluation.mjs --file <评估.json>`。两条命令均按明确格式验证新旧版本，不猜测或降级规则。普通 SHA 与包内审批事件不能证明外部签名或独立可信时间。回执检查不重验历史 HMAC；来源治理证据仍使用自己的 v1 算法。PASS 仅指声明质量规则未触发，不代表设备健康、放行或现场验收，FIELD 通道仍关闭。

开发验证已完成隔离最小角色 PostgreSQL 的 10,050 个采样，其中 6,700 个大写/混合 UUID 在旧版误判，在 v2 全部正确绑定；最后一个 BAD 样本仍不计为有效 GOOD 槽。17类原始报文标识与绑定条件变更继续不匹配，接收截止含边界且拒绝晚到原始回执。三类报告已完成独立审批、错类型访问拒绝、范围检查、离线重算和33表加密隔离恢复。浏览器使用真实 OIDC、Chrome 和签名 MQTT，验证新版默认/旧版切换、原生无 Blob 导出、取消、预算、故障恢复与手机布局。

本机4010已受控启用新版健康标记。原企业6份文件共14,513字节、8条输入及5条批准事实、旧会话与审计游标均经升级前后验证；未写入客户测试策略、报告或采样。386项单元测试、151项运行构件语法/类型检查及13组相关回归通过。
