# 主站就绪检查与受限运行详情

更新：2026-10-31。用户批准的方案A已实现源码及隔离验证。该能力帮助部署探测和维护人员判断配置依赖是否就绪，不解除生产门禁，不代表企业岗位签收。当前本地完整平台未执行新版本运行切换，不能把下面的接口说明当作4010已上线证明。

## 启用方式

新接口随主站代码提供，后台依赖探测默认关闭。没有`IDMS_READINESS_CONFIG`、配置禁用、配置错误或文件演示模式时，`/api/v1/ready`保持503；原`/api/v1/health`仍提供存活信息，不受启用状态影响。

首次配置可将`infra/runtime-readiness.example.json`复制为私密的`.local/runtime-readiness.json`；已有同名文件时先人工核对，不覆盖。配置只包含周期、预算和必需/可选组件，不放令牌或业务凭据。在项目根目录为下一次受控主站启动设置：

```powershell
$env:IDMS_READINESS_CONFIG = (Resolve-Path -LiteralPath .local/runtime-readiness.json).Path
```

变量需要传入真正启动`server/index.ts`的环境。现有启动器会继承此变量，但本批没有执行整个平台启动器：它仍含依赖setup/迁移步骤，完整平台切换应按[启动说明](local-startup-and-package-guide.md)核对既有数据和依赖，再分别记录实际运行证据。改磁盘文件不会使旧进程自动升级，也不会让旧进程自动启用新探测。

示例策略：每10秒最多启动一轮，总观察预算8秒、单项3秒；最多2探测同时运行，缓存最长30秒。上轮原任务未收尾时不会重叠启动下一轮。时间预算是观察预算，取消、回滚和连接释放可能使实际结束更晚。

七个组件必须在`required`和`optional`中各出现一次，无重复、无未知项。business、sessions、identity必须为必需项；公开完整示例将workflow、predictor、ai、telemetry也列为必需。缺配置不会静默变成已通过。

## 两个接口

| 接口 | 访问与状态 | 可证明的范围 |
| --- | --- | --- |
| `GET /api/v1/ready` | 无需业务登录；新鲜完整必需项PASS时200，否则503 | 配置依赖的最小运行证据，不表示生产批准 |
| `GET /api/v1/runtime/status` | 实际回环连接＋既有维护Bearer令牌；成功取快照200，未授权401，未配置令牌503 | 固定脱敏组件状态和当前主站资源计量 |

两条路径也支持HEAD，状态及响应头相同、无正文；查询参数、请求体和其他方法被拒绝。采用no-store及既有安全响应头，无新增跨域许可。请求只读内存快照，不触发新数据库或HTTP探测；最多16个状态响应槽，正文最多16KiB并纳入既有资源计量。

公开就绪正文仅有协议格式、READY/NOT_READY、检查时间、证据年龄及`productionApproved:false`。首次检查未完成、未配置、必需项失败/未知、旧成功过期及关闭排空都不能返回READY。新一轮确认必需失败后立即撤下上一轮成功，只有完整新一轮通过才恢复。缓存年龄从该轮开始计，用单调时钟判断；系统墙钟变化不会给旧成功续命。

详情认证只使用进程已有`IDMS_SERVICE_TOKEN`；不生成新令牌，不新增账号或授予企业权限。拒绝重复Authorization、Origin、Cookie及实际非回环连接；转发头不能改变实际来源判定。详情不含租户/数据库/账号名称、内部地址、文件路径、SQL、会话、业务正文或原始错误。不要把维护令牌放URL或截图。

目前只适配明确回环HTTP依赖。远端HTTPS依赖显示UNKNOWN，不能据此宣布远端正常；实际反向代理/网络隔离和远端证书允许清单另行验收。

## 证据如何读取

主站探测使用实际已初始化的企业池、共享会话对象/密钥见证、authConfig、工作流/AI客户端及采集连接，不另读一份业务配置来代替当前进程。

