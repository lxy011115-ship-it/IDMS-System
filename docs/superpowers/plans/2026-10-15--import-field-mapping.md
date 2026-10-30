# 企业上传字段映射实施计划

承接方案A、多类型设备数据管理优先与已有字段映射设计。按继续开发指令推进；不取消商用范围和production门禁。先复用既有治理，禁止任意脚本和静默值转换。

- [x] 服务端：映射schema、独立发布、原表头解析、租户/类型/来源绑定、批次冻结和审批/启动完整性校验，标准上传摘要不变。
- [x] 页面/API：模板中心映射草稿、上传选择与预览、批次映射证据、OpenAPI文件/JSON边界。
- [x] 验证：60项单元/40项构建；隔离OIDC/PostgreSQL/浏览器、退役幂等/并行版本、SQL失败回滚、损坏绑定阻断；标准上传、设备数据、维修与真实Flowable模板回归通过。
- [x] 本机：双企业加密备份后受控更新4010，实际OIDC页面/Flowable/AI/MQTT/OPC验证，升级后业务库隔离恢复通过；原acme6批/0工单和业务摘要不变，状态与指南已更新。

证据：outputs/import-mapping-verification.json、outputs/live-data-management-verification.json、outputs/live-backup-verification.json及其他live记录。实际平台保持运行；新模板和合成业务只存在于已清理的QA数据库，不向企业库发布演示映射。

仅在本次随机QA库创建合成数据和注入故障；不在企业库发布映射或造演示数据。工作目录不是Git仓库，不伪造提交记录。独立更正、细粒度数据范围、容量归档和全商用验收继续保留。
