# R4 全库写入门接入进展

最终隔离运行 `0bf838ae69de` 通过 9 项真实集成检查，302 个直接/静态依赖及选定构建输入指纹与验证版本一致，验证后这些执行源码没有补丁。此前已通过的单库持久门不代替本轮整站检查。

实际业务集群有 7 个数据库：5 个活动写入门覆盖 157 张普通表、12 个运行角色；另外 2 个迁移旧源保留既有永久表/列/序列/public 函数撤权，并额外禁止大对象操作。数据库总清单与两类登记的并集完全一致，安装逻辑没有写死 7 库/27 角色。身份服务使用另一个独立 PostgreSQL 集群。

新增工作流 BOOTSTRAP/RUNTIME 构建与生命周期配置。自有 Flowable 正常停机后将 APP 所有的数据库/schema/对象移交给 NOLOGIN owner；APP 不再拥有表或 CREATE 能力。RUNTIME 不建表、不升级 schema、不自动部署流程，核已有 BPMN 字节。最终选定 JAR 为 `0d8a123a1d7f6a212e7e03bfa3f3c23b94737c7b2ef312aba2a8004b40ab3750`，13 个构建输入固定，原运行 JAR 保持。

真实共享会话返回四模块 context200；实际预测 worker 完成分析和另一身份的批准，经 StateMap 与任务队列提交，并创建真实 Flowable 流程。随后真实取消原任务，HTTP 对账 OPEN 返回202，对账 worker 提交成功。两租户均完成初始化和封存，但本轮普通任务/对账提交的正例在 sandbox；不能宣称全部模块/租户的业务动作已穷尽验收。

SQLite WAL/FULL 控制库在 PGDATA 外提交 DRAINING 意图、固定每库 operation ID。实际控制子进程在第一个 SQL 门提交 CLOSED 后 exit77，另外四门仍 OPEN，控制库保留 revision1/DRAINING。新进程续接原编号关闭全部活动门，最终 revision2/CLOSED；重复关闭回执逐字相同、不增加 revision，冲突操作被拒。此处真实故障是 SQL 提交后的进程退出，不代表所有网络 ACK 丢失、控制库故障或跨主机互斥已验证。

关闭后，两租户未修改 SDK 写入、共享认证 APP 和两个 Flowable APP 的直接写入均得到 CLOSED 拒绝，SDK 读保留。两个旧源 APP 的 DML/大对象操作仍因原永久权限围栏拒绝。

历史失败保留：第一轮 `714352fe0c51` 在原 source schema 严格见证处拒绝提前装门；第二轮 `c36abb446af4` 暴露旧工作流启动执行 CREATE TABLE，受限角色正确拒绝并自退；第三轮 `8ec183edbf33` 已完成整站封存/真实审批，但测试 POST 漏 Origin 得403，补正常请求头后从全新环境完整重跑。另首个隔离构建因替换边界不唯一而在 Maven 前拒绝，修正明确 Account 记录边界后编译成功。没有放宽旧见证、APP 权限或请求来源校验。

四轮业务/身份集群均正常关闭，私密证据离线保留；活动数据库数据目录移除。最终三个 Flowable JVM 与一个身份 JVM 均正常 exit0/signal=null，两个 Node 服务退出。第二轮一个工作流因拒绝启动 exit1，不能统计为正常停机。只读清理核验发现旧 PID44788 被后续新进程复用，已核新创建时间晚于旧退出且 owner/JAR 绑定不同，没有操作该复用进程。

本阶段尚未将新持久控制接入完整 PGDATA 捕获/恢复准入，也没有替换旧 `owned-cold-fence-v1-qa.mjs` 布尔准入路径。全局入口维护门、所有后台退休/角色 LOGIN 围栏、JWT verifier 宽限与实际 lease expiry、恢复后启动的准入、原 legacy owner 接管和原站切换继续。跨库 CLOSED 回执不是生产恢复上线许可。

原站仍 ACTIVE，原 Keycloak/Flowable/原 JAR、阿里云、DNS/TLS/代理/安全组保持。idms.xin 未备案，仍仅部署准备。最终中文 PDF+可编辑 DOCX 真实图文、中文讲解字幕 MP4 尚未交付，完整方案 A 目标继续。