- 企业数据库：实际池的只读事务、库/角色及唯一企业最小绑定。没有全量业务或审计证明。
- 会话库：最小结构/部署摘要和已加载密钥的加密见证；不建立会话或尝试真实账号登录。
- 身份：OIDC发现issuer准确匹配；不尝试账号密码。
- 工作流：已有GET状态中的Flowable版本与流程定义；不派发新任务。
- AI：SHADOW、当前模型名称/摘要及网关实际检查的modelReady；不调用生成。
- 预测：工程规则健康契约；不承诺现场准确率或RUL。
- 采集：主站自己的MQTT连接与订阅、边缘状态及缓存均核对。边缘连接不能替代主站订阅；缓存满/阻塞失败，没有有效样本或未分类采集错误未知。此证据仅限模拟只读链路，现场和时效SLA未签收。

探测借用现有池，不另建一套健康池绕过饱和，也不结束共享池。BEGIN期间发现服务端遗留事务提示时拒绝该连接，并另查实际transaction_read_only模式；观察过期后不继续启动下一条探测SQL。到期时只取消本轮准确借出的backend；等待原借出/查询、回滚及连接收尾，再开始新轮。未启动和迟到成功不能变绿。主站开始关闭时先同步NOT_READY，再取消并等待本轮，最后才关闭原有共享依赖。

备份解密、全量审计、磁盘保留策略或恢复不会进入周期。继续用[手动巡检](runtime-inspection-guide.md)和专用恢复工具分别核对。

## 主站资源计量与CLI

详情中的resources来自被访问的主站自身：HTTP/工作/SQL当前数量与上限、聚合连接池total/idle/waiting、MemoryLedger和RSS/heap/external等进程内存。MemoryLedger是应用计量，RSS是进程观测，两者分别命名，不当作操作系统、容器、CPU或生产容量证明。`operatingSystemCapacityVerified`固定为false。

资源状态为AVAILABLE、SATURATED或CLOSING。瞬时准入饱和进入详情，不直接让负载均衡因一次峰值抖动。真正数据库探测未能借出/执行仍返回未知，不能绕过原池。

手动巡检公开示例现在包含：

```json
"resources": {"tokenFile": ".local/service-token"}
```

它引用既有文件，只有resources检查会读取此引用并向已绑定core origin发送维护GET；没有配置此字段的旧档案仍可使用，资源项明确未配置，不自动猜令牌位置。端点响应需通过固定契约、计数及状态一致性验证，任意额外字段不会进入报告。旧主站没有新接口、维护令牌不符或响应无效均明确报错，不用巡检进程内存填补。

```sh
npm run platform:inspect
```

资源项PASS只表示取得本次主站计量，仍明示操作系统生产预算未验收；SATURATED为UNKNOWN并提示核对负载，CLOSING为FAIL。磁盘阈值、备份扫描及备份时效未知不会因此被掩盖。

## 本地验证与部署边界

本批31项定向检查通过，涵盖缓存/失败/关闭、实际HTTP方法和维护认证、MQTT/模型契约、跨进程CLI资源、旧配置、打包与完整主站隔离进程；650项服务端回归通过。小型独立PostgreSQL 16.10实例的5项真实SQL检查通过：只读有效模式及遗留事务拒绝、写入拒绝、企业/会话及密钥见证、池饱和迟到借出、准确取消和后台收尾、共享池20轮复用无监听器增长。实例和临时数据/凭据已普通关闭清理；没有停止或写入真实企业依赖。

SQL证据：`work/runtime-readiness-20261031/3412b17278ec/verification.json`。测试命令：

```sh
node --test tests/runtime-readiness.test.mjs tests/runtime-adapters.test.mjs tests/runtime-inspection.test.mjs tests/health-version.test.mjs
node scripts/verify-runtime-readiness.mjs
```

后一个命令仅为隔离研发核验，需已有PostgreSQL 16工具，Windows默认使用现有本机工具目录；Linux可通过`IDMS_PG_BIN`指向已有16工具并以非root账号运行。它建立自己的小型临时实例，不连接实际企业库，完成后保留验证JSON并清理自身实例和凭据，不应在生产维护流程中自动执行。

后续用户单独批准的[普通启动改造](existing-platform-startup-guide.md)已将本能力接入本机4010：实际维护资源契约和9项前端资源通过，原有满采集缓存使整体就绪503。该本机恢复不等于云端部署。持续监测/外部通知、支持责任、跨服务恢复、生产容量及真实岗位UAT、备案/TLS仍待各自完成；完整状态见[生产准备](production-readiness.md)。
