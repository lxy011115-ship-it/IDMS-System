# 平台现场依赖的实际句柄接线

延续完整方案 A 和已实际核验的 V3 应用管理器，接入真实 broker 与 edge。配置显式 field.enabled；disabled 不读额外现场材料、不创建 broker/edge。enabled 必须完整声明 broker 与 edge 槽位，精确绑定唯一 SITE、企业、edgeId、broker ACL、地址、证书、配置和注册候选；保留原 workflow/predictor 全部核验。材料验证仅证明对应关系，不把候选 activationGranted=false 变成批准。

启动依次 PG→identity/workflows/predictor→broker→applications/SITE→edge。每次实际创建后立即保存真实句柄，再等 bind。停止依次 edge→applications（实际 SITE 资源退役）→broker→其余服务→PG。启动取消只能提前取消当前尚无下游的应用或 predictor；已有 edge 时禁止先停 SITE。每次 stop 固定原 requestId；失败或观察超时不采用外来 PID，不重新启动，不使用通用 kill。未证明某层退役即停止继续向下关闭，保留重试同请求所需的实际句柄和检查能力。

V3 应用停止与异常退役均须同时核 allOwnedTerminalProven、allOwnedResourcesRetired。broker 用 V4 原始 native 句柄证明，edge 用 V3 启动 challenge/material MAC/实际 close 和本地排空证明。外部原实例和未持有的资源不得纳入。配置/材料持续检查失败会进入同一受控排空路径。

process READY 表示已声明依赖实际就绪，不表示现场恢复/激活已获独立人工批准。当前根正式恢复批准、历史数据/签名键迁移、治理 V6 迁移和生产启动门禁仍须完成；本阶段接口保留 formalFieldActivationGranted=false，不能据此上线。验证须使用实际全局身份/冷恢复及真实 broker/edge，另测 disabled、错配置在进程前拒绝、启动取消、关闭期间下游先退役、same-request、无关实例隔离和 BLOCKED 重试。
