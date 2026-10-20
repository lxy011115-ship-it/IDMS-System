# IDMS 手动上传演示指南

本指南下文保留早期文件Demo讲解；完整平台已接通真实身份、企业PostgreSQL、Flowable和本地AI SHADOW抽样审核，仍非生产验收。最新多设备数据管理及七类上传请先读 `data-management-guide.md`；旧演示包不代表当前版本，不能分享本机凭据或企业业务快照。

## 启动

2026-10-15交付提醒：旧 `IDMS手动上传演示包.zip` 含本机上传快照和内嵌原文件，尚未证明全部可公开，已停止分发并完整保留于受限`.local/quarantine/`；新版对外包尚未完成发布验收，不要恢复旧包分享。详情见`release-supply-chain-review-2026-10-15.md`。

本机已有工作目录可安装Node.js 24 LTS后双击 `启动演示.cmd`，保持终端窗口运行，浏览器访问 http://127.0.0.1:4010/ 。该命令只启动文件Demo；完整OIDC/PostgreSQL平台使用`启动IDMS.cmd`，当前平台已运行时不要重复启动。若依赖缺失，演示启动脚本会执行 `npm ci --omit=dev`，需要访问npm仓库。停止自己启动的服务时在对应窗口按Ctrl+C，不要终止其他运行实例。

已有项目可执行 `npm start`。首次生成样例运行 `npm run demo:fixtures`；服务运行后执行 `node scripts/seed-upload-demo.mjs`，仅在没有上传批次时预置演示，不会覆盖已有数据。

示例目录：`outputs/demo-data/`，含5类CSV、5类XLSX与1个生产错误样例。CSV的机器字段与方案一致；XLSX只有一个名为 `data` 的工作表，无公式，日期为含时区文本。演示范围为 `FACTORY-01 / LINE-01`，不能将其他工厂数据混入。

## 已预置场景

| 场景 | 初始状态 | 演示重点 |
| --- | --- | --- |
| 设备 / 生产 / 状态 | 已批准入库 | 产量1000、良品率98%、停机60分钟、OEE约68.06% |
| 维修 | 待人工复核 | 模型不可用不自动通过，需复核依据和最终批准 |
| 质量 | 待人工终审 | 批准后进入检验样本；单个样本不计算Cpk，不自动放行 |
| 生产错误文件 | 校验失败 | 良品数超过总数，逐行错误及清单下载 |

预置内容都是虚构演示数据。顶部和页面内持续说明“AI规则模拟”“本机演示存储”。

## 8分钟讲解脚本

1. **上传中心（1分钟）**：说明五类模板、CSV/Excel上传、API接入。展开错误批次，展示行号、字段错误及原文件下载。
2. **真实数据指标（1分钟）**：切到“生产与质量分析”，展示A=75%、P≈92.59%、Q=98%、OEE≈68.06%。解释只有批准数据计入统计、手动数据不表示实时在线。
3. **人工兜底（2分钟）**：打开维修待复核批次，展示模型未连接状态。顶部切换“业务终审员”，填写审批意见和复核依据，批准入库；平均维修时间变为50分钟。
4. **质量审批（1分钟）**：批准质量批次，分析页新增1个检验样本。说明检验事实入库不等于质量放行，Cp/Cpk需要足量稳定样本。
5. **全链追溯（1分钟）**：进入“批次追溯”，展示上传身份、规则版本、模型/规则标识、快照、审批意见和入库事件；普通页面不允许覆盖原文件。
6. **企业扩展（2分钟）**：角色页说明上传与终审分工；集成页显示文件/JSON接口、Keycloak、PostgreSQL、Flowable及MQTT/OPC UA的实际运行状态。完整平台已有这些开发集成；单独文件Demo不代表已连接全部服务。真实AI、TimescaleDB和现场/生产验收仍未完成。

若要从空白体验：在“演示使用说明”点击重置，确认后清除当前acme演示上传、统计和审计；随后按“设备→生产→状态”顺序上传，每类用另一名角色批准。重置会删除本机演示记录，如需保留先复制 `.demo-data/local/imports.json`；可停止服务后恢复该文件。

## 操作与文件说明

- 右上角角色选择器仅用于演示：上传专员可上传，终审员可批准，审计员只读。真实生产不能信任客户端身份请求头。
- “模拟AI”使用确定性规则输出和演示置信度；“真实模型未连接”会转人工。疑似指令注入材料同样转人工，不执行文本中的指令。
- 有任何错误整批不得批准。重复来源记录ID且内容相同跳过；相同ID不同内容拒绝覆盖。历史更正、自动映射、Webhook等仍按方案规划，Demo未实现。
- 上传批次、原始输入base64、正式记录、请求幂等记录及审计保存在 `.demo-data/local/imports.json`；采用串行提交、临时文件写入和重命名。它是本机演示快照，不代替数据库事务、备份或生产对象存储。
- 本机4010服务只绑定127.0.0.1，不会部署到公网。向客户发送ZIP可在客户机器独立运行。
- 生产API使用相同路径，但需要经验证的身份、数据范围、独立数据库、分布式幂等和对象存储。上传类型与审批门的设计可复用。

## 演示接口示例

创建业务批次：`POST /api/v1/data-imports/records`。演示请求头：`X-Tenant-Id: acme`、`X-Actor-Id: demo.connector`、`X-Actor-Type: INTERFACE`、`Idempotency-Key: 唯一字符串`、`X-Correlation-Id: UUID`。

```json
{
  "dataType": "QUALITY",
  "templateVersion": "1.0.0",
  "sourceSystem": "erp-demo",
  "records": [{
    "source_record_id": "quality-api-001",
    "device_code": "D-001",
    "batch_code": "BATCH-002",
    "characteristic_code": "DIAMETER",
    "measured_at": "2026-10-13T10:00:00+08:00",
    "sample_no": 1,
    "measured_value": 10.01,
    "unit": "mm",
    "lsl": 9.95,
    "usl": 10.05
  }]
}
```

202表示批次受理，继续GET `/api/v1/data-imports/{batchId}`查询；接口账号不能批准。上传后在页面切换终审员处理。文件API为 `POST /api/v1/data-imports`（multipart，字段file/dataType/templateVersion/sourceSystem），演示额外支持 `aiMode=demo|unavailable`。

## 验证

`npm test`覆盖领域与审批不变量；`npm run demo:verify`使用Chrome进行桌面/手机浏览器验证、Excel/CSV/JSON链路、错误提示、幂等冲突、租户隔离和重启恢复。该命令需安装开发依赖及本机Chrome，在4022端口及独立QA存储运行，不覆盖正常演示数据。

页面截图位于 `outputs/demo-preview/`；自动测试脚本位于 `scripts/verify-upload-demo.mjs`。`npm run build`是运行文件完整性检查，不代表生产编译或性能验收。
