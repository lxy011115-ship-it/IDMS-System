# PostgreSQL 原生验证的源码基线 V3

旧基线明确绑定 `bc0d65d` 的 596 个文件。登记库并发修复改变了其中一个源码文件，因此旧门禁在启动数据库前拒绝继续；该拒绝和旧基线保留。没有将修复后的文件伪称为原父提交的相同内容。

V3 保留 `b1a351b` 的完整 640 条父文件清单，并声明两份 CI 定义的旧、新摘要。当前验证覆盖全部 640 条：638 条保持父提交内容，两条按显式批准摘要更新。准备器校验固定父清单摘要和固定变更清单，不接受任意追加差异；数据库生命周期实现保持。

Windows 案例 `842925b461bc` 实际完成 13 项原生检查及独立清理，均退出 0。两个本次创建的 postmaster 正常 smart stop、数据重启保持、客户端阻止停库、配置漂移拒绝、PID 注入/克隆句柄/硬链接/配置钩子阻断均通过。原数据库和端口不参与测试。此结论只覆盖该原生 PG 案例及已声明的源码输入。

准备入口为 `node scripts/prepare-postgres-lifecycle-baseline-v3.mjs`；Windows 固定验证入口为 `powershell -NoProfile -File scripts/verify-postgres-lifecycle-windows-v4.ps1`，只运行固定 QA。Linux 工作流运行 `node scripts/verify-postgres-lifecycle-v3.mjs`，并调用对应 V3 独立检查器。Linux 结果需实际取得，不由 Windows 成功推定。
