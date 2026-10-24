# 平台现场依赖执行计划

1. V3 strict 配置及真实文件检查：复用 V2 纯配置，保留 workflow/predictor 检查，接 V2 application manifest，核 SITE switch，再核所有 broker/edge 材料和完整通道覆盖。
2. 材料检查持有私有随机 HMAC 密钥，反复核真实材料；仅内部 opaque fingerprint，检查完立即清除加载的密钥，不导出原始密钥散列。
3. V7 controller 接 V3 application lifecycle、V4 broker、V3 edge 的真实句柄；按依赖拓扑启动/关闭，修正旧 earlyStop apps 在有 edge 时违反顺序的问题。
4. 明确普通终态、正常停止、未证资源退役及可重试 BLOCKED；保持同请求、原始句柄和 PG 关闭门禁。
5. 定向边界测试及实际全栈原生验证后再发布；正式激活/历史迁移/全部系统验收仍独立待完成。
