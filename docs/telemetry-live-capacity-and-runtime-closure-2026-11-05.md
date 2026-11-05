# 原采集状态、全历史容量与运行依赖核对

日期：2026-11-05。结论：采集恢复B已使原10000条消息全部取得有效的序号冲突拒绝回执，并曾继续成功写入1161条新消息；当前接收又遇到全历史事务的内存预算边界。原件、签名、隔离记录和原运行版本均保留。本次只读诊断没有实施增量架构、提高预算或切换服务。

## 当前运行观测

以下是2026-11-05T14:51:49.689Z的观测，队列随后仍可能变化。SQLite和PostgreSQL分别只读取证，不是跨组件原子备份点。

| 对象 | 结果 |
| --- | --- |
| 主站与身份 | 主页200、issuer匹配、维护契约通过，9个页面资源与运行源码一致 |
| 就绪 | 503；失败项为`TELEMETRY_QUARANTINE_PENDING` |
| 原10000条消息 | 原待发为0；隔离10000，均为`SEQUENCE_CONFLICT`；原消息摘要/HMAC与负ACK摘要/HMAC均有效 |
| 隔离与PG核对 | 10000条均匹配同原因的REJECTED回执；无缺失、摘要冲突、原因冲突或误记STORED |
| 后续待发 | 2973条PENDING，原件签名有效；对应PG回执均尚不存在，不判作丢失或已提交 |
| 后续成功 | 原接收器计数stored=1161；PG测点总量76279，最高序号76279 |
| 边缘状态 | MQTT已连接且ACK已订阅、OPC已连接、仍在采样；隔离满额阻断，存储预算未阻断 |
| 主站接收器 | `FAILED / MEMORY_BUDGET`；received=11486、rejected=10000、capacityRejected=325；ACK已确认11161、未确认0 |

上述325次容量拒绝是接收尝试计数，不是325个独立丢失事件。边缘采样、主站接收和业务就绪是不同状态；不能再概括为“新采样暂停”或“原消息仍在逐条处理”。清理隔离不会解决主站的全历史事务成本。

已消费的恢复操作`e5b8151b-c803-4b52-85cf-87f397ad83d7`保持原样，没有再次apply/resume、重签消息、补写回执或删除队列。本轮所有原服务进程身份及485项源码绑定均保持。

## 容量证据与推断边界

使用原企业应用角色，在`REPEATABLE READ READ ONLY`事务内实际执行现有读取、工作区克隆、输出规范化和只读写后证明。没有提交业务写入、导出企业载荷或复制数据库。

| 阶段 | 逻辑计量字节 |
| --- | ---: |
| 读取前 | 65,536 |
| 全历史读取后 | 172,987,038 |
| 企业工作区克隆后 | 345,908,540 |
| 输出克隆后 | 518,830,042 |
| 只读写后证明的任务峰值 | 536,868,800 |
| 默认512MiB任务预算 | 536,870,912 |
| 本次峰值余量 | 2,112 |

此次快照包含86332条审计、86279条遥测回执和76279个测点。所有阶段实际通过，任务计量释放后回到基线；这不是一次已执行写事务失败，也没有发现计量租约泄漏。

另对一条有效待发消息做形状估算：假设原最大证明行保持，只追加一条遥测审计，新增对象2038字节、数组槽8字节、证明索引208字节，峰值下界约536871054字节，超过默认预算142字节。对象使用固定长度占位标识，未签名、未追加、未提交。该估算与在线`MEMORY_BUDGET`吻合，但不能当作实际写入测试或精确生产峰值，也不表示“减少142字节”即可持续运行。

这里的预算是现有逻辑分配计量，不是操作系统RSS硬上限。诊断进程未覆盖容量配置；原启动器使用默认预算路径，但本次没有读取原进程的完整环境。真正需要解决的是事务对全部历史反复重建与克隆的增长成本。

## 源码依赖范围

按现有启动器核对六个入口：`server/index.ts`、`services/edge/index.ts`、`services/edge/simulator.ts`、`services/ai-gateway/index.ts`、`services/predictor/index.ts`、`public/app.js`。

