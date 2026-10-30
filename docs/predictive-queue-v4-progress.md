# 预测 SQL 队列基础进度

2026-10-20，原预测计划第 4 项的数据库协议基础已验证，整体产品接线仍未完成。新增独立 namespace、目录绑定、命令/授权用途密文、并发领取、30 秒租约与独立续租、原人授权 revision fence、未知接受关闭、原生 SDK 准备/完成原子提交、人工/授权等待、持久网络退避映射和外部发送边界。

最终当前证据为 `work/predictive-console-pg-v4-20261020/ea0654987fdf/verification.json`：12 组通过，57174 已 exit0。真实 PostgreSQL、实际规则 HTTP 和实际 Flowable；并发 claim 是同一验证宿主发起的两次独立 SQL 事务，不是产品独立 worker CLI。实际 prepare_console 写 COMMIT 成功后丢回复，原生回执恢复且 SQL COMMITTED 与业务同事务；旧授权写者、缺回执、各自单独的空状态/错 actor、过期 deadline 均回滚。真实主线程阻塞 32 秒，独立线程保住 30 秒租约；完整重构审计链有效。

发送开始边界持久化后，close 返回 recoveryRequired 并保留原命令/租约，取消被拒绝；真实 Flowable 确认后本地仅一个新工单。当前仅 SDK 尚未准备时可取消；SDK 已准备后的取消、异人 retry 控制、真实会话引用、QI/READER HTTP、独立产品 worker 和 UI 仍待开发，禁止直接将底层方法公开。

567/567 canonical 单元测试、server/predictor 类型和 268 构件检查通过，16 组历史只读保值检查通过。Git 分支 558/558，既有未发布 legacy-edge 九项不自动加入。新源仍是 WIP，未冻结，未做正式双份 outputs 归档。QA 输入快照和历史证据不能修改；改动后须新 nonce。

历史记录保留：33cfe3e73feb 因机器重启后原 PG 未启动，在首次连接前失败，无数据库/角色创建，恢复 PG 后精确前缀库存也为空。fb5274fb3637 的权限检查使用了 QI 无权解析的 schema 限定签名，夹具先于预期断言失败；改为 pg_catalog OID 查询。f5e92e234f03 的旧源 10 组通过；449166051ce2 增强源 12 组通过，随后再把空状态和错 actor 拆成两个独立负例，最终 ea0654987fdf 12 组通过。所有实际运行均已终态并清理，不能用早期证据替代最终输入。

本轮发现电脑于 20:15:46 重启，旧本机站点、身份和 AI 等进程已停止。通过新恢复记录 `work/runtime-resume-20261020-r1` 启动原物理 PG16 集群，未执行旧成功 startup 脚本、未初始化或修改原 schema/角色；原 system_identifier、两个业务数据库及 owner OID 匹配。此时原 4010 仍不监听，不能引用前轮 UP 作为当前站点可用性。下一步优先按原冻结 v2、闸门/备份/真实 Cua 会话验证恢复本机整站，随后继续预测产品接线。云端未操作，域名继续按备案前准备状态处理。
