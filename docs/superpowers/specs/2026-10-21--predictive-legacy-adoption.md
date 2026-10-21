# 旧预测作业授权接管 B

延续读取迁移 A 和完整方案 A。接管必须由实际当前 OIDC/共享会话的原执行者提出，不能用历史 context 或用户名代替原 actorId。HTTP 保持 QI/READER，worker 保持 APP 和服务材料；原运行库与活动 owner 不变。

选择两阶段接管。QI 在新、明确的 fresh SQL 修订中接收原 command UUID、不可变候选摘要、接管 control UUID 和当前加密授权引用。接收时尚未完成宿主接管；旧创建计划保守标记 external_started，关闭接受不能冒充取消。相同 control UUID 重放不刷新授权、不替换原请求；已有普通 SQL 作业可由原人明确更新授权并提交接管请求，fence 旧 claim。关闭过的接受须显式 recoverClosedAcceptance 才允许恢复原命令。

新 worker 队列适配器在交给现有具体作业 worker 前取得实际 claim、独立续租，解密原命令及当前授权，再读取已完成迁移回执、NONE 对账记录、原 SDK 作业/计划/回执、设备范围。候选状态变化时保留旧作业并等待新的明确接管，不盲目重算计划。宿主、接管系统审计/回执和 SQL 状态同事务；SQL 再核原 SDK 哈希、计划摘要、原 actor/UUID/request、迁移绑定、当前租约及 deadline。

PENDING/WAITING_AUTH 由该次原人新授权进入 PENDING、增加 SDK grant revision，保留原计划/信封/尝试次数。HUMAN_REVIEW 保持人工状态，随后仍须独立 retry 和原人重授。COMMITTED 校验原生完成回执后只恢复宿主与 SQL 历史结果，不发外部请求。可证明没有外部创建边界的原生 CANCELLED 可恢复历史；若旧取消的 REVIEW 带创建信封而缺可靠边界，必须拒绝假定安全，留人工外部对账。

创建可能已在 Flowable 成功、但本地仍未完成的作业，用原 entity/command/requestDigest/actor 信封重放并发布一次本地结果，不换 UUID。授权失效、身份/范围变化、接受回复或实际提交回复丢失，均沿原控制编号、SQL claim 和原生回执恢复。接管不自动成为独立 retry，也不允许一个用户接管另一人的命令。

产品使用新私密 CLI/HTTP 包装和新队列适配器，旧 worker 文件保持字节；未安装扩展的旧配置拒绝新入口。QA 须真实 Keycloak、加密共享会话、独立 HTTP/worker/规则服务、真实 Flowable 及 SHA 固定旧 SDK 根。验证原 actor 与信封保留、外部已成功的恢复、终态无发送、等待授权与人工路径、权限/范围/CSRF/并发/提交丢回复及精确清理。浏览器接管控件与原统一站点受控接线另有实际 UI 验证，不冒充本阶段已完成；C workflow outbox 继续。
