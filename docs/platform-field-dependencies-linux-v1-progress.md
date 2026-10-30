# 平台现场依赖：Linux 实际验证补充

应用代码提交 `a3e505308b3179750d355f00eb3a4788bcdbe2b7` 的 [GitHub Actions 任务](https://github.com/lxy011115-ship-it/IDMS-System/actions/runs/40083723899) 已成功结束。确切 job 为 `120842297470`，本次原生 nonce 为 `fa31a69b621c`。这是对原 Windows 进度记录的后续补充；没有把 Windows 结果当成 Linux 执行结果。

- 34 项测试全部通过，无失败、取消或跳过；类型检查、冻结输入认证和运行后源码不变检查通过。
- 原生实际完成 31 项检查，固定输入 1,229 份，清理错误为 0。
- 独立 V4 核验两代控制器，每代 8 个声明资源、9 个实际应用子进程；覆盖逆序退役、被 SQL 连接阻止后的同请求重试、启动取消和无关 broker 隔离。
- 最终当前根核验 89 份证明、12 个存储点及全部 12 个点的签名 ACK 覆盖；历史归档与有限环共验证 13 次签名，最终环保留 3 行，SQLite 状态 MAC 正确。
- 三个 PostgreSQL 目录干净离线，6 次工作流服务正常停止。两代 SITE host 分别退役 220 和 24 条连接，owner 各退役 1 条连接。Linux 的 Windows 受限令牌证据字段为 `null`。

机器可读证据见 [Linux 验证摘要](validation/platform-field-dependencies-linux-v1.json)。摘要只保存确切任务输出的白名单字段；没有保存凭据或原始任务日志。

此结果证明本次自有受控依赖图和数据流的验证范围。现场正式恢复的独立人工批准、旧数据与签名键迁移、治理 V6 后台过渡、授权页面及预测消费、完整系统验收仍待完成。`formalFieldActivationGranted`、`allProductionDependenciesRegistered` 和 `fullGoalComplete` 均为 `false`。未备案域名仍仅做服务器部署准备，最终中文 DOCX/PDF、真实截图和旁白字幕 MP4 尚未交付。
