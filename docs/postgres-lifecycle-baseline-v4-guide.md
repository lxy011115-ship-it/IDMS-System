# PostgreSQL 生命周期完整源码基线 V4

本轮 CI 接入核心故障验证，需要更新两份工作流定义。基线 V4 固定父提交 `c1ede87eaa42b882138a6937b8961ba2f728bf97` 的完整 656 个受管文件，并逐项声明两份 CI 文件的原摘要和新摘要，其余 654 个文件要求保持原字节。

`node scripts/prepare-postgres-lifecycle-baseline-v4.mjs` 核对固定父清单摘要、全部 656 项、唯一安全相对路径以及两项明确变更后，生成本次隔离验证输入。原 V1/V2/V3 基线和 PostgreSQL 生命周期生产模块保持原样。运行入口为 `scripts/verify-postgres-lifecycle-v4.mjs`，Windows 通过固定的 `verify-postgres-lifecycle-windows-v5.ps1` 创建受限进程。

Windows 已实际完成 13 项 PostgreSQL 原生检查，包括独立新集群、接管与伪造句柄拒绝、配置漂移/剩余客户端阻止停止、原请求复用、真实 smart stop 与新所有者重启；两次实际创建的 postmaster 均正常退出，独立检查确认干净离线。结果见 [Windows V4 记录](validation/postgres-lifecycle-windows-v4.json)。Linux 结论以同提交 CI 实际结果为准。

该基线验证完整声明的源码关系，不能替代核心组合运行、原数据库迁移、浏览器整站验收或公网启用。