使用Node内置TypeScript转换及`vm.SourceTextModule`仅解析，不链接或执行模块。取得199个不同源码文件、1105条静态导入边和1条字面量动态导入；相对导入解析错误0、发现的非字面量动态导入0。主站闭包190文件，边缘7、模拟器2、AI网关5、预测器3、页面脚本1；各闭包相互重叠，不能相加。

该图是“可能可达”的上界，不证明分支实际启用。18个文件的路由线索和62个文件的事务/写入线索用于人工核查，不能将其数量当作接口数或写者数。Java、原生程序、第三方包的内部依赖、HTML全部资源和运行配置不在此图内。

## 当前路由分组与整合约束

下表按实际主站路由优先级及其委托模块核对；是分组基线，不是已完成的新入口接线或逐条接口验收。`{id}`表示受原正则及授权约束的标识，不放宽实际匹配。

| 路由或入口组 | 当前处理位置 | 整合必须保留 |
| --- | --- | --- |
| 非`/api/`页面资源、health、ready、runtime/status | `index.ts`、`http-boundary.ts`、`runtime-status-route.ts` | 静态资源边界、资源计量、受限运行信息和真实依赖状态 |
| auth/session、login、callback、logout | `auth.ts`、`auth-store.ts` | 原OIDC/PKCE、共享加密会话、CSRF、续期及撤销；认证审计也写业务根 |
| field-channel/lease及lease/check | `field-platform.ts` | 机器认证、当前治理与恢复围栏、同事务签发依据 |
| spares/summary、list、detail、options、workorder-usage、material-plans、stock-insight、replacement-insight | `spares-query-db.ts` | 当前设备/工单范围、按需读取及分页，不能换成旧全量备件页面 |
| spares/commands、history及旧spares全量兼容口 | `spares-db.ts`、`spares-history-db.ts` | 当前授权下的原键回执、库存/采购/审计同事务；旧兼容口也需显式处置 |
| field-channel/governance及export | `field-governance-sql.ts` | 当前现场治理与恢复核对 |
| telemetry/source-governance及export | `source-governance-sql.ts` | 原来源绑定、观察历史及权限 |
| quality-policy-evaluation、evaluation-v2及export | 两版`quality-policy-sql` | 已知时点、规则及证据范围 |
| coverage-replay、coverage-replay-v2、operational-metrics | 覆盖复核及运营SQL模块 | 完整输入证明、过滤及当前范围 |
| coverage-reports、coverage-v2-reports、operational-reports及详情/export/submit/approval | `report-api-sql.ts` | 独立报告事件、冻结输入、业务根共享锁、独立审批和原请求恢复 |
| telemetry/coverage、coverage-v2、quality、quality-v2 | 对应覆盖/质量SQL模块 | 当前两代语义、原来源和证明 |
| data-imports列表、详情及rows/records读取 | `batch-read-sql.ts`优先 | 已验证SQL分页、原始输入事实和游标范围 |
| data-management/overview、measurements及两种export | 数据SQL及流式CSV模块优先 | 同一MVCC读面、流式资源限制；不能重新回到全部历史克隆 |
| data-import-templates、upload-report、批次errors/original/correction-review等读取 | `import-api.ts` | 模板、原件、错误定位及更正依据 |
| data-imports上传、records、`{id}/approval` | `import-api.ts` | 文件/JSON输入、原键/摘要、防越权、独立终审、AI outbox同事务 |
| equipment-profiles/points、telemetry/analyze、predictive/analyze | `index.ts`中的事务命令 | 已批准模板及设备、采集源权限和预测输入依据 |
| work-orders的claim/start/submit/approval及workflow/retry；告警ai-review/approval、预测告警approval | `index.ts`、`workflow.ts`及领域函数 | 工单版本、本人任务范围、独立终审、外部命令幂等和未知结果恢复 |
| templates创建/import/edit/submit/approval、plugins创建/certify/activate、demo/reset | `index.ts`、`catalog.ts` | 原角色和发布规则；真实身份/数据库模式继续禁止演示重置 |
| overview、devices、alarms、templates/export、plugins、roles、ai/status、integrations、predictive各视图、workflow/status、work-orders详情/workflow、audit和剩余data-management/telemetry视图 | `read-api.ts`及`consistentRead` | 当前作用域、审计分页、既有读模型；要消除全量事务须逐项替换并验证 |

