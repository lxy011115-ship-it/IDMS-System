# R4 全库写入门接入

目标是把已实测的持久 SQL 门应用到真实 R4 部署拓扑，覆盖 StateMap/治理/维修/预测/对账队列、共享认证审计和两个 Flowable 库；两租户旧源库保留既有永久 ACL 围栏，身份库独立于业务集群。不得用只测两个模拟表来替代整站验证。

首轮真实集成说明旧源见证明确要求仅有 public schema，提前增加门 schema 会正确失败。旧源必须原样完成迁移/永久撤销 DML 后，使用未修改的旧 verifier 核对，再撤其大对象执行能力；不得修改旧 verifier 接受额外 schema，不得重定旧见证。注册表区分活动门与永久 ACL 退休源，实际库清单必须与两者并集完全一致。

旧 factory 和已接受 schema/source pins 保持。新增显式传入 provisioner 的 fresh factory 版本，所有 schema 在其旧 DDL 见证前安装额外 ALWAYS 守卫。初始化阶段由可信安装器核实际当前权威暂时开放；封存前停止自有工作流、逐库关闭、一次固定实际目录和角色绑定，开放后以原 SDK/真实工作流重启验证。安装器不向运行站点提供 SQL 控制秘密。

Flowable 第一次建表仍用新自有 APP；正常停机后把实际对象和 DB/schema 转给已有 NOLOGIN owner，撤 APP CREATE/所有权，只授权已有普通表 DML。取消/预留 schema 同样加守卫且先于其第一次外部 catalog 绑定。不允许给 APP 序列写权限来绕过表门。第二轮实际暴露旧启动总执行 CREATE TABLE 的问题，因此新增显式 BOOTSTRAP/RUNTIME 模式；RUNTIME 禁止建表、schema update 和流程自动部署，并核已有 BPMN 字节。构建在新目录覆盖选定控制器副本，原源码/JAR不变。

登记以实际 system ID、库 OID、owner/control、运行角色 OID和逐表 catalog 为准，无7库27角色常量。未覆盖表、未知角色能力/表所有权和旧见证漂移拒绝。正式维护需要镜像外持久意图/CAS/互斥和重入，按确定 operation ID 重试每库关闭；实际原站接入和完整冷恢复准入仍必须继续。

验证须包括两租户真实 R4 加载、共享认证写入、队列实际 claim/提交、Flowable 正常重启及业务写入，关闭后旧 SDK/认证/队列/APP 直写拒绝，读保留，实际 catalog 封存不重定。全局维护和恢复不能仅凭布尔参数宣布生产完成。
