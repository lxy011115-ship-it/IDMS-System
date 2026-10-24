# 现场应用管理器 V3：本机真实整链已核验

本记录为 2026-10-24 最新进展，覆盖较早使用指南中“启用现场原生验证待做”的阶段描述。完整系统目标继续开发；正式平台 broker/edge 槽位、现场恢复/激活批准和最终用户资料尚未完成。

Windows 原始监督进程持有本次新建的 native 进程，认证终态实际 code=0/signal=null；1207 份源码固定不变，25 项完整检查通过。29 项共同边界测试通过。新管理器实际启动两企业九成员组，SITE 的 CREATED→START_AUTHORIZED→READY 顺序和同一监听端口的真实 OIDC 四模块上下文通过。

真实 edge 通过 mTLS MQTT 补传上一场景未提交的数据，当前根中共 9 个存储点，旧回执 auditEventId 保持。用真实 SQL SHARE 锁阻塞现场 owner 的写入后，以同一 requestId 先停止 edge，再停止 SITE；SITE 确认排空后仍等待 SQL，后台成员没有提前收到 STOP。解除锁后事务回滚，未提交点/收据均不存在，SITE 退役记录完成后八个后台成员才正常停止。独立核验检查了 72 份当前根成员/不存在证明、186 个 host SQL 连接和 1 个接收 owner 连接退役、全部子进程结果、SQLite MAC、三处 PG 目录干净离线和四个 workflow 正常停止。

首次独立 verifier V3 实际失败，原因是错误要求容量为 3 的本地 ACK 环保留全部 9 条历史 ACK；`services/field/spool.ts` 明确按容量裁剪 ACK。原 verifier V3 与其失败记录保留，native 不重跑、生产源不修改。独立 verifier V4 对此前保存的 7 份 ACK 签名及本地最新 3 份 ACK 逐份验签，要求它们对当前 9 个点完整覆盖，同时核对每个 auditEventId 和本地状态 MAC。V4 实际通过。签名份数和去重后的点覆盖数分别记账，不能混称本地保留 9 条 ACK。

现场专用恢复 ACTIVE control 仍是明确 QA 材料，formalFieldActivationGranted=false。真实 broker 和 edge 目前由 QA 各自持有；它们没有完成正式 dependency controller 的资源登记。治理后台仍为 V4，不能据此宣布 V6 切换。后续继续当前根正式恢复/激活双人审批、旧 SQL 数据/签名键迁移、平台依赖接线、授权 HTTP/设备页/预测消费、全系统验收，以及同版本中文 DOCX/PDF、真实截图和实际旁白字幕 MP4。未备案 idms.xin 保持仅部署准备，不做公网切换。

Linux 工作流已配置相同 29 项测试、25 项原生链路和独立 V4 核验；本记录写入时尚未执行。Windows 白名单证据见 docs/validation/field-application-manager-windows-v3.json。