## 后台写者、权威和锁顺序

| 写入路径 | 当前权威及同步 | 不得遗漏的行为 |
| --- | --- | --- |
| 通用业务命令、上传/审批、认证审计 | `mutate → tenantTransaction → business_state FOR UPDATE → readEntities → savePostgres → confirmCommit` | 完整性、修订CAS、原幂等回执及未知COMMIT判断；HTTP改造不能遗漏认证回调 |
| MQTT遥测接收 | 同一业务根，点/回执/审计在业务事务内；提交后ACK | 原键去重、冲突原因、原信封/ACK签名、提交未知与重连；禁止单独换接收器形成双权威 |
| 工作流与AI投递器 | 独立worker连接领取/续租outbox；业务事务取得根锁后再锁outbox行并核对fence | 领取和心跳本身也是写者；丢响应后仅按原键核对真实外部回执，不能另建任务 |
| 现场启动观察、租约签发及接收 | `FieldPlatformService`与`FieldIntakeService`，含业务mutate和恢复句柄 | 配置启用与否要实查；重连/恢复检查不是普通页面读取 |
| 备件当前命令 | `public.business_state FOR SHARE → 验证 → idms_spares.state FOR UPDATE → 当前引用/授权 → 回执/库存/审计 → COMMIT` | 不可只复制设备投影；须证明设备移出范围、工单变更与领用并发不会用陈旧许可；提交未知返回专用状态 |
| 冻结报告命令 | 业务根FOR SHARE、独立报告事件和原请求摘要 | 与新业务根的同步及未知提交恢复需要专门验证，不能被通用mutate清单掩盖 |
| 登录请求/共享会话状态 | 独立auth_state事务，作用域配额/咨询锁及行锁 | 会话创建、续期、退出删除与业务认证审计不能混作一个原子事务 |
| 边缘及AI服务持久状态 | 边缘SQLite待发/隔离；各企业AI SQLite及模型回执 | 与PG分别持久化；需新的合格配对和真实恢复，不据静态图声称一致切点 |

原`public.business_work_orders`、`public.business_devices`及`current_assets`仍是备件当前引用的重要来源。新业务权威必须提供等价的同事务同步和授权。未证明前，禁止通过定时复制、双写或绕过原锁启用整合。

## 尚未关闭的部分

原`server/index.ts`没有接入独立的预测撤销协调SDK/持久适配器。现有组件测试、工作流hold/release接口或合成domainReceiptDigest不能替代原主站真实登录、独立复核、原发起者重新登录、持久取消回执与释放的业务验收。

[增量入口与备件整合设计](superpowers/specs/2026-11-05--incremental-runtime-and-spares-integration.md)仍等待原方案选择；已批准的工作流安全开源迁移与之分别处理。本次清单供下一阶段复用，不表示该架构已经获准实施。原系统没有在线换版。

后续仍须完成逐接口/逐写者的可执行矩阵、备件并发授权、历史增长成本、未知提交和整个平台一致恢复验证。企业多岗位签收、生产安全及拓扑、云端/备案/TLS、容量与备份政策/告警责任、活跃C盘运行迁移仍按[正式交付验收清单](prelaunch-acceptance-status-2026-11-05.md)保持开放。

## 本机证据索引

私密载荷、进程信息和配置不公开。以下仅为本机定位：

- `work/existing-platform-20261031/local-9476399747c1/verification.json`：网站、身份、资源、就绪；queueBefore/queueAfter是历史启动字段，不作当前队列统计。
- `.local/telemetry-inspections/340ccc6c-3a10-4ee0-a6be-2e9550634f5b/inspection.private.json`：原件/ACK和PG逐条只读匹配、真实接收状态。
- `.local/telemetry-inspections/f6d134fe-ec7d-4711-9ad7-2207de0fe10e/workspace-profile.private.json`及`next-audit-budget-analysis.private.json`：真实只读峰值及独立形状估算。
- `work/existing-platform-20261031/runtime-closure-20261105.private.json`：199文件摘要、逐入口闭包及路由/写入源码线索。首个脚本误写模拟器路径而退出，修正为启动器的`services/edge/simulator.ts`后仅解析成功；没有执行应用模块。
