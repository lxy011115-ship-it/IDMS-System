# 实施顺序

1. 核实际分发和Quarkus版本，保留原运行状态；建立独立Java wire/Attach/agent工具，不修改Spring适配。
2. owner-only复制不可变分发，拒绝原data/config与环境注入，固定私有config和完整清单。
3. 受管新JVM启动、readiness后绑定、排他停止意图/回执、退出观察；失败保持实际句柄，不因超时重新启动或强杀。
4. 独立PG/新realm真实集成：权限负例、内部agent guard、回执冲突、重复调用；实际关闭/SQL归零/重启UUID+refresh延续。
5. 核清理、源码pins/秘密扫描与原环境不变；发布新源和验证摘要，记录未完成整库迁移与生产边界。
