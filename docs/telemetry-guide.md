# IDMS 只读设备采集：开发使用与验收说明

2026-10-16新增[采集数据质量工作台](telemetry-quality-guide.md)：独立只读快照、当前批准定义/冻结规则、完整窗口、源级拒收和历史标签。当前来源仍为只读模拟器，现场接入未验收。

更新：2026-10-15。本批完成本机真实 OPC UA/MQTT 协议链路，不是企业现场或完整商用验收。

## 启动与账户

运行`启动IDMS.cmd`或`npm run platform:start`。网站：<http://127.0.0.1:4010/?view=telemetry>。全部服务仅监听127.0.0.1，不是公网地址。

模拟设备`SIM-CNC-01`仅属于sandbox。`sandbox.auditor`查看，`sandbox.uploader`运行分析，`sandbox.approver`及`sandbox.technician`分别终审和维修。真实账户切换需退出再登录，不能通过请求头覆盖企业。

临时密码仅在受限文件`.local/本机登录账户.txt`，首次改密。不分享或打包`.local`、缓存及客户数据。现有acme六批上传和业务不变，没有为其创建模拟遥测表。文件演示启动默认不启用采集。

## 链路与数据保障

```text
OPC UA只读模拟器:4841 → 边缘读取Value/源时间/质量
→ SQLite WAL同步持久化 → MQTT QoS1:1884（账号、精确主题ACL、HMAC）
→ 租户PostgreSQL事务：测点＋接收凭证＋审计
→ 平台签名STORED确认 → 边缘核对事件/租户/摘要并清理待传缓存
```

MQTT PUBACK不是入库确认。平台/代理离线、SQL失败时缓存保留并重试。默认10000条容量；满后不驱逐旧数据，报告缺口/背压，不能承诺无限断网零丢失。REJECTED记录保留并占容量；拒收修复、归档和重放工具待实现。确认历史也需后续保留期治理。

默认每10秒读取振动RMS、轴承温度、电流波动三个测点。当前是只读轮询，不是OPC订阅；无Write、Call、PLC控制和指令主题。模拟器节点不可写。

按源时间处理乱序/迟到；相同事件重试不重复测点和审计。事件ID、序号或同测点同时间内容冲突隔离。BAD/UNCERTAIN保留，不能作为正常分析样本。采样时间、接收时间、映射版本、源身份及摘要保留。

## 页面与分析

设备采集页每5秒刷新，显示MQTT订阅、OPC连接、采样/接收时间、新鲜度、缓存、拒收、缺口和测点血缘。连接正常不代表数据新鲜。

“分析已入库采集窗口”调用独立预测服务：三个标签各≥6条GOOD、窗口5分钟至24小时、缺口≤5分钟、窗口对齐。启动后至少积累5分钟。最新质量坏、过期或时钟超前时转人工，不复用旧健康结论。

结果标识SIMULATED_TELEMETRY，保留边缘ID、测点ID、输入摘要、模型和时间窗口。按最新连续GOOD窗口分析，遇到大于5分钟的历史缺口停止向前取样；早期补传不会污染当前窗口，不足窗口仍失败关闭。当前是固定三个标签的均值工程规则，阈值未经厂商/现场验证，置信度/故障概率/RUL不伪造。

异常仍需人工批准创建工单，维修、复测和独立人工关单。新异常窗口不重复创建活动维修事件，不改写原审批证据。自动分析调度、迟滞/持续性和活动风险升级尚待完善。

## API与安全

GET接口需要read，分析需要analyze；租户来自OIDC。写请求需Idempotency-Key、X-Correlation-Id；浏览器另需同源和CSRF。机器身份不能终审。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v1/telemetry/overview` | 当前企业源、统计、边缘状态；无密钥 |
| GET | `/api/v1/telemetry/points?edgeId=...&limit=100` | 按源时间倒序，最多200条 |
| GET | `/api/v1/telemetry/rejections?edgeId=...` | 最新100条拒收摘要 |
| POST | `/api/v1/telemetry/analyze` | JSON `{"edgeId":"sandbox-edge"}` |

MQTT主题为`idms/v1/{tenant}/{edge}/telemetry`及`/ack`。服务端登记和HMAC决定源身份，不信载荷自报企业。边缘只写自己的遥测、只读自己的确认。静态ACL可能接受订阅过滤器，但拒绝无授权消息交付；测试用第二租户真实发布方验证交付隔离，不以SUBACK成功等同读权限。

现场来源目前拒绝启用；None仅用于本机模拟器。远程MQTT必须TLS；现场OPC证书、信任和点表审批待建设，不能将模拟器改名冒充现场设备。

## 安装记录

Mosquitto2.1.2便携程序位于`%LOCALAPPDATA%/IDMS/runtime/mosquitto-2.1.2`，不是EMQX。源：`https://mosquitto.org/files/binary/win64/mosquitto-2.1.2-install-windows-x64.exe`。

下载SHA256：`58008ad7a22ada0b4073afa415801746e027c5f583e4fa52d0f4e9193b98d6aa`。归档未签名，摘要仅为下载记录，不等于发行方签名。用已核对发行摘要的7-Zip提取文件，未运行会改Windows服务/注册表的安装器；无全局PATH、开机或系统服务修改。复现：`scripts/install-runtime.ps1 -Component mqtt`。

SQLite用Node24内置模块。SDK版本见package-lock。密钥和代理密码文件受本机ACL保护，不通过进程参数或日志打印。

## 验证与未完成项

`npm run telemetry:verify`在唯一QA库/端口实际启动代理、模拟器、边缘、预测和核心，验证只读、缓存重启、核心/代理离线补传、ACL、签名确认、去重/冲突、乱序/低质量、SQL故障完整回滚、审计重启、采集分析到独立关单、桌面/手机。只清理本次QA数据库，私密测试缓存保留`.local`供排查。

证据：`outputs/telemetry-verification.json`；实际4010/OIDC：`outputs/live-telemetry-verification.json`。截图17/18为QA，19/20为实际网站沙箱。原上传/维修/数据库/预测/OIDC回归通过，原acme6批业务摘要未变。

未完成：现场证书/点表、生产TLS/mTLS/轮换、OPC订阅、Modbus/S7、边缘升级/高可用、缓存运维、容量长期测试、TimescaleDB。遥测已规范化，但业务/审计快照仍有增长和单实例限制，不适合高频大规模生产。Flowable、真实AI网关、模板/插件治理、商业授权、生产安全/灾备和企业试点继续按原目标建设。
